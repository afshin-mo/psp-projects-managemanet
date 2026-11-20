import { normalizeSearchText, type BulkBanksResultDto, type BulkCreateBanksInput, type BulkCreateRouteGroupsInput, type BulkRoutesResultDto } from '@pos/shared';
import type pg from 'pg';
import type {
  BankDto, CreateBankInput, CreateRouteGroupInput, CreateStaffUnitInput, CreateSupporterInput,
  PatchBankInput, PatchRouteGroupInput, PatchStaffUnitInput, PatchSupporterInput,
  RouteGroupDto, StaffUnitDto, SupporterDto,
} from '@pos/shared';
import { SqlParams } from '../db/sql';
import { writeAudit } from '../audit/audit';
import { queryOne, queryRows, withTx, type Queryable } from '../db/types';
import { notFound } from '../errors';
import { assertRoles, scopeWhere, type TenantContext } from '../tenant/scope';

const WRITERS = ['office_manager', 'data_admin'] as const;

/** ساخت لیست «col = $n» از فیلدهای تعریف‌شده (undefined نادیده گرفته می‌شود) */
function setClauses(p: SqlParams, fields: Array<[column: string, value: unknown]>): string[] {
  return fields.filter(([, v]) => v !== undefined).map(([c, v]) => `${c} = ${p.add(v)}`);
}

// ---------------- ستاد ----------------
const UNIT_COLS = `id, name, manager_name AS "managerName", is_active AS "isActive"`;

export async function listStaffUnits(ctx: TenantContext, db: Queryable): Promise<StaffUnitDto[]> {
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 'u.office_id', unit: 'u.id' });
  return queryRows(db, `SELECT u.id, u.name, u.manager_name AS "managerName", u.is_active AS "isActive"
                          FROM staff_units u WHERE ${where.join(' AND ')} ORDER BY u.name`, p.values);
}

export async function createStaffUnit(ctx: TenantContext, db: Queryable, input: CreateStaffUnitInput): Promise<StaffUnitDto> {
  assertRoles(ctx, WRITERS);
  const row = await queryOne<StaffUnitDto>(db,
    `INSERT INTO staff_units (office_id, name, manager_name) VALUES ($1, $2, $3) RETURNING ${UNIT_COLS}`,
    [ctx.officeId, input.name, input.managerName ?? null]);
  return row as StaffUnitDto;
}

export async function patchStaffUnit(ctx: TenantContext, db: Queryable, id: number, input: PatchStaffUnitInput): Promise<StaffUnitDto> {
  assertRoles(ctx, WRITERS);
  const p = new SqlParams();
  const sets = setClauses(p, [['name', input.name], ['manager_name', input.managerName], ['is_active', input.isActive]]);
  if (sets.length === 0) return getStaffUnit(ctx, db, id);
  const row = await queryOne<StaffUnitDto>(db,
    `UPDATE staff_units SET ${sets.join(', ')} WHERE office_id = ${p.add(ctx.officeId)} AND id = ${p.add(id)} RETURNING ${UNIT_COLS}`,
    p.values);
  if (!row) throw notFound('ستاد');
  return row;
}

async function getStaffUnit(ctx: TenantContext, db: Queryable, id: number): Promise<StaffUnitDto> {
  const row = await queryOne<StaffUnitDto>(db,
    `SELECT ${UNIT_COLS} FROM staff_units WHERE office_id = $1 AND id = $2`, [ctx.officeId, id]);
  if (!row) throw notFound('ستاد');
  return row;
}

// ---------------- پشتیبان ----------------
const SUP_COLS = `id, staff_unit_id AS "staffUnitId", full_name AS "fullName", phone, is_active AS "isActive"`;

export async function listSupporters(ctx: TenantContext, db: Queryable, unitId?: number): Promise<SupporterDto[]> {
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 's.office_id', unit: 's.staff_unit_id', supporter: 's.id' });
  if (unitId !== undefined) where.push(`s.staff_unit_id = ${p.add(unitId)}`);
  return queryRows(db, `SELECT s.id, s.staff_unit_id AS "staffUnitId", s.full_name AS "fullName", s.phone, s.is_active AS "isActive"
                          FROM supporters s WHERE ${where.join(' AND ')} ORDER BY s.full_name`, p.values);
}

