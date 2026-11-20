import type pg from 'pg';
import {
  buildTerminalSearchNorm, escapeLike, normalizeSearchText, todayInTehran, type AssignmentInput, type AuditDto,
  type BulkAssignInput, type BulkResultDto, type CreateTerminalInput, type Page, type PageQuery, type PatchTerminalInput,
  type ReactivateTerminalInput, type ReturnTerminalInput, type TerminalDto, type TerminalHistoryDto, type TerminalListQuery,
  type TerminalLookupDto, type TransferSupporterUnitInput, type TransferTerminalsInput, type TransferUnitResultDto,
} from '@pos/shared';
import { z } from 'zod';
import { writeAudit } from '../audit/audit';
import { SqlParams } from '../db/sql';
import { queryOne, queryRows, withTx, type Queryable } from '../db/types';
import { HttpError, forbidden, mapPgError, notFound } from '../errors';
import { decodeCursor, encodeCursor } from '../pagination';
import { adoptPendingRows } from '../pending/adopt';
import { assertRoles, scopeWhere, type TenantContext, type TenantRole } from '../tenant/scope';

const MANAGE_ROLES: readonly TenantRole[] = ['office_manager', 'unit_head', 'data_admin'];
/** شروع اعتبار پشتیبان اولیه وقتی تاریخ نصب/شروع معلوم نیست */
export const DEFAULT_HISTORY_START = '2000-01-01';

