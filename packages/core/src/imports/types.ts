import type { ColumnMap, ImportOptions, ImportType } from '@pos/shared';
import type pg from 'pg';

/** خطای قطعی دسته (قابل‌نمایش به کاربر؛ retry خودکار ندارد) */
export class BatchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BatchError';
  }
}

export type CommitMode = 'strict' | 'skip_invalid';

export interface Lookups {
  supporters: Map<string, number[]>;
  banks: Map<string, number[]>;
  routes: Map<string, number[]>;
}

export interface HandlerCtx {
  officeId: number;
  batchId: number;
  userId: number;
  /** نام کامل جدول staging (schema.s_<id>) */
  table: string;
  options: ImportOptions;
  columnMap: ColumnMap;
  today: string;
  effectiveDate: string;
  lookups: Lookups;
  /** transactions: آخرین روز دوره (فقط source=monthly) */
  monthEnd: string | null; // قابل تغییر در prepare
}

export interface ValidateOutcome {
  warnings: Record<string, number>;
}

export interface MergeStats {
  inserted: number; updated: number; unchanged: number;
  /** آمار اضافه‌ی مخصوص نوع (مثلاً infoUpdated، banksCreated، pendingTerminals) که در import_batches.merge_summary ثبت می‌شود */
  extra?: Record<string, number>;
}

export interface TypeHandler {
  readonly type: ImportType;
  readonly copyColumns: readonly string[];
  createTableSql(table: string): string;
  indexSql(table: string): string[];
  /** پیش‌شرط‌ها (مثلاً تاریخ فایل)؛ در صورت نقص BatchError می‌اندازد */
  prepare(client: pg.PoolClient, ctx: HandlerCtx, indexes: Record<string, number>): Promise<void>;
  /** پاک‌سازی و نوع‌دهی یک ردیف؛ خروجی هم‌ترتیب با copyColumns */
  toRow(rowNo: number, raw: Record<string, unknown>, ctx: HandlerCtx): unknown[];
  validate(client: pg.PoolClient, ctx: HandlerCtx): Promise<ValidateOutcome>;
  /** بازبینی ناسازگاری با دیتابیس درست قبل از merge (دسته ممکن است چند ساعت پیش اعتبارسنجی شده باشد) */
  recheck(client: pg.PoolClient, ctx: HandlerCtx): Promise<void>;
  merge(client: pg.PoolClient, ctx: HandlerCtx): Promise<MergeStats>;
}

export interface StoredBatchOptions extends ImportOptions {
  columnMap?: ColumnMap;
  commitMode?: CommitMode;
}

export interface BatchRow {
  id: number;
  officeId: number;
  type: ImportType;
  status: string;
  fileKind: 'xlsx' | 'csv';
  fileSize: number;
  storageKey: string;
  rawOptions: Record<string, unknown>;
  createdBy: number;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
export function stagingTable(schema: string, batchId: number): string {
  if (!SCHEMA_RE.test(schema) || !Number.isInteger(batchId)) throw new Error('invalid staging identifier');
  return `${schema}.s_${batchId}`;
}

export function csvErr(code: string, col: string, message: string): { code: string; col: string; message: string } {
  return { code, col, message };
}
