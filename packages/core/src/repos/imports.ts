import type {
  ColumnMap, ImportBatchDto, ImportErrorDto, ImportType, Page, PageQuery, UnknownTerminalDto,
} from '@pos/shared';
import { z } from 'zod';
import { SqlParams } from '../db/sql';
import { queryOne, queryRows, type Queryable } from '../db/types';
import { HttpError, notFound } from '../errors';
import { headerFingerprint } from '../imports/fingerprint';
import { decodeCursor, encodeCursor } from '../pagination';
import { assertRoles, scopeWhere, type TenantContext, type TenantRole } from '../tenant/scope';

const IMPORT_ROLES: readonly TenantRole[] = ['office_manager', 'data_admin'];
const cursorSchema = z.object({ id: z.number().int().nonnegative() });

const B_COLS = `b.id, b.type, b.status, b.file_name AS "fileName", b.file_size AS "fileSize", b.file_kind AS "fileKind",
  b.options, b.total_rows AS "totalRows", b.valid_rows AS "validRows", b.error_rows AS "errorRows",
  b.skipped_rows AS "skippedRows", b.inserted_rows AS "insertedRows", b.updated_rows AS "updatedRows",
  b.unchanged_rows AS "unchangedRows", b.stage, b.progress, b.error_summary AS "errorSummary",
  b.created_by AS "createdBy", b.created_at AS "createdAt", b.started_at AS "startedAt", b.finished_at AS "finishedAt",
  b.merge_summary AS "mergeSummary"`;

export interface NewBatchInput {
  type: ImportType;
  fileName: string;
  fileSize: number;
  fileHash: string;
  fileKind: 'xlsx' | 'csv';
  storageKey: string;
  options: Record<string, unknown>;
  status: 'uploaded' | 'needs_mapping';
}

export async function getImportBatch(ctx: TenantContext, db: Queryable, id: number): Promise<ImportBatchDto> {
  assertRoles(ctx, IMPORT_ROLES);
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 'b.office_id', officeWide: true });
  where.push(`b.id = ${p.add(id)}`);
  const row = await queryOne<ImportBatchDto>(db, `SELECT ${B_COLS} FROM import_batches b WHERE ${where.join(' AND ')}`, p.values);
  if (!row) throw notFound('دسته‌ی ایمپورت');
  return row;
}

export async function listImportBatches(ctx: TenantContext, db: Queryable, q: PageQuery): Promise<Page<ImportBatchDto>> {
  assertRoles(ctx, IMPORT_ROLES);
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 'b.office_id', officeWide: true });
  if (q.cursor) where.push(`b.id < ${p.add(decodeCursor(q.cursor, cursorSchema).id)}`);
  const rows = await queryRows<ImportBatchDto>(db,
    `SELECT ${B_COLS} FROM import_batches b WHERE ${where.join(' AND ')} ORDER BY b.id DESC LIMIT ${p.add(q.limit + 1)}`, p.values);
  let nextCursor: string | null = null;
  if (rows.length > q.limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor({ id: last.id });
  }
  return { items: rows, nextCursor };
}

export async function createImportBatch(ctx: TenantContext, db: Queryable, input: NewBatchInput): Promise<ImportBatchDto> {
  assertRoles(ctx, IMPORT_ROLES);
  try {
    const row = await queryOne<{ id: number }>(db,
      `INSERT INTO import_batches (office_id, type, status, file_name, file_size, file_hash, file_kind, storage_key, options, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING id`,
      [ctx.officeId, input.type, input.status, input.fileName, input.fileSize, input.fileHash, input.fileKind,
       input.storageKey, JSON.stringify(input.options), ctx.userId]);
    return await getImportBatch(ctx, db, (row as { id: number }).id);
  } catch (err) {
    if ((err as { constraint?: string }).constraint === 'import_batches_dedupe') {
      const existing = await queryOne<{ id: number }>(db,
        `SELECT id FROM import_batches WHERE office_id = $1 AND type = $2 AND file_hash = $3 AND status NOT IN ('failed','cancelled')`,
        [ctx.officeId, input.type, input.fileHash]);
      throw new HttpError(409, 'DUPLICATE_FILE', 'این فایل قبلاً ایمپورت (یا در حال پردازش) شده است', { existingBatchId: existing?.id ?? null });
    }
    throw err;
  }
}