const T_COLS = `t.id, t.terminal_no AS "terminalNo", t.owner_name AS "ownerName", t.phone, t.address,
  t.shop_name AS "shopName", t.route_group_id AS "routeGroupId", t.bank_id AS "bankId", t.status,
  t.installed_at AS "installedAt", t.returned_at AS "returnedAt", t.return_reason AS "returnReason", t.current_supporter_id AS "supporterId",
  t.current_unit_id AS "unitId", t.attributes, t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;

const TERMINAL_SCOPE = { office: 't.office_id', unit: 't.current_unit_id', supporter: 't.current_supporter_id' } as const;

const listCursorSchema = z.object({ id: z.number().int().nonnegative() });
const auditCursorSchema = z.object({ ts: z.string().min(10), id: z.number().int().nonnegative() });

// ------------------------------------------------------------------ خواندن

export async function getTerminal(ctx: TenantContext, db: Queryable, id: number): Promise<TerminalDto> {
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, TERMINAL_SCOPE);
  where.push(`t.id = ${p.add(id)}`);
  const row = await queryOne<TerminalDto>(db, `SELECT ${T_COLS} FROM terminals t WHERE ${where.join(' AND ')}`, p.values);
  if (!row) throw notFound('ترمینال'); // خارج از دامنه‌ی دسترسی هم «یافت نشد» است (افشا نمی‌شود که وجود دارد)
  return row;
}

export async function listTerminals(ctx: TenantContext, db: Queryable, f: TerminalListQuery): Promise<Page<TerminalDto>> {
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, TERMINAL_SCOPE);
  if (f.cursor) where.push(`t.id > ${p.add(decodeCursor(f.cursor, listCursorSchema).id)}`);
  // فیلترهای کاربر فقط محدودتر می‌کنند، هرگز دامنه‌ی نقش را گسترش نمی‌دهند
  if (f.supporterId !== undefined) where.push(`t.current_supporter_id = ${p.add(f.supporterId)}`);
  if (f.unitId !== undefined) where.push(`t.current_unit_id = ${p.add(f.unitId)}`);
  if (f.routeGroupId !== undefined) where.push(`t.route_group_id = ${p.add(f.routeGroupId)}`);
  if (f.bankId !== undefined) where.push(`t.bank_id = ${p.add(f.bankId)}`);
  if (f.status !== undefined) where.push(`t.status = ${p.add(f.status)}`);
  if (f.q) {
    const norm = normalizeSearchText(f.q);
    if (norm) where.push(`t.search_norm ILIKE ${p.add(`%${escapeLike(norm)}%`)}`);
  }
  const limitParam = p.add(f.limit + 1);
  const rows = await queryRows<TerminalDto>(db,
    `SELECT ${T_COLS} FROM terminals t WHERE ${where.join(' AND ')} ORDER BY t.id LIMIT ${limitParam}`, p.values);
  let nextCursor: string | null = null;
  if (rows.length > f.limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor({ id: last.id });
  }
  return { items: rows, nextCursor };
}

/**
 * جستجوی چند شماره ترمینال با هم. فقط ترمینال‌های داخل دامنه‌ی دسترسی کاربر برمی‌گردد؛ بقیه (چه ناموجود چه خارج از دامنه)
 * یکسان «notFound» گزارش می‌شوند تا وجودشان افشا نشود. خروجی به ترتیب ورودی است.
 */
export async function lookupTerminals(ctx: TenantContext, db: Queryable, terminalNos: readonly string[]): Promise<TerminalLookupDto> {
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, TERMINAL_SCOPE);
  where.push(`t.terminal_no = ANY(${p.add([...terminalNos])}::text[])`);
  const rows = await queryRows<TerminalDto>(db, `SELECT ${T_COLS} FROM terminals t WHERE ${where.join(' AND ')}`, p.values);
  const byNo = new Map(rows.map((r) => [r.terminalNo, r]));
  const items: TerminalDto[] = [];
  const notFound: string[] = [];
  for (const no of terminalNos) {
    const t = byNo.get(no);
    if (t) items.push(t); else notFound.push(no);
  }
  return { items, notFound, requested: terminalNos.length };
}

export async function getTerminalHistory(ctx: TenantContext, db: Queryable, id: number): Promise<TerminalHistoryDto[]> {
  await getTerminal(ctx, db, id); // کنترل دسترسی
  return queryRows(db,
    `SELECT h.id, h.supporter_id AS "supporterId", h.staff_unit_id AS "unitId", h.route_group_id AS "routeGroupId",
            h.bank_id AS "bankId", h.start_date AS "startDate", h.end_date AS "endDate",
            h.changed_by AS "changedBy", u.full_name AS "changedByName", h.created_at AS "createdAt"
       FROM terminal_supporter_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.office_id = $1 AND h.terminal_id = $2 ORDER BY h.start_date`,
    [ctx.officeId, id]);
}

export async function listTerminalAudit(ctx: TenantContext, db: Queryable, id: number, q: PageQuery): Promise<Page<AuditDto>> {
  assertRoles(ctx, ['office_manager', 'unit_head']);
  await getTerminal(ctx, db, id);
  const p = new SqlParams();
  const where = [`a.office_id = ${p.add(ctx.officeId)}`, `a.entity_type = 'terminal'`, `a.entity_id = ${p.add(id)}`];
  if (q.cursor) {
    const c = decodeCursor(q.cursor, auditCursorSchema);
    where.push(`(a.created_at, a.id) < (${p.add(c.ts)}::timestamptz, ${p.add(c.id)})`);
  }
  const rows = await queryRows<AuditDto & { ts: string }>(db,
    `SELECT a.id, a.user_id AS "userId", a.action, a.before, a.after, a.created_at AS "createdAt",
            usr.full_name AS "userName", a.batch_id AS "batchId", ib.file_name AS "batchFileName",
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
       FROM audit_log a LEFT JOIN users usr ON usr.id = a.user_id LEFT JOIN import_batches ib ON ib.id = a.batch_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${p.add(q.limit + 1)}`, p.values);
  let nextCursor: string | null = null;
  if (rows.length > q.limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor({ ts: last.ts, id: last.id });
  }
  return { items: rows.map(({ ts: _ts, ...rest }) => rest), nextCursor };
}

// ------------------------------------------------------------------ نوشتن

/** قفل ردیف ترمینال (در محدوده‌ی دسترسی کاربر) برای تغییر امن */
async function lockTerminal(ctx: TenantContext, c: pg.PoolClient, id: number): Promise<TerminalDto> {
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, TERMINAL_SCOPE);
  where.push(`t.id = ${p.add(id)}`);
  const row = await queryOne<TerminalDto>(c, `SELECT ${T_COLS} FROM terminals t WHERE ${where.join(' AND ')} FOR UPDATE OF t`, p.values);
  if (!row) throw notFound('ترمینال');
  return row;
}

async function enqueueRecompute(
  c: Queryable, officeId: number, terminalId: number, effectiveDate: string,
  reason: 'assignment' | 'installed_at' | 'returned_at' | 'import',
): Promise<void> {
  await c.query(
    'INSERT INTO recompute_outbox (office_id, terminal_id, effective_date, reason) VALUES ($1, $2, $3, $4)',
    [officeId, terminalId, effectiveDate, reason],
  );
}

export async function createTerminal(ctx: TenantContext, pool: pg.Pool, input: CreateTerminalInput): Promise<TerminalDto> {
  assertRoles(ctx, MANAGE_ROLES);
  const id = await withTx(pool, async (c) => {
    const sup = await queryOne<{ unitId: number }>(c,
      `SELECT staff_unit_id AS "unitId" FROM supporters WHERE office_id = $1 AND id = $2 AND is_active`,
      [ctx.officeId, input.supporterId]);
    if (!sup) throw new HttpError(422, 'INVALID_SUPPORTER', 'پشتیبان نامعتبر یا غیرفعال است');
    if (ctx.role === 'unit_head' && sup.unitId !== ctx.unitId) throw forbidden('این پشتیبان در ستاد شما نیست');

    const ins = await queryOne<{ id: number }>(c,
      `INSERT INTO terminals (office_id, terminal_no, owner_name, phone, address, shop_name, route_group_id, bank_id,
                              installed_at, current_supporter_id, current_unit_id, search_norm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [ctx.officeId, input.terminalNo, input.ownerName ?? null, input.phone ?? null, input.address ?? null,
       input.shopName ?? null, input.routeGroupId ?? null, input.bankId ?? null, input.installedAt ?? null,
       input.supporterId, sup.unitId,
       buildTerminalSearchNorm({ terminalNo: input.terminalNo, shopName: input.shopName, ownerName: input.ownerName })]);
    const terminalId = (ins as { id: number }).id;

    await c.query(
      `INSERT INTO terminal_supporter_history
         (office_id, terminal_id, supporter_id, staff_unit_id, route_group_id, bank_id, start_date, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.officeId, terminalId, input.supporterId, sup.unitId, input.routeGroupId ?? 0, input.bankId ?? 0,
       input.assignedFrom ?? input.installedAt ?? DEFAULT_HISTORY_START, ctx.userId]);

    await writeAudit(c, {
      officeId: ctx.officeId, userId: ctx.userId, entityType: 'terminal', entityId: terminalId, action: 'create',
      after: { terminalNo: input.terminalNo, supporterId: input.supporterId, unitId: sup.unitId,
               routeGroupId: input.routeGroupId ?? null, bankId: input.bankId ?? null,
               shopName: input.shopName ?? null, ownerName: input.ownerName ?? null },
    });
    await enqueueRecompute(c, ctx.officeId, terminalId, input.installedAt ?? todayInTehran(), 'import');
    await adoptPendingRows(c, ctx.officeId, ctx.userId, [input.terminalNo]); // اگر در صندوق تعریف‌نشده‌ها بود
    return terminalId;
  });
  return getTerminal(ctx, pool, id);
}

const PATCH_FIELDS = {
  ownerName: 'owner_name', phone: 'phone', address: 'address', shopName: 'shop_name', installedAt: 'installed_at',
} as const;
type PatchKey = keyof typeof PATCH_FIELDS;

export async function patchTerminal(ctx: TenantContext, pool: pg.Pool, id: number, input: PatchTerminalInput): Promise<TerminalDto> {
  assertRoles(ctx, MANAGE_ROLES);
  await withTx(pool, async (c) => {
    const cur = await lockTerminal(ctx, c, id);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const merged = { ownerName: cur.ownerName, shopName: cur.shopName };
    const p = new SqlParams();
    const sets: string[] = [];

    for (const key of Object.keys(PATCH_FIELDS) as PatchKey[]) {
      const next = input[key];
      if (next === undefined || next === cur[key]) continue;
      before[key] = cur[key];
      after[key] = next;
      sets.push(`${PATCH_FIELDS[key]} = ${p.add(next)}`);
      if (key === 'ownerName') merged.ownerName = next;
      if (key === 'shopName') merged.shopName = next;
    }
    if (sets.length === 0) return;

    sets.push(`search_norm = ${p.add(buildTerminalSearchNorm({ terminalNo: cur.terminalNo, ...merged }))}`);
    sets.push('updated_at = now()');
    await c.query(
      `UPDATE terminals SET ${sets.join(', ')} WHERE office_id = ${p.add(ctx.officeId)} AND id = ${p.add(id)}`, p.values);

    if ('installedAt' in after) {
      const oldD = cur.installedAt;
      const newD = after.installedAt as string | null;
      const effective = [oldD, newD].filter((d): d is string => d !== null).sort()[0];
      if (effective) await enqueueRecompute(c, ctx.officeId, id, effective, 'installed_at');
    }
    await writeAudit(c, { officeId: ctx.officeId, userId: ctx.userId, entityType: 'terminal', entityId: id, action: 'update', before, after });
  });
  return getTerminal(ctx, pool, id);
}

/**
 * تعویض پشتیبان/مسیر/بانک (SCD2).
 *  - ماه تغییر و ماه‌های بعد برای مقدار جدید؛ ماه‌های قبل دست‌نخورده (snapshot در fact).
 *  - تاریخ اعمال: پیش‌فرض امروز؛ نه آینده و نه قبل از شروع ردیف جاری تاریخچه.
 *  - اگر تاریخ دقیقاً برابر شروع ردیف جاری باشد، همان ردیف اصلاح می‌شود (نه ردیف تهی).
 *  - بازمحاسبه‌ی آمار از طریق recompute_outbox در همان transaction ثبت می‌شود (Worker در فاز ۲).
 */
export async function assignTerminal(
  ctx: TenantContext, pool: pg.Pool, id: number, input: AssignmentInput, today: string,
): Promise<TerminalDto> {
  assertRoles(ctx, MANAGE_ROLES);
  await withTx(pool, (c) => applyAssignment(ctx, c, id, input, today));
  return getTerminal(ctx, pool, id);
}

/**
 * هسته‌ی تعویض داخل یک transaction موجود (برای تعویض تکی و گروهی).
 * اگر تغییری وجود نداشته باشد خطای NO_CHANGE می‌دهد.
 */
export async function applyAssignment(
  ctx: TenantContext, c: pg.PoolClient, id: number, input: AssignmentInput, today: string,
): Promise<void> {
  const effective = input.effectiveDate ?? today;
  if (effective > today) throw new HttpError(422, 'FUTURE_EFFECTIVE_DATE', 'تاریخ اعمال نمی‌تواند در آینده باشد');

  const cur = await lockTerminal(ctx, c, id);
  const open = await queryOne<{ id: number; startDate: string }>(c,
    `SELECT id, start_date AS "startDate" FROM terminal_supporter_history
      WHERE office_id = $1 AND terminal_id = $2 AND end_date IS NULL FOR UPDATE`, [ctx.officeId, id]);
  if (!open) throw new HttpError(500, 'HISTORY_MISSING', 'تاریخچه‌ی ترمینال ناقص است');
  if (effective < open.startDate) {
    throw new HttpError(409, 'EFFECTIVE_BEFORE_START',
      `تاریخ اعمال نمی‌تواند قبل از شروع تخصیص جاری (${open.startDate}) باشد`);
  }

  const supporterId = input.supporterId ?? cur.supporterId;
  const routeGroupId = input.routeGroupId === undefined ? cur.routeGroupId : input.routeGroupId;
  const bankId = input.bankId === undefined ? cur.bankId : input.bankId;
  if (supporterId === cur.supporterId && routeGroupId === cur.routeGroupId && bankId === cur.bankId) {
    throw new HttpError(422, 'NO_CHANGE', 'تغییری نسبت به وضعیت فعلی وجود ندارد');
  }

  let unitId = cur.unitId;
  if (supporterId !== cur.supporterId) {
    const sup = await queryOne<{ unitId: number }>(c,
      `SELECT staff_unit_id AS "unitId" FROM supporters WHERE office_id = $1 AND id = $2 AND is_active`,
      [ctx.officeId, supporterId]);
    if (!sup) throw new HttpError(422, 'INVALID_SUPPORTER', 'پشتیبان نامعتبر یا غیرفعال است');
    if (ctx.role === 'unit_head' && sup.unitId !== ctx.unitId) throw forbidden('پشتیبان مقصد در ستاد شما نیست');
    unitId = sup.unitId;
  }

  const histRoute = routeGroupId ?? 0;
  const histBank = bankId ?? 0;
  if (effective === open.startDate) {
    await c.query(
      `UPDATE terminal_supporter_history SET supporter_id = $2, staff_unit_id = $3, route_group_id = $4, bank_id = $5, changed_by = $6
        WHERE id = $1`, [open.id, supporterId, unitId, histRoute, histBank, ctx.userId]);
  } else {
    await c.query('UPDATE terminal_supporter_history SET end_date = $2 WHERE id = $1', [open.id, effective]);
    await c.query(
      `INSERT INTO terminal_supporter_history
         (office_id, terminal_id, supporter_id, staff_unit_id, route_group_id, bank_id, start_date, changed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.officeId, id, supporterId, unitId, histRoute, histBank, effective, ctx.userId]);
  }

  await c.query(
    `UPDATE terminals SET current_supporter_id = $3, current_unit_id = $4, route_group_id = $5, bank_id = $6, updated_at = now()
      WHERE office_id = $1 AND id = $2`, [ctx.officeId, id, supporterId, unitId, routeGroupId, bankId]);

  await enqueueRecompute(c, ctx.officeId, id, effective, 'assignment');
  await writeAudit(c, {
    officeId: ctx.officeId, userId: ctx.userId, entityType: 'terminal', entityId: id, action: 'assign',
    before: { supporterId: cur.supporterId, unitId: cur.unitId, routeGroupId: cur.routeGroupId, bankId: cur.bankId },
    after: { supporterId, unitId, routeGroupId, bankId, effectiveDate: effective },
  });
}

