import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { LocalStorage, createLogger, createPools, loadEnv, requestImportCommit, runCommit, runValidate, type ImportDeps, type TenantContext } from '@pos/core';
import { todayInTehran } from '@pos/shared';
import { stringArg } from './_args';

/**
 * بنچ ایمپورت: فایل CSV تراکنش تجمعی با N ردیف (ترمینال × چند تاریخ) برای ماهی که در seed نیست.
 *   npm run bench:import -- --office=seed-large --rows=1000000
 * هدف: validate + commit کمتر از ۲ دقیقه. بعد از اجرا، داده‌ی بنچ پاک می‌شود (مگر --keep).
 */
const code = stringArg('office') ?? 'seed-large';
const rows = Number(stringArg('rows') ?? 1_000_000);
const keep = process.argv.includes('--keep');
const env = loadEnv();
const logger = createLogger(env, 'bench');
const pools = createPools(env, logger, 'pos-bench');
const pool = pools.write;
const t0 = performance.now();
const sec = (): string => ((performance.now() - t0) / 1000).toFixed(1);

try {
  const office = (await pool.query<{ id: number }>('SELECT id FROM offices WHERE code = $1', [code])).rows[0];
  if (!office) throw new Error(`office "${code}" not found`);
  const ctx: TenantContext = { userId: 0, officeId: office.id, role: 'office_manager', unitId: null, supporterId: null };
  const terminals = (await pool.query<{ terminal_no: string }>('SELECT terminal_no FROM terminals WHERE office_id = $1 ORDER BY id', [office.id])).rows;
  if (terminals.length === 0) throw new Error('no terminals');

  // ماهی قدیمی‌تر از همه‌ی داده‌های seed (تا با رکوردهای موجود تداخل یکنوایی نداشته باشد)
  const month = (await pool.query<{ period_id: number; sd: string; days: number }>(
    `SELECT p.period_id, p.start_date::text AS sd, (p.end_date - p.start_date)::int AS days FROM periods p
      WHERE p.end_date <= (SELECT min(as_of_date) FROM transactions_snapshot WHERE office_id = $1)
      ORDER BY p.period_id DESC LIMIT 1`, [office.id])).rows[0];
  if (!month) throw new Error('no free older month found');
  const perTerminal = Math.max(1, Math.ceil(rows / terminals.length));
  const dayStep = Math.max(1, Math.floor((month.days - 1) / perTerminal));

  const dir = mkdtempSync(path.join(os.tmpdir(), 'pos-bench-'));
  const file = path.join(dir, 'bench.csv');
  const out = createWriteStream(file);
  out.write('شماره ترمینال,مبلغ,تعداد,تاریخ\n');
  let written = 0;
  const start = Date.parse(`${month.sd}T00:00:00Z`);
  for (let k = 1; k <= perTerminal && written < rows; k += 1) {
    const date = new Date(start + (k * dayStep - 1) * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < terminals.length && written < rows; i += 1) {
      const amount = (((i * 7919) % 1000) + 100) * 50_000 * k;
      if (!out.write(`${terminals[i]!.terminal_no},${amount},${k * 3},${date}\n`)) await once(out, 'drain');
      written += 1;
    }
  }
  out.end();
  await once(out, 'finish');
  console.log(`[${sec()}s] CSV: ${written} rows → ${file}`);

  const storage = new LocalStorage(dir);
  const key = `bench/${randomUUID()}.csv`;
  await storage.put(key, createReadStream(file));
  const batchId = (await pool.query<{ id: number }>(
    `INSERT INTO import_batches (office_id, type, status, file_name, file_size, file_hash, file_kind, storage_key, options, created_by)
     VALUES ($1,'transactions_cumulative','uploaded','bench.csv',1,$2,'csv',$3,$4::jsonb,0) RETURNING id`,
    [office.id, createHash('sha256').update(key).digest('hex'), key,
     JSON.stringify({ headerRow: 1, calendar: 'gregorian', source: 'daily', columnMap: { terminal_no: 'شماره ترمینال', amount: 'مبلغ', tx_count: 'تعداد', as_of_date: 'تاریخ' } })])).rows[0]!.id;

  const deps: ImportDeps = { pool, storage, logger, stagingSchema: 'staging', maxRows: rows + 10, vacuumThreshold: 1_000_000_000, today: todayInTehran };
  const tv = performance.now();
  await runValidate(deps, batchId);
  const validateSec = (performance.now() - tv) / 1000;
  const v = (await pool.query('SELECT status, total_rows, error_rows, valid_rows FROM import_batches WHERE id = $1', [batchId])).rows[0];
  console.log(`[${sec()}s] validate: ${validateSec.toFixed(1)}s`, v);

  const tc = performance.now();
  await requestImportCommit(ctx, pool, batchId, 'skip_invalid');
  await runCommit(deps, batchId);
  const commitSec = (performance.now() - tc) / 1000;
  const c = (await pool.query('SELECT status, inserted_rows, updated_rows, unchanged_rows FROM import_batches WHERE id = $1', [batchId])).rows[0];
  const total = validateSec + commitSec;
  console.log(`[${sec()}s] commit: ${commitSec.toFixed(1)}s`, c);
  console.log(`\nجمع validate + commit برای ${written} ردیف: ${total.toFixed(1)}s  (هدف: زیر ۱۲۰s)  ${total < 120 ? '✅' : '❌'}`);

  if (!keep) {
    await pool.query('DELETE FROM transactions_snapshot WHERE office_id = $1 AND import_batch_id = $2', [office.id, batchId]);
    await pool.query('DELETE FROM import_batches WHERE id = $1', [batchId]);
    console.log('داده‌ی بنچ پاک شد (برای نگه‌داشتن: --keep)');
  }
  process.exitCode = total < 120 ? 0 : 2;
} catch (err) {
  logger.error({ err }, 'bench failed');
  process.exitCode = 1;
} finally {
  await pools.close();
}