/** نگاشت ستون‌ها را ثبت و دسته را برای اعتبارسنجی آماده می‌کند */
export async function setImportMapping(ctx: TenantContext, db: Queryable, id: number, columnMap: ColumnMap): Promise<ImportBatchDto> {
  assertRoles(ctx, IMPORT_ROLES);
  const r = await db.query(
    `UPDATE import_batches SET status = 'uploaded', options = options || jsonb_build_object('columnMap', $3::jsonb),
            error_summary = NULL, stage = 'queued'
      WHERE office_id = $1 AND id = $2 AND status IN ('needs_mapping','failed')`,
    [ctx.officeId, id, JSON.stringify(columnMap)]);
  if (!r.rowCount) {
    await getImportBatch(ctx, db, id);
    throw new HttpError(409, 'INVALID_STATE', 'در این وضعیت امکان تغییر نگاشت نیست');
  }
  return getImportBatch(ctx, db, id);
}

/** درخواست commit: atomic و فقط از وضعیت validated */
export async function requestImportCommit(ctx: TenantContext, db: Queryable, id: number, mode: 'strict' | 'skip_invalid'): Promise<ImportBatchDto> {
  assertRoles(ctx, IMPORT_ROLES);
  const r = await db.query(
    `UPDATE import_batches SET status = 'committing', stage = 'queued_commit', progress = 0,
            options = options || jsonb_build_object('commitMode', $3::text)
      WHERE office_id = $1 AND id = $2 AND status = 'validated'
        AND ($3::text <> 'strict' OR COALESCE(error_rows, 0) = 0) AND COALESCE(valid_rows, 0) > 0`,
    [ctx.officeId, id, mode]);
  if (!r.rowCount) {
    const b = await getImportBatch(ctx, db, id);
    if (b.status !== 'validated') throw new HttpError(409, 'INVALID_STATE', 'دسته در وضعیت قابل‌تأیید نیست');
    if (mode === 'strict' && (b.errorRows ?? 0) > 0) {
      throw new HttpError(409, 'HAS_ERRORS', 'فایل ردیف خطادار دارد؛ خطاها را اصلاح کنید یا حالت «رد ردیف‌های خطادار» را انتخاب کنید');
    }
    throw new HttpError(422, 'NOTHING_TO_IMPORT', 'ردیف معتبری برای ایمپورت وجود ندارد');
  }
  return getImportBatch(ctx, db, id);
}

export async function cancelImportBatch(ctx: TenantContext, db: Queryable, id: number): Promise<ImportBatchDto> {
  assertRoles(ctx, IMPORT_ROLES);
  const r = await db.query(
    `UPDATE import_batches SET status = 'cancelled', stage = 'cancelled', finished_at = now()
      WHERE office_id = $1 AND id = $2 AND status IN ('uploaded','needs_mapping','validated','failed')`, [ctx.officeId, id]);
  if (!r.rowCount) {
    await getImportBatch(ctx, db, id);
    throw new HttpError(409, 'INVALID_STATE', 'این دسته در وضعیت فعلی قابل لغو نیست');
  }
  return getImportBatch(ctx, db, id);
}

/** تلاش دوباره: فقط دسته‌ی failed؛ از اعتبارسنجی از نو شروع می‌شود (فایل در Storage هست) */
export async function retryImportBatch(ctx: TenantContext, db: Queryable, id: number): Promise<ImportBatchDto> {
  assertRoles(ctx, IMPORT_ROLES);
  const r = await db.query(
    `UPDATE import_batches SET status = 'uploaded', stage = 'queued', error_summary = NULL, progress = 0
      WHERE office_id = $1 AND id = $2 AND status = 'failed'
        AND options ? 'columnMap'`, [ctx.officeId, id]);
  if (!r.rowCount) {
    await getImportBatch(ctx, db, id);
    throw new HttpError(409, 'INVALID_STATE', 'فقط دسته‌ی شکست‌خورده‌ی دارای نگاشت قابل تلاش دوباره است');
  }
  return getImportBatch(ctx, db, id);
}