// ------------------------------------------------------------------ فاز ۵: انصراف، ویرایش گروهی، انتقال

/**
 * ثبت انصراف/برگشت. ترمینال از ماه انصراف «برگشتی» حساب می‌شود و بعد از آن ردیفی در fact نمی‌گیرد.
 * تاریخ پیش‌فرض: امروز؛ نه آینده و نه قبل از تاریخ نصب.
 */
export async function returnTerminal(
  ctx: TenantContext, pool: pg.Pool, id: number, input: ReturnTerminalInput, today: string,
): Promise<TerminalDto> {
  assertRoles(ctx, MANAGE_ROLES);
  const returnedAt = input.returnedAt ?? today;
  if (returnedAt > today) throw new HttpError(422, 'FUTURE_RETURN_DATE', 'تاریخ انصراف نمی‌تواند در آینده باشد');
  await withTx(pool, async (c) => {
    const cur = await lockTerminal(ctx, c, id);
    if (cur.status === 'returned') throw new HttpError(409, 'ALREADY_RETURNED', 'این ترمینال قبلاً برگشتی ثبت شده است');
    if (cur.installedAt && returnedAt < cur.installedAt) {
      throw new HttpError(422, 'RETURN_BEFORE_INSTALL', `تاریخ انصراف نمی‌تواند قبل از تاریخ نصب (${cur.installedAt}) باشد`);
    }
    const reason = input.reason ?? null;
    await c.query(
      `UPDATE terminals SET status = 'returned', returned_at = $3, return_reason = $4, updated_at = now()
        WHERE office_id = $1 AND id = $2`, [ctx.officeId, id, returnedAt, reason]);
    await enqueueRecompute(c, ctx.officeId, id, returnedAt, 'returned_at');
    await writeAudit(c, {
      officeId: ctx.officeId, userId: ctx.userId, entityType: 'terminal', entityId: id, action: 'update',
      before: { status: 'active', returnedAt: null, returnReason: null },
      after: { status: 'returned', returnedAt, returnReason: reason },
    });
  });
  return getTerminal(ctx, pool, id);
}