export async function createSupporter(ctx: TenantContext, db: Queryable, input: CreateSupporterInput): Promise<SupporterDto> {
  assertRoles(ctx, WRITERS);
  const row = await queryOne<SupporterDto>(db,
    `INSERT INTO supporters (office_id, staff_unit_id, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING ${SUP_COLS}`,
    [ctx.officeId, input.staffUnitId, input.fullName, input.phone ?? null]);
  return row as SupporterDto;
}

export async function patchSupporter(ctx: TenantContext, db: Queryable, id: number, input: PatchSupporterInput): Promise<SupporterDto> {
  assertRoles(ctx, WRITERS);
  const p = new SqlParams();
  const sets = setClauses(p, [['full_name', input.fullName], ['phone', input.phone], ['is_active', input.isActive]]);
  if (sets.length === 0) {
    const cur = await queryOne<SupporterDto>(db, `SELECT ${SUP_COLS} FROM supporters WHERE office_id = $1 AND id = $2`, [ctx.officeId, id]);
    if (!cur) throw notFound('پشتیبان');
    return cur;
  }
  const row = await queryOne<SupporterDto>(db,
    `UPDATE supporters SET ${sets.join(', ')} WHERE office_id = ${p.add(ctx.officeId)} AND id = ${p.add(id)} RETURNING ${SUP_COLS}`,
    p.values);
  if (!row) throw notFound('پشتیبان');
  return row;
}

// ---------------- بانک ----------------
export async function listBanks(ctx: TenantContext, db: Queryable): Promise<BankDto[]> {
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 'b.office_id', officeWide: true });
  return queryRows(db, `SELECT b.id, b.name, b.code FROM banks b WHERE ${where.join(' AND ')} ORDER BY b.name`, p.values);
}

export async function createBank(ctx: TenantContext, db: Queryable, input: CreateBankInput): Promise<BankDto> {
  assertRoles(ctx, WRITERS);
  return (await queryOne<BankDto>(db,
    'INSERT INTO banks (office_id, name, code) VALUES ($1, $2, $3) RETURNING id, name, code',
    [ctx.officeId, input.name, input.code ?? null])) as BankDto;
}

export async function patchBank(ctx: TenantContext, db: Queryable, id: number, input: PatchBankInput): Promise<BankDto> {
  assertRoles(ctx, WRITERS);
  const p = new SqlParams();
  const sets = setClauses(p, [['name', input.name], ['code', input.code]]);
  if (sets.length === 0) {
    const cur = await queryOne<BankDto>(db, 'SELECT id, name, code FROM banks WHERE office_id = $1 AND id = $2', [ctx.officeId, id]);
    if (!cur) throw notFound('بانک');
    return cur;
  }
  const row = await queryOne<BankDto>(db,
    `UPDATE banks SET ${sets.join(', ')} WHERE office_id = ${p.add(ctx.officeId)} AND id = ${p.add(id)} RETURNING id, name, code`, p.values);
  if (!row) throw notFound('بانک');
  return row;
}

export async function deleteBank(ctx: TenantContext, db: Queryable, id: number): Promise<void> {
  assertRoles(ctx, WRITERS);
  const r = await db.query('DELETE FROM banks WHERE office_id = $1 AND id = $2', [ctx.officeId, id]);
  if (!r.rowCount) throw notFound('بانک');
}

// ---------------- مسیر ----------------
export async function listRouteGroups(ctx: TenantContext, db: Queryable): Promise<RouteGroupDto[]> {
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 'r.office_id', officeWide: true });
  return queryRows(db, `SELECT r.id, r.name FROM route_groups r WHERE ${where.join(' AND ')} ORDER BY r.name`, p.values);
}

export async function createRouteGroup(ctx: TenantContext, db: Queryable, input: CreateRouteGroupInput): Promise<RouteGroupDto> {
  assertRoles(ctx, WRITERS);
  return (await queryOne<RouteGroupDto>(db,
    'INSERT INTO route_groups (office_id, name) VALUES ($1, $2) RETURNING id, name', [ctx.officeId, input.name])) as RouteGroupDto;
}

