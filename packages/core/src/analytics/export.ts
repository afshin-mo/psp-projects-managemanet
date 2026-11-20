import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { PassThrough, type Readable } from 'node:stream';
import type pg from 'pg';
import type { Logger } from '../logging/pino';
import { getDrilldownTerminals, type ResolvedFilter } from '../repos/analytics';
import type { StorageProvider } from '../storage/storage';
import type { TenantContext } from '../tenant/scope';

/** xlsx کوچک (در حافظه‌ی ردیف‌ها) به‌صورت stream */
export function xlsxFromRows(sheetName: string, header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): Readable {
  const out = new PassThrough();
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: false, useSharedStrings: false });
  const ws = wb.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });
  void (async () => {
    try {
      ws.addRow([...header]).commit();
      for (const r of rows) ws.addRow([...r]).commit();
      ws.commit();
      await wb.commit();
    } catch (err) {
      out.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  return out;
}

export interface ExportDeps { pool: pg.Pool; storage: StorageProvider; logger: Logger }

interface StoredParams {
  ctx: TenantContext; period: number;
  unitIds?: number[]; supporterIds?: number[]; routeGroupIds?: number[]; bankIds?: number[];
}

const CLASS_FA: Record<number, string> = { 1: 'فعال', 2: 'کم‌تراکنش', 3: 'برگشتی', 4: 'نوپا' };
const PAGE = 5000;

/** خروجی بزرگ ترمینال‌های یک ماه (تا ۲۰۰ هزار ردیف) به‌صورت stream؛ فایل کامل هرگز در حافظه نمی‌آید */
export async function runExportBuild(deps: ExportDeps, jobId: number): Promise<void> {
  const { pool, storage, logger } = deps;
  const job = (await pool.query<{ office_id: number; status: string; params: StoredParams }>(
    'SELECT office_id, status, params FROM export_jobs WHERE id = $1', [jobId])).rows[0];
  if (!job || !['queued', 'running', 'failed'].includes(job.status)) return;
  await pool.query(`UPDATE export_jobs SET status = 'running', error = NULL WHERE id = $1`, [jobId]);

  const { ctx, period } = job.params;
  const filter: ResolvedFilter = {
    from: period, to: period, period,
    unitIds: job.params.unitIds, supporterIds: job.params.supporterIds, routeIds: job.params.routeGroupIds, bankIds: job.params.bankIds,
  };
  const key = `exports/${job.office_id}/${jobId}-${randomUUID()}.xlsx`;
  const out = new PassThrough();
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: false, useSharedStrings: false });
  const ws = wb.addWorksheet('Terminals', { views: [{ rightToLeft: true }] });
  let count = 0;

  const producer = (async () => {
    ws.addRow(['شماره ترمینال', 'فروشگاه', 'مبلغ (ریال)', 'تعداد تراکنش', 'وضعیت', 'ماه کامل', 'مبلغ ماه قبل', 'تغییر (٪)']).commit();
    let cursor: string | undefined;
    do {
      const page = await getDrilldownTerminals(ctx, pool, filter, 'id', { cursor, limit: PAGE });
      for (const r of page.items) {
        ws.addRow([r.terminalNo, r.shopName ?? '', r.amount, r.txCount, CLASS_FA[r.activityClass] ?? '', r.isComplete ? 'بله' : 'خیر',
          r.previousAmount ?? '', r.changePct ?? '']).commit();
        count += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    ws.commit();
    await wb.commit();
  })().catch((err: unknown) => {
    out.destroy(err instanceof Error ? err : new Error(String(err)));
    throw err;
  });

  try {
    await Promise.all([storage.put(key, out), producer]);
    await pool.query(
      `UPDATE export_jobs SET status = 'done', storage_key = $2, row_count = $3, expires_at = now() + interval '2 days' WHERE id = $1`,
      [jobId, key, count]);
    logger.info({ jobId, rows: count }, 'export built');
  } catch (err) {
    await storage.delete(key).catch(() => undefined);
    await pool.query(`UPDATE export_jobs SET status = 'failed', error = $2 WHERE id = $1`, [jobId, err instanceof Error ? err.message : String(err)]);
    throw err;
  }
}

/** حذف فایل خروجی‌های منقضی‌شده */
export async function expireExports(pool: pg.Pool, storage: StorageProvider): Promise<number> {
  const rows = (await pool.query<{ id: number; storage_key: string | null }>(
    `SELECT id, storage_key FROM export_jobs WHERE status = 'done' AND expires_at < now()`)).rows;
  for (const r of rows) {
    if (r.storage_key) await storage.delete(r.storage_key).catch(() => undefined);
    await pool.query(`UPDATE export_jobs SET status = 'expired', storage_key = NULL WHERE id = $1`, [r.id]);
  }
  return rows.length;
}