/** لغو انصراف (ثبت اشتباه). آمار از ماه انصراف قبلی بازمحاسبه می‌شود. */
export async function reactivateTerminal(
  ctx: TenantContext, pool: pg.Pool, id: number, input: ReactivateTerminalInput,
): Promise<TerminalDto> {
  assertRoles(ctx, MANAGE_ROLES);
  await withTx(pool, async (c) => {
    const cur = await lockTerminal(ctx, c, id);
    if (cur.status !== 'returned' || !cur.returnedAt) throw new HttpError(409, 'NOT_RETURNED', 'این ترمینال برگشتی نیست');
    await c.query(
      `UPDATE terminals SET status = 'active', returned_at = NULL, return_reason = NULL, updated_at = now()
        WHERE office_id = $1 AND id = $2`, [ctx.officeId, id]);
    await enqueueRecompute(c, ctx.officeId, id, cur.returnedAt, 'returned_at');
    await writeAudit(c, {
      officeId: ctx.officeId, userId: ctx.userId, entityType: 'terminal', entityId: id, action: 'update',
      before: { status: 'returned', returnedAt: cur.returnedAt, returnReason: cur.returnReason },
      after: { status: 'active', returnedAt: null, returnReason: null, note: input.reason ?? null },
    });
  });
  return getTerminal(ctx, pool, id);
}

