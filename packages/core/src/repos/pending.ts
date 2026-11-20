import type pg from 'pg';
import { z } from 'zod';
import {
  buildTerminalSearchNorm, escapeLike, normalizeSearchText, todayInTehran,
  type AssignPendingInput, type AssignPendingResultDto, type DismissPendingInput, type Page, type PendingListQuery,
  type PendingSummaryDto, type PendingTerminalDto,
} from '@pos/shared';
import { writeAudit } from '../audit/audit';
import { SqlParams } from '../db/sql';
import { queryOne, queryRows, withTx, type Queryable } from '../db/types';
import { HttpError } from '../errors';
import { decodeCursor, encodeCursor } from '../pagination';
import { adoptPendingRows } from '../pending/adopt';
import { assertRoles, type TenantContext, type TenantRole } from '../tenant/scope';
import { DEFAULT_HISTORY_START } from './terminals';

const ROLES: readonly TenantRole[] = ['office_manager', 'data_admin'];
const cursorSchema = z.object({ no: z.string().min(1).max(40) });

const COLS = `p.terminal_no AS "terminalNo", p.shop_name AS "shopName", p.owner_name AS "ownerName", p.phone, p.address,
  p.bank_name AS "bankName", p.status, p.has_activity AS "hasActivity", p.last_as_of_date AS "lastAsOfDate",
  p.last_amount AS "lastAmount", p.last_total_amount AS "lastTotalAmount", p.last_tx_count AS "lastTxCount",
  p.first_seen_at AS "firstSeenAt", p.last_seen_at AS "lastSeenAt", p.last_batch_id AS "lastBatchId",
  (SELECT b.id FROM banks b WHERE b.office_id = p.office_id AND p.bank_name IS NOT NULL
      AND fa_normalize(b.name) = fa_normalize(p.bank_name) ORDER BY b.id LIMIT 1) AS "matchedBankId"`;

/** ترمینال‌های موجود در فایل تراکنش که در دیتابیس تعریف نشده‌اند (برای تعیین پشتیبان) */
export async function listPendingTerminals(ctx: TenantContext, db: Queryable, q: PendingListQuery): Promise<Page<PendingTerminalDto>> {
  assertRoles(ctx, ROLES);
  const p = new SqlParams();
  const where = [`p.office_id = ${p.add(ctx.officeId)}`, `p.status = ${p.add(q.status)}`];
  if (q.activeOnly) where.push('p.has_activity');
  if (q.cursor) where.push(`p.terminal_no > ${p.add(decodeCursor(q.cursor, cursorSchema).no)}`);
  if (q.q) {
    const norm = normalizeSearchText(q.q);
    if (norm) where.push(`fa_normalize(concat_ws(' ', p.terminal_no, p.shop_name, p.owner_name)) ILIKE ${p.add(`%${escapeLike(norm)}%`)}`);
  }
  const rows = await queryRows<PendingTerminalDto>(db,
    `SELECT ${COLS} FROM pending_terminals p WHERE ${where.join(' AND ')} ORDER BY p.terminal_no LIMIT ${p.add(q.limit + 1)}`, p.values);
  let nextCursor: string | null = null;
  if (rows.length > q.limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor({ no: last.terminalNo });
  }
  return { items: rows, nextCursor };
}

export async function getPendingSummary(ctx: TenantContext, db: Queryable): Promise<PendingSummaryDto> {
  assertRoles(ctx, ROLES);
  const r = await queryOne<PendingSummaryDto>(db,
    `SELECT (count(*) FILTER (WHERE status = 'pending'))::int AS pending,
            (count(*) FILTER (WHERE status = 'pending' AND has_activity))::int AS "pendingActive",
            (count(*) FILTER (WHERE status = 'dismissed'))::int AS dismissed
       FROM pending_terminals WHERE office_id = $1`, [ctx.officeId]);
  return r ?? { pending: 0, pendingActive: 0, dismissed: 0 };
}

export async function dismissPendingTerminals(ctx: TenantContext, db: Queryable, input: DismissPendingInput): Promise<{ changed: number }> {
  assertRoles(ctx, ROLES);
  const r = await db.query(
    `UPDATE pending_terminals SET status = $3::text WHERE office_id = $1 AND terminal_no = ANY($2::text[]) AND status = $4::text`,
    [ctx.officeId, input.terminalNos, input.dismissed ? 'dismissed' : 'pending', input.dismissed ? 'pending' : 'dismissed']);
  return { changed: r.rowCount ?? 0 };
}

interface PendingRow {
  terminalNo: string; shopName: string | null; ownerName: string | null; phone: string | null;
  address: string | null; bankName: string | null;
}

/**
 * تعیین پشتیبان برای ترمینال‌های تعریف‌نشده: ترمینال با اطلاعات فایل ساخته می‌شود (تاریخچه از ۲۰۰۰-۰۱-۰۱ تا ماه‌های قبلِ
 * فایل هم پشتیبان داشته باشند) و ردیف‌های تراکنش نگه‌داشته‌شده وارد آمار می‌شوند. همه یا هیچ.
 * بانک: اگر bankId داده شود همان، اگر null باشد بدون بانک، وگرنه از روی نام بانک فایل (ساخت خودکار طبق تنظیم دفتر).
 */
