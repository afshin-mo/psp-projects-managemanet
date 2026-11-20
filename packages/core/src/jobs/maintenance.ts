import { readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { todayInTehran } from '@pos/shared';
import type pg from 'pg';
import { ensureAuditPartitions } from '../db/periods';
import { expireExports } from '../analytics/export';
import type { Logger } from '../logging/pino';
import type { StorageProvider } from '../storage/storage';

/** ساخت پارتیشن‌های ۹۵ روز آینده‌ی snapshot و ۳ ماه آینده‌ی audit_log (idempotent) */
export async function ensurePartitionsJob(pool: pg.Pool, logger: Logger, today: string = todayInTehran()): Promise<void> {
  const r = await pool.query<{ n: string }>(`SELECT * FROM ensure_period_partitions($1::date, $1::date + 95) AS n`, [today]);
  const audit = await ensureAuditPartitions(pool, today, 0, 3);
  logger.info({ snapshotPartitions: r.rowCount, auditPartitions: audit.length }, 'partitions ensured');
}

export interface HousekeepingResult { stagingDropped: number; slowQueriesDeleted: number; tokensDeleted: number; tempFilesDeleted: number; cacheDeleted: number; exportsExpired: number }

/** فایل‌های موقت xlsx (pos-xlsx-*) که به هر دلیل (مثلاً قفل ویندوز) پاک نشده‌اند و قدیمی‌تر از ۱ روزند */
async function cleanTempFiles(): Promise<number> {
  let n = 0;
  const dir = os.tmpdir();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith('pos-xlsx-')) continue;
    const p = path.join(dir, name);
    const st = await stat(p).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 86_400_000) {
      await rm(p, { force: true }).catch(() => undefined);
      n += 1;
    }
  }
  return n;
}

/** پاک‌سازی: staging یتیم، متریک کند (>۳۰ روز)، refresh token منقضی (>۳۰ روز) */
export async function housekeepingJob(pool: pg.Pool, logger: Logger, stagingSchema: string, storage?: StorageProvider): Promise<HousekeepingResult> {
  const tables = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname ~ '^s_[0-9]+$'`, [stagingSchema]);
  let dropped = 0;
  for (const { relname } of tables.rows) {
    const id = Number(relname.slice(2));
    const b = await pool.query<{ status: string; old: boolean }>(
      `SELECT status, (COALESCE(finished_at, created_at) < now() - interval '2 days') AS old FROM import_batches WHERE id = $1`, [id]);
    const row = b.rows[0];
    const finished = row && ['completed', 'failed', 'cancelled'].includes(row.status);
    const abandoned = row && row.status === 'validated' && row.old; // اعتبارسنجی‌شده ولی هیچ‌وقت commit نشده
    if (!row || (finished && row.old) || abandoned) {
      await pool.query(`DROP TABLE IF EXISTS ${stagingSchema}.${relname}`);
      dropped += 1;
    }
  }
  const slow = await pool.query(`DELETE FROM slow_query_log WHERE at < now() - interval '30 days'`);
  const tok = await pool.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '30 days'`);
  const cache = await pool.query(`DELETE FROM stats_cache WHERE created_at < now() - interval '2 days'`);
  const exportsExpired = storage ? await expireExports(pool, storage) : 0;
  const result = { cacheDeleted: cache.rowCount ?? 0, exportsExpired, stagingDropped: dropped, slowQueriesDeleted: slow.rowCount ?? 0, tokensDeleted: tok.rowCount ?? 0, tempFilesDeleted: await cleanTempFiles() };
  logger.info(result, 'housekeeping done');
  return result;
}