/** اجرای applyAssignment برای چند ترمینال در یک transaction (همه یا هیچ) با گزارش خطای هر ترمینال */
async function bulkApply(
  ctx: TenantContext, c: pg.PoolClient, ids: readonly number[], input: AssignmentInput, today: string,
): Promise<BulkResultDto> {
  const unique = [...new Set(ids)];
  let updated = 0;
  let unchanged = 0;
  const failures: Array<{ terminalId: number; code: string; message: string }> = [];
  for (const id of unique) {
    await c.query('SAVEPOINT bulk_item');
    try {
      await applyAssignment(ctx, c, id, input, today);
      await c.query('RELEASE SAVEPOINT bulk_item');
      updated += 1;
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT bulk_item');
      await c.query('RELEASE SAVEPOINT bulk_item');
      const http = err instanceof HttpError ? err : mapPgError(err);
      if (!http) throw err;
      if (http.code === 'NO_CHANGE') unchanged += 1;
      else failures.push({ terminalId: id, code: http.code, message: http.message });
    }
  }
  if (failures.length > 0) {
    throw new HttpError(422, 'BULK_FAILED', `عملیات برای ${failures.length} ترمینال ناموفق بود؛ هیچ تغییری اعمال نشد`,
      { failures: failures.slice(0, 50), failureCount: failures.length });
  }
  return { updated, unchanged };
}

