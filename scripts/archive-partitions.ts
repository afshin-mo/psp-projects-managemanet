import { execFile } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { periodIdOfDate, shiftPeriod } from '@pos/shared';
import { createLogger, createPools, loadEnv } from '@pos/core';
import { stringArg } from './_args';

const run = promisify(execFile);

/**
 * آرشیو پارتیشن‌های قدیمی:  transactions_snapshot (به‌ازای ماه شمسی) و audit_log (به‌ازای ماه میلادی).
 *
 *   npm run db:archive                                  # پیش‌نمایش (چیزی تغییر نمی‌کند)
 *   npm run db:archive -- --execute                     # dump (pg_dump) ← جدا کردن (DETACH) پارتیشن
 *   npm run db:archive -- --execute --drop              # بعد از dump موفق، جدول جداشده را هم حذف می‌کند
 *   گزینه‌ها: --keep-months=36 (snapshot)  --audit-keep-months=24  --dir=./archive
 *
 * هشدار: بعد از جدا شدن پارتیشن snapshot، «بازسازی کامل آمار» (rebuild) برای همان ماه‌ها ممکن نیست؛
 * جدول‌های fact/agg دست‌نخورده می‌مانند و داشبورد کار می‌کند. حتماً فایل dump را جای امن نگه دارید.
 * pg_dump باید در PATH باشد (همراه نصب PostgreSQL).
 */
const execute = process.argv.includes('--execute');
const drop = process.argv.includes('--drop');
const keepMonths = Number(stringArg('keep-months') ?? 36);
const auditKeep = Number(stringArg('audit-keep-months') ?? 24);
const dir = path.resolve(stringArg('dir') ?? './archive');
if (![keepMonths, auditKeep].every((n) => Number.isInteger(n) && n >= 3)) throw new Error('keep-months باید عدد صحیح ≥ ۳ باشد');

const env = loadEnv();
const logger = createLogger(env, 'archive');
const pools = createPools(env, logger, 'pos-archive');

interface Part { parent: 'transactions_snapshot' | 'audit_log'; schema: string; name: string; rows: number }

try {
  const cutoffPeriod = shiftPeriod(periodIdOfDate(new Date().toISOString().slice(0, 10)), -keepMonths);
  const d = new Date();
  const auditCutoff = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - auditKeep, 1)).toISOString().slice(0, 7).replace('-', '_');

  const r = await pools.write.query<{ parent: Part['parent']; schema: string; name: string; rows: string }>(
    `SELECT p.relname AS parent, n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS rows
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname IN ('transactions_snapshot','audit_log') AND n.nspname = current_schema()
      ORDER BY c.relname`);

  const old: Part[] = r.rows.flatMap((x): Part[] => {
    const m = x.parent === 'transactions_snapshot' ? /^transactions_snapshot_(\d{6})$/.exec(x.name) : /^audit_log_(\d{4}_\d{2})$/.exec(x.name);
    if (!m?.[1]) return [];
    const isOld = x.parent === 'transactions_snapshot' ? Number(m[1]) < cutoffPeriod : m[1] < auditCutoff;
    return isOld ? [{ parent: x.parent, schema: x.schema, name: x.name, rows: Number(x.rows) }] : [];
  });

  logger.info({ cutoffPeriod, auditCutoff, partitions: old.length, execute, drop }, execute ? 'archiving' : 'dry-run (no changes)');
  for (const p of old) logger.info({ partition: p.name, estimatedRows: p.rows }, 'candidate');

  if (execute && old.length > 0) {
    mkdirSync(dir, { recursive: true });
    for (const p of old) {
      const file = path.join(dir, `${p.name}.dump`);
      await run('pg_dump', ['--format=custom', `--table=${p.schema}.${p.name}`, `--file=${file}`, `--dbname=${env.DATABASE_URL}`]);
      if (statSync(file).size === 0) throw new Error(`dump خالی است: ${file}`);
      await pools.write.query(`ALTER TABLE ${p.parent} DETACH PARTITION ${p.schema}.${p.name}`);
      if (drop) await pools.write.query(`DROP TABLE ${p.schema}.${p.name}`);
      logger.info({ partition: p.name, file, dropped: drop }, 'archived');
    }
  }
} catch (err) {
  logger.error({ err }, 'archive failed');
  process.exitCode = 1;
} finally {
  await pools.close();
}