export async function patchRouteGroup(ctx: TenantContext, db: Queryable, id: number, input: PatchRouteGroupInput): Promise<RouteGroupDto> {
  assertRoles(ctx, WRITERS);
  const row = await queryOne<RouteGroupDto>(db,
    `UPDATE route_groups SET name = COALESCE($3, name) WHERE office_id = $1 AND id = $2 RETURNING id, name`,
    [ctx.officeId, id, input.name ?? null]);
  if (!row) throw notFound('مسیر');
  return row;
}

export async function deleteRouteGroup(ctx: TenantContext, db: Queryable, id: number): Promise<void> {
  assertRoles(ctx, WRITERS);
  const r = await db.query('DELETE FROM route_groups WHERE office_id = $1 AND id = $2', [ctx.officeId, id]);
  if (!r.rowCount) throw notFound('مسیر');
}

// ---------------- ثبت گروهی ----------------
interface NameItem { name: string; code: string | null }

/** نام‌های تکراری داخل ورودی و موارد موجود (نرمال‌شده) رد می‌شوند و در skipped گزارش می‌گردند. */
function splitNew(items: NameItem[], existing: string[]): { fresh: NameItem[]; skipped: Array<{ name: string; reason: string }> } {
  const seen = new Set(existing.map(normalizeSearchText));
  const fresh: NameItem[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const it of items) {
    const key = normalizeSearchText(it.name);
    if (!key) { skipped.push({ name: it.name, reason: 'نام نامعتبر' }); continue; }
    if (seen.has(key)) { skipped.push({ name: it.name, reason: 'تکراری یا از قبل موجود' }); continue; }
    seen.add(key);
    fresh.push(it);
  }
  return { fresh, skipped };
}

export async function bulkCreateBanks(ctx: TenantContext, pool: pg.Pool, input: BulkCreateBanksInput): Promise<BulkBanksResultDto> {
  assertRoles(ctx, WRITERS);
  return withTx(pool, async (c) => {
    const existing = await queryRows<{ name: string }>(c, 'SELECT name FROM banks WHERE office_id = $1', [ctx.officeId]);
    const { fresh, skipped } = splitNew(input.items.map((i) => ({ name: i.name, code: i.code ?? null })), existing.map((e) => e.name));
    let items: BankDto[] = [];
    if (fresh.length > 0) {
      items = await queryRows<BankDto>(c,
        `INSERT INTO banks (office_id, name, code)
         SELECT $1::int, t.n, t.c FROM unnest($2::text[], $3::text[]) AS t(n, c)
         ON CONFLICT (office_id, name) DO NOTHING RETURNING id, name, code`,
        [ctx.officeId, fresh.map((f) => f.name), fresh.map((f) => f.code)]);
      for (const b of items) {
        await writeAudit(c, { officeId: ctx.officeId, userId: ctx.userId, entityType: 'bank', entityId: b.id, action: 'create', after: { name: b.name, code: b.code, source: 'bulk' } });
      }
    }
    return { created: items.length, items, skipped };
  });
}

export async function bulkCreateRouteGroups(ctx: TenantContext, pool: pg.Pool, input: BulkCreateRouteGroupsInput): Promise<BulkRoutesResultDto> {
  assertRoles(ctx, WRITERS);
  return withTx(pool, async (c) => {
    const existing = await queryRows<{ name: string }>(c, 'SELECT name FROM route_groups WHERE office_id = $1', [ctx.officeId]);
    const { fresh, skipped } = splitNew(input.names.map((n) => ({ name: n, code: null })), existing.map((e) => e.name));
    let items: RouteGroupDto[] = [];
    if (fresh.length > 0) {
      items = await queryRows<RouteGroupDto>(c,
        `INSERT INTO route_groups (office_id, name) SELECT $1::int, n FROM unnest($2::text[]) AS n
         ON CONFLICT (office_id, name) DO NOTHING RETURNING id, name`,
        [ctx.officeId, fresh.map((f) => f.name)]);
      for (const r of items) {
        await writeAudit(c, { officeId: ctx.officeId, userId: ctx.userId, entityType: 'route_group', entityId: r.id, action: 'create', after: { name: r.name, source: 'bulk' } });
      }
    }
    return { created: items.length, items, skipped };
  });
}