/** تعویض گروهی پشتیبان/مسیر/بانک (حداکثر ۱۰۰۰ ترمینال). همه یا هیچ. */
export async function bulkAssignTerminals(
  ctx: TenantContext, pool: pg.Pool, input: BulkAssignInput, today: string,
): Promise<BulkResultDto> {
  assertRoles(ctx, MANAGE_ROLES);
  const { terminalIds, ...assignment } = input;
  return withTx(pool, (c) => bulkApply(ctx, c, terminalIds, assignment, today));
}

/**
 * انتقال ترمینال‌های یک پشتیبان (همه‌ی ترمینال‌های فعلی یا فهرست انتخابی) به پشتیبان دیگر.
 * پشتیبان مقصد می‌تواند در ستاد دیگری باشد (ستاد ترمینال با پشتیبان مقصد هم‌خوان می‌شود).
 */
export async function transferSupporterTerminals(
  ctx: TenantContext, pool: pg.Pool, fromSupporterId: number, input: TransferTerminalsInput, today: string,
): Promise<BulkResultDto> {
  assertRoles(ctx, MANAGE_ROLES);
  if (fromSupporterId === input.toSupporterId) throw new HttpError(422, 'SAME_SUPPORTER', 'پشتیبان مبدأ و مقصد یکی است');
  return withTx(pool, async (c) => {
    const p = new SqlParams();
    const where = scopeWhere(ctx, p, TERMINAL_SCOPE);
    where.push(`t.current_supporter_id = ${p.add(fromSupporterId)}`);
    if (input.terminalIds) where.push(`t.id = ANY(${p.add(input.terminalIds)}::bigint[])`);
    const ids = (await queryRows<{ id: number }>(c, `SELECT t.id FROM terminals t WHERE ${where.join(' AND ')} ORDER BY t.id`, p.values)).map((r) => r.id);
    if (input.terminalIds && ids.length !== new Set(input.terminalIds).size) {
      throw new HttpError(422, 'TERMINALS_NOT_OWNED', 'برخی ترمینال‌ها متعلق به این پشتیبان نیستند یا در دسترس شما نیستند');
    }
    if (ids.length === 0) return { updated: 0, unchanged: 0 };
    return bulkApply(ctx, c, ids, { supporterId: input.toSupporterId, ...(input.effectiveDate ? { effectiveDate: input.effectiveDate } : {}) }, today);
  });
}