export async function assignPendingTerminals(ctx: TenantContext, pool: pg.Pool, input: AssignPendingInput): Promise<AssignPendingResultDto> {
  assertRoles(ctx, ROLES);
  return withTx(pool, async (c) => {
    const sup = await queryOne<{ unitId: number }>(c,
      `SELECT staff_unit_id AS "unitId" FROM supporters WHERE office_id = $1 AND id = $2 AND is_active`, [ctx.officeId, input.supporterId]);
    if (!sup) throw new HttpError(422, 'INVALID_SUPPORTER', 'پشتیبان نامعتبر یا غیرفعال است');
    if (input.routeGroupId) {
      if (!(await queryOne(c, 'SELECT 1 AS x FROM route_groups WHERE office_id = $1 AND id = $2', [ctx.officeId, input.routeGroupId]))) {
        throw new HttpError(422, 'INVALID_ROUTE', 'مسیر نامعتبر است');
      }
    }
    if (input.bankId) {
      if (!(await queryOne(c, 'SELECT 1 AS x FROM banks WHERE office_id = $1 AND id = $2', [ctx.officeId, input.bankId]))) {
        throw new HttpError(422, 'INVALID_BANK', 'بانک نامعتبر است');
      }
    }
    const createBanks = (await queryOne<{ v: boolean }>(c, 'SELECT sync_create_banks AS v FROM office_settings WHERE office_id = $1', [ctx.officeId]))?.v ?? true;

    const rows = await queryRows<PendingRow>(c,
      `SELECT terminal_no AS "terminalNo", shop_name AS "shopName", owner_name AS "ownerName", phone, address, bank_name AS "bankName"
         FROM pending_terminals WHERE office_id = $1 AND terminal_no = ANY($2::text[]) AND status = 'pending' ORDER BY terminal_no FOR UPDATE`,
      [ctx.officeId, input.terminalNos]);
    const found = new Set(rows.map((r) => r.terminalNo));
    const skipped: AssignPendingResultDto['skipped'] = input.terminalNos
      .filter((n) => !found.has(n)).map((n) => ({ terminalNo: n, reason: 'در فهرست تعریف‌نشده‌ها نیست (قبلاً تعیین شده یا نادیده گرفته شده)' }));

    const banks = new Map<string, number>();
    for (const b of await queryRows<{ id: number; name: string }>(c, 'SELECT id, name FROM banks WHERE office_id = $1 ORDER BY id DESC', [ctx.officeId])) {
      banks.set(normalizeSearchText(b.name), b.id);
    }
    let banksCreated = 0;
    const resolveBank = async (name: string | null): Promise<number | null> => {
      if (input.bankId !== undefined) return input.bankId;
      if (!name) return null;
      const key = normalizeSearchText(name);
      const hit = banks.get(key);
      if (hit !== undefined) return hit;
      if (!createBanks) return null;
      const nb = await queryOne<{ id: number }>(c,
        `INSERT INTO banks (office_id, name) VALUES ($1, $2) ON CONFLICT (office_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [ctx.officeId, name]);
      const id = (nb as { id: number }).id;
      banks.set(key, id);
      banksCreated += 1;
      await writeAudit(c, { officeId: ctx.officeId, userId: ctx.userId, entityType: 'bank', entityId: id, action: 'create', after: { name, source: 'pending_assignment' } });
      return id;
    };

    const created: string[] = [];
    for (const r of rows) {
      if (await queryOne(c, 'SELECT 1 AS x FROM terminals WHERE office_id = $1 AND terminal_no = $2', [ctx.officeId, r.terminalNo])) {
        skipped.push({ terminalNo: r.terminalNo, reason: 'این ترمینال از قبل در سامانه تعریف شده است' });
        continue;
      }
      const bankId = await resolveBank(r.bankName);
      const ins = await queryOne<{ id: number }>(c,
        `INSERT INTO terminals (office_id, terminal_no, owner_name, phone, address, shop_name, route_group_id, bank_id,
                                current_supporter_id, current_unit_id, search_norm, info_as_of)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(SELECT last_as_of_date FROM pending_terminals WHERE office_id = $1 AND terminal_no = $2)) RETURNING id`,
        [ctx.officeId, r.terminalNo, r.ownerName, r.phone, r.address, r.shopName, input.routeGroupId ?? null, bankId,
         input.supporterId, sup.unitId, buildTerminalSearchNorm({ terminalNo: r.terminalNo, shopName: r.shopName, ownerName: r.ownerName })]);
      const id = (ins as { id: number }).id;
      await c.query(
        `INSERT INTO terminal_supporter_history (office_id, terminal_id, supporter_id, staff_unit_id, route_group_id, bank_id, start_date, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ctx.officeId, id, input.supporterId, sup.unitId, input.routeGroupId ?? 0, bankId ?? 0, DEFAULT_HISTORY_START, ctx.userId]);
      await c.query(
        `INSERT INTO recompute_outbox (office_id, terminal_id, effective_date, reason) VALUES ($1,$2,$3,'import')`,
        [ctx.officeId, id, todayInTehran()]);
      await writeAudit(c, {
        officeId: ctx.officeId, userId: ctx.userId, entityType: 'terminal', entityId: id, action: 'create',
        after: { terminalNo: r.terminalNo, supporterId: input.supporterId, unitId: sup.unitId, routeGroupId: input.routeGroupId ?? null,
                 bankId, shopName: r.shopName, ownerName: r.ownerName, source: 'pending_terminals' },
      });
      created.push(r.terminalNo);
    }

    let adopted = { resolved: 0, snapshots: 0 };
    if (created.length > 0) {
      adopted = await adoptPendingRows(c, ctx.officeId, ctx.userId, created);
      await c.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [ctx.officeId]);
    }
    return { created: created.length, snapshotsAdopted: adopted.snapshots, banksCreated, skipped };
  });
}

