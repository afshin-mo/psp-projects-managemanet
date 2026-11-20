import {
  columnMapSchema, importOptionsSchema, normalizeSearchText, todayInTehran, type ImportType,
} from '@pos/shared';
import type pg from 'pg';
import type { Logger } from '../logging/pino';
import { queryOne, queryRows, type Queryable } from '../db/types';
import type { StorageProvider } from '../storage/storage';
import { terminalsHandler } from './types/terminals';
import { transactionsHandler } from './types/transactions';
import {
  stagingTable, type BatchRow, type HandlerCtx, type Lookups, type TypeHandler,
} from './types';

export interface ImportDeps {
  pool: pg.Pool;
  storage: StorageProvider;
  logger: Logger;
  stagingSchema: string;
  maxRows: number;
  vacuumThreshold: number;
  /** برای تست قابل جایگزینی */
  today?: () => string;
  /**
   * بعد از merge موفق فراخوانی می‌شود (Worker: صف‌کردن تجمیع). اگر تعریف شود وضعیت دسته «aggregating» می‌ماند
   * تا job تجمیع آن را «completed» کند؛ وگرنه همین‌جا completed می‌شود.
   */
  onMerged?: (info: { officeId: number; batchId: number }) => Promise<void>;
}

export function handlerFor(type: ImportType): TypeHandler {
  return type === 'terminals' ? terminalsHandler : transactionsHandler;
}

export async function loadBatch(db: Queryable, id: number): Promise<BatchRow | undefined> {
  return queryOne<BatchRow>(db,
    `SELECT id, office_id AS "officeId", type, status, file_kind AS "fileKind", file_size AS "fileSize",
            storage_key AS "storageKey", options AS "rawOptions", created_by AS "createdBy"
       FROM import_batches WHERE id = $1`, [id]);
}

export async function failBatch(db: Queryable, id: number, code: string, message: string, stage: string): Promise<void> {
  await db.query(
    `UPDATE import_batches SET status = 'failed', stage = $2, error_summary = $3::jsonb, finished_at = now() WHERE id = $1`,
    [id, stage, JSON.stringify({ code, message })]);
}

async function nameMap(db: Queryable, sql: string, officeId: number): Promise<Map<string, number[]>> {
  const m = new Map<string, number[]>();
  for (const r of await queryRows<{ id: number; name: string }>(db, sql, [officeId])) {
    const key = normalizeSearchText(r.name);
    const list = m.get(key);
    if (list) list.push(r.id);
    else m.set(key, [r.id]);
  }
  return m;
}

export async function loadLookups(db: Queryable, officeId: number): Promise<Lookups> {
  return {
    supporters: await nameMap(db, 'SELECT id, full_name AS name FROM supporters WHERE office_id = $1 AND is_active', officeId),
    banks: await nameMap(db, 'SELECT id, name FROM banks WHERE office_id = $1', officeId),
    routes: await nameMap(db, 'SELECT id, name FROM route_groups WHERE office_id = $1', officeId),
  };
}

export function buildCtx(batch: BatchRow, deps: ImportDeps, lookups: Lookups): HandlerCtx {
  const today = (deps.today ?? todayInTehran)();
  const options = importOptionsSchema.parse(batch.rawOptions);
  const columnMap = columnMapSchema.safeParse(batch.rawOptions.columnMap);
  return {
    officeId: batch.officeId, batchId: batch.id, userId: batch.createdBy,
    table: stagingTable(deps.stagingSchema, batch.id),
    options, columnMap: columnMap.success ? columnMap.data : {},
    today, effectiveDate: options.effectiveDate ?? today, lookups, monthEnd: null,
  };
}