export async function listImportErrors(ctx: TenantContext, db: Queryable, id: number, q: PageQuery): Promise<Page<ImportErrorDto & { id: number }>> {
  await getImportBatch(ctx, db, id);
  const p = new SqlParams();
  const where = [`e.batch_id = ${p.add(id)}`];
  if (q.cursor) where.push(`e.id > ${p.add(decodeCursor(q.cursor, cursorSchema).id)}`);
  const rows = await queryRows<ImportErrorDto & { id: number }>(db,
    `SELECT e.id, e.row_no AS "rowNo", e.column_name AS "columnName", e.code, e.message
       FROM import_batch_errors e WHERE ${where.join(' AND ')} ORDER BY e.id LIMIT ${p.add(q.limit + 1)}`, p.values);
  let nextCursor: string | null = null;
  if (rows.length > q.limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor({ id: last.id });
  }
  return { items: rows, nextCursor };
}

export async function listUnknownTerminals(ctx: TenantContext, db: Queryable, id: number): Promise<UnknownTerminalDto[]> {
  await getImportBatch(ctx, db, id);
  return queryRows(db,
    `SELECT terminal_no AS "terminalNo", rows_count AS "rowsCount", total_amount AS "totalAmount", total_all_amount AS "totalAllAmount",
            first_row AS "firstRow", shop_name AS "shopName", owner_name AS "ownerName", phone, bank_name AS "bankName",
            has_activity AS "hasActivity"
       FROM import_unknown_terminals WHERE batch_id = $1 ORDER BY has_activity DESC, first_row LIMIT 5000`, [id]);
}

/** ۵۰ ردیف اول staging (قبل از commit). اگر staging پاک شده باشد لیست خالی است. */
export async function previewImport(ctx: TenantContext, db: Queryable, id: number, stagingSchema: string): Promise<Array<Record<string, unknown>>> {
  await getImportBatch(ctx, db, id);
  if (!/^[a-z_][a-z0-9_]*$/.test(stagingSchema)) throw new Error('invalid staging schema');
  const table = `${stagingSchema}.s_${id}`;
  const exists = await queryOne<{ r: string | null }>(db, 'SELECT to_regclass($1)::text AS r', [table]);
  if (!exists?.r) return [];
  const rows = await queryRows<{ row: Record<string, unknown> }>(db, `SELECT to_jsonb(s) AS row FROM ${table} s ORDER BY s.row_no LIMIT 50`);
  return rows.map((r) => r.row);
}

export async function listImportProfiles(ctx: TenantContext, db: Queryable, type?: ImportType) {
  assertRoles(ctx, IMPORT_ROLES);
  const p = new SqlParams();
  const where = [`office_id = ${p.add(ctx.officeId)}`];
  if (type) where.push(`type = ${p.add(type)}`);
  return queryRows<{ id: number; type: string; name: string; version: number; columnMap: ColumnMap; createdAt: string }>(db,
    `SELECT id, type, name, version, column_map AS "columnMap", created_at AS "createdAt"
       FROM import_profiles WHERE ${where.join(' AND ')} ORDER BY type, name, version DESC`, p.values);
}

/** ذخیره‌ی نگاشت به‌عنوان پروفایل دفتر (نسخه‌ی بعدی همان نام) */
export async function saveImportProfile(
  ctx: TenantContext, db: Queryable, input: { type: ImportType; name: string; columnMap: ColumnMap; headers: string[] },
): Promise<void> {
  assertRoles(ctx, IMPORT_ROLES);
  await db.query(
    `INSERT INTO import_profiles (office_id, type, name, version, header_fingerprint, column_map, created_by)
     VALUES ($1, $2, $3, COALESCE((SELECT max(version) FROM import_profiles WHERE office_id = $1 AND type = $2 AND name = $3), 0) + 1,
             $4, $5::jsonb, $6)`,
    [ctx.officeId, input.type, input.name, headerFingerprint(input.headers), JSON.stringify(input.columnMap), ctx.userId]);
}