/**
 * انتقال یک پشتیبان به ستاد دیگر همراه ترمینال‌های فعلی‌اش.
 *  - از تاریخ اعمال به بعد، آمار ترمینال‌های او به ستاد جدید می‌رود؛ ماه‌های قبل دست‌نخورده می‌ماند.
 *  - ردیف تاریخچه‌ای که بعد از تاریخ اعمال شروع شده، از شروع خودش به ستاد جدید می‌رود (clamped).
 *  - فقط مدیر دفتر و ادمین داده.
 */
export async function transferSupporterUnit(
  ctx: TenantContext, pool: pg.Pool, supporterId: number, input: TransferSupporterUnitInput, today: string,
): Promise<TransferUnitResultDto> {
  assertRoles(ctx, ['office_manager', 'data_admin']);
  const effective = input.effectiveDate ?? today;
  if (effective > today) throw new HttpError(422, 'FUTURE_EFFECTIVE_DATE', 'تاریخ اعمال نمی‌تواند در آینده باشد');

  return withTx(pool, async (c) => {
    const sup = await queryOne<{ unitId: number }>(c,
      `SELECT staff_unit_id AS "unitId" FROM supporters WHERE office_id = $1 AND id = $2 FOR UPDATE`, [ctx.officeId, supporterId]);
    if (!sup) throw notFound('پشتیبان');
    if (sup.unitId === input.toUnitId) throw new HttpError(422, 'NO_CHANGE', 'پشتیبان از قبل در همین ستاد است');
    const unit = await queryOne<{ id: number }>(c,
      'SELECT id FROM staff_units WHERE office_id = $1 AND id = $2 AND is_active', [ctx.officeId, input.toUnitId]);
    if (!unit) throw new HttpError(422, 'INVALID_UNIT', 'ستاد مقصد نامعتبر یا غیرفعال است');

    // ترمینال‌های فعلی او را قفل می‌کنیم تا با تعویض هم‌زمان تداخل نکند
    const terminals = await queryRows<{ id: number }>(c,
      `SELECT id FROM terminals WHERE office_id = $1 AND current_supporter_id = $2 ORDER BY id FOR UPDATE`, [ctx.officeId, supporterId]);

    await c.query('UPDATE supporters SET staff_unit_id = $3 WHERE office_id = $1 AND id = $2', [ctx.officeId, supporterId, input.toUnitId]);

    // ردیف‌هایی که همزمان یا بعد از تاریخ اعمال شروع شده‌اند: همان‌جا اصلاح می‌شوند (باید قبل از مرحله‌ی بعد اجرا شود تا ردیف‌های تازه را نشمارد)
    const clamped = (await c.query(
      `UPDATE terminal_supporter_history SET staff_unit_id = $3, changed_by = $4
        WHERE office_id = $1 AND supporter_id = $2 AND end_date IS NULL AND start_date >= $5`,
      [ctx.officeId, supporterId, input.toUnitId, ctx.userId, effective])).rowCount ?? 0;

    // ردیف‌های جاری که از قبل از تاریخ اعمال شروع شده‌اند: بسته می‌شوند و ردیف جدید با ستاد جدید باز می‌شود
    const closed = await queryRows<{ terminalId: number; routeGroupId: number; bankId: number }>(c,
      `UPDATE terminal_supporter_history SET end_date = $3
        WHERE office_id = $1 AND supporter_id = $2 AND end_date IS NULL AND start_date < $3
        RETURNING terminal_id AS "terminalId", route_group_id AS "routeGroupId", bank_id AS "bankId"`,
      [ctx.officeId, supporterId, effective]);
    if (closed.length > 0) {
      await c.query(
        `INSERT INTO terminal_supporter_history
           (office_id, terminal_id, supporter_id, staff_unit_id, route_group_id, bank_id, start_date, changed_by)
         SELECT $1::int, x.terminal_id, $2::int, $3::int, x.route_group_id, x.bank_id, $4::date, $5::int
           FROM unnest($6::bigint[], $7::int[], $8::int[]) AS x(terminal_id, route_group_id, bank_id)`,
        [ctx.officeId, supporterId, input.toUnitId, effective, ctx.userId,
         closed.map((r) => r.terminalId), closed.map((r) => r.routeGroupId), closed.map((r) => r.bankId)]);
    }

    await c.query(
      'UPDATE terminals SET current_unit_id = $3, updated_at = now() WHERE office_id = $1 AND current_supporter_id = $2',
      [ctx.officeId, supporterId, input.toUnitId]);

    if (terminals.length > 0) {
      await c.query(
        `INSERT INTO recompute_outbox (office_id, terminal_id, effective_date, reason)
         SELECT $1::int, x, $2::date, 'assignment' FROM unnest($3::bigint[]) AS x`,
        [ctx.officeId, effective, terminals.map((t) => t.id)]);
    }
    await writeAudit(c, {
      officeId: ctx.officeId, userId: ctx.userId, entityType: 'supporter', entityId: supporterId, action: 'assign',
      before: { unitId: sup.unitId }, after: { unitId: input.toUnitId, effectiveDate: effective, terminals: terminals.length },
    });
    return { terminals: terminals.length, clamped, fromUnitId: sup.unitId, toUnitId: input.toUnitId };
  });
}
