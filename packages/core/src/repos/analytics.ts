import {
  periodIdOfDate, pctChange, prevPeriodId, projectMonth, sameMonthLastYear, shiftPeriod,
  type AnalyticsFilterInput, type BankShareDto, type ChangeDto, type CoverageDto, type CurvePoint, type DailyDeltaDto,
  type DrillTerminalDto, type DroppedTerminalDto, type GrowthItemDto, type HeatmapDto, type KpiDto, type Page,
  type PeriodMetrics, type PreliminaryAlertDto, type ProjectionDto, type TerminalMonthDto,
} from '@pos/shared';
import { z } from 'zod';
import { SqlParams } from '../db/sql';
import { queryOne, queryRows, type Queryable } from '../db/types';
import { HttpError } from '../errors';
import { decodeCursor, encodeCursor } from '../pagination';
import { assertRoles, scopeWhere, type TenantContext, type TenantRole } from '../tenant/scope';
import { getTerminal } from './terminals';

/**
 * همه‌ی کوئری‌های داشبورد روی جدول‌های تجمیع‌شده (agg_*، fact_*) و بدون JOIN تاریخچه‌ی پشتیبان اجرا می‌شوند؛
 * تنها استثنا drill-down روزانه‌ی یک ترمینال (بازه‌ی کوتاه از جدول خام) است.
 * دامنه‌ی نقش فقط از scopeWhere می‌آید. هر statement پارامترهای خودش را دارد (پارامتر بلااستفاده در PG خطا می‌دهد).
 */
const READERS: readonly TenantRole[] = ['office_manager', 'data_admin', 'unit_head', 'supporter'];

export interface ResolvedFilter {
  from: number;
  to: number;
  /** دوره‌ی تکی برای گزارش‌هایی که یک ماه را نشان می‌دهند */
  period: number;
  unitIds?: number[] | undefined;
  supporterIds?: number[] | undefined;
  routeIds?: number[] | undefined;
  bankIds?: number[] | undefined;
}

const MAX_RANGE = 60;

async function latestPeriod(db: Queryable, officeId: number): Promise<number> {
  const r = await queryOne<{ p: number | null }>(db, 'SELECT max(period_id) AS p FROM agg_office_month WHERE office_id = $1', [officeId]);
  if (!r || r.p === null) throw new HttpError(404, 'NO_DATA', 'هنوز داده‌ای تجمیع نشده است');
  return r.p;
}

/** فیلتر ورودی ← بازه و دوره‌ی قطعی (پیش‌فرض: ۱۲ ماه منتهی به آخرین ماه دارای داده) */
export async function resolveFilter(
  ctx: TenantContext, db: Queryable, f: AnalyticsFilterInput & { period?: number | undefined },
): Promise<ResolvedFilter> {
  assertRoles(ctx, READERS);
  const to = f.to ?? f.period ?? (await latestPeriod(db, ctx.officeId));
  const from = f.from ?? shiftPeriod(to, -11);
  if (from > to) throw new HttpError(400, 'INVALID_RANGE', 'ابتدای بازه بعد از انتهای آن است');
  if (shiftPeriod(from, MAX_RANGE) <= to) throw new HttpError(400, 'RANGE_TOO_LONG', `حداکثر ${MAX_RANGE} ماه`);
  return { from, to, period: f.period ?? to, unitIds: f.unitId, supporterIds: f.supporterId, routeIds: f.routeGroupId, bankIds: f.bankId };
}

type AggTable = 'agg_supporter_month' | 'agg_unit_month' | 'agg_office_month';
interface AggQuery { table: AggTable; where: string[]; p: SqlParams }

/** کوئری‌روتر: پایین‌ترین سطح تجمیعی که فیلترها و نقش به آن نیاز دارند */
function aggQuery(ctx: TenantContext, f: ResolvedFilter, force?: 'supporter' | 'unit'): AggQuery {
  const p = new SqlParams();
  const useSupporter = ctx.role === 'supporter' || force === 'supporter' || (f.supporterIds?.length ?? 0) > 0;
  const useUnit = !useSupporter && (ctx.role === 'unit_head' || force === 'unit' || (f.unitIds?.length ?? 0) > 0);
  const table: AggTable = useSupporter ? 'agg_supporter_month' : useUnit ? 'agg_unit_month' : 'agg_office_month';
  const where = scopeWhere(ctx, p, useSupporter
    ? { office: 'a.office_id', unit: 'a.staff_unit_id', supporter: 'a.supporter_id' }
    : useUnit ? { office: 'a.office_id', unit: 'a.staff_unit_id' } : { office: 'a.office_id' });
  if (f.unitIds && table !== 'agg_office_month') where.push(`a.staff_unit_id = ANY(${p.add(f.unitIds)}::int[])`);
  if (f.supporterIds && table === 'agg_supporter_month') where.push(`a.supporter_id = ANY(${p.add(f.supporterIds)}::int[])`);
  if (f.routeIds) where.push(`a.route_group_id = ANY(${p.add(f.routeIds)}::int[])`);
  if (f.bankIds) where.push(`a.bank_id = ANY(${p.add(f.bankIds)}::int[])`);
  return { table, where, p };
}

const METRICS = `sum(a.amount)::bigint AS amount, sum(a.tx_count)::bigint AS "txCount",
  sum(a.active_terminals)::int AS "activeTerminals", sum(a.low_terminals)::int AS "lowTerminals",
  sum(a.returned_terminals)::int AS "returnedTerminals", sum(a.new_terminals)::int AS "newTerminals",
  sum(a.incomplete_terminals)::int AS "incompleteTerminals"`;

type MetricsRow = Omit<PeriodMetrics, 'totalTerminals' | 'isComplete'>;
const toMetrics = (r: MetricsRow): PeriodMetrics => ({
  ...r,
  totalTerminals: r.activeTerminals + r.lowTerminals + r.newTerminals,
  isComplete: r.incompleteTerminals === 0,
});

async function periodMetrics(ctx: TenantContext, db: Queryable, f: ResolvedFilter, periods: number[]): Promise<Map<number, PeriodMetrics>> {
  const q = aggQuery(ctx, f);
  q.where.push(`a.period_id = ANY(${q.p.add(periods)}::int[])`);
  const rows = await queryRows<MetricsRow>(db,
    `SELECT a.period_id AS "periodId", ${METRICS} FROM ${q.table} a WHERE ${q.where.join(' AND ')} GROUP BY a.period_id ORDER BY a.period_id`, q.p.values);
  return new Map(rows.map((r) => [r.periodId, toMetrics(r)]));
}

interface ProjectionContext { asOfDate: string; daysCovered: number; daysInMonth: number; curve: CurvePoint[] | null }

/** پوشش فایل‌های یک ماه (سطح دفتر) + منحنی تاریخی اگر وجود داشته باشد */
async function projectionContext(db: Queryable, officeId: number, periodId: number): Promise<ProjectionContext | null> {
  const r = await queryOne<{ asOf: string | null; days: number; covered: number | null }>(db,
    `SELECT max(f.last_as_of_date)::text AS "asOf", (p.end_date - p.start_date)::int AS days,
            (max(f.last_as_of_date) - p.start_date + 1)::int AS covered
       FROM periods p LEFT JOIN fact_terminal_month f ON f.office_id = $1 AND f.period_id = p.period_id
      WHERE p.period_id = $2 GROUP BY p.start_date, p.end_date`, [officeId, periodId]);
  if (!r || !r.asOf || r.covered === null) return null;
  const curve = await queryRows<CurvePoint>(db,
    'SELECT day_of_month AS day, share FROM month_progress_curve WHERE office_id = $1 ORDER BY day_of_month', [officeId]);
  return { asOfDate: r.asOf, daysCovered: r.covered, daysInMonth: r.days, curve: curve.length === 31 ? curve : null };
}

// ------------------------------------------------------------------ KPI و روند

export async function getKpi(ctx: TenantContext, db: Queryable, f: ResolvedFilter, today: string): Promise<KpiDto> {
  void today; // «امروز» فقط در کلید کش لازم است؛ پوشش از آخرین تاریخ فایل می‌آید
  const t = aggQuery(ctx, f);
  t.where.push(`a.period_id BETWEEN ${t.p.add(f.from)} AND ${t.p.add(f.to)}`);
  const totals = await queryOne<{ amount: number; txCount: number }>(db,
    `SELECT COALESCE(sum(a.amount), 0)::bigint AS amount, COALESCE(sum(a.tx_count), 0)::bigint AS "txCount"
       FROM ${t.table} a WHERE ${t.where.join(' AND ')}`, t.p.values);

  const cur = f.to;
  const prevId = prevPeriodId(cur);
  const yaId = sameMonthLastYear(cur);
  const m = await periodMetrics(ctx, db, f, [cur, prevId, yaId]);
  const current = m.get(cur) ?? null;
  const previous = m.get(prevId) ?? null;
  const yearAgo = m.get(yaId) ?? null;

  // ماه ناقص با ماه کامل مقایسه نمی‌شود: پیش‌بینی پایان ماه جایگزین می‌شود
  let projection: ProjectionDto | null = null;
  if (current && !current.isComplete) {
    const pc = await projectionContext(db, ctx.officeId, cur);
    if (pc) {
      const r = projectMonth({ amount: current.amount, txCount: current.txCount, daysCovered: pc.daysCovered, daysInMonth: pc.daysInMonth, curve: pc.curve });
      if (r.method !== 'none') {
        projection = {
          method: r.method, daysCovered: pc.daysCovered, daysInMonth: pc.daysInMonth, asOfDate: pc.asOfDate,
          projectedAmount: r.amount, projectedTxCount: r.txCount,
        };
      }
    }
  }
  const change = (base: PeriodMetrics | null): ChangeDto =>
    projection
      ? { basis: 'projected', amountPct: pctChange(projection.projectedAmount, base?.amount), txCountPct: pctChange(projection.projectedTxCount, base?.txCount), activeTerminalsPct: null }
      : { basis: 'actual', amountPct: pctChange(current?.amount, base?.amount), txCountPct: pctChange(current?.txCount, base?.txCount), activeTerminalsPct: pctChange(current?.activeTerminals, base?.activeTerminals) };

  return {
    range: { from: f.from, to: f.to },
    totals: totals ?? { amount: 0, txCount: 0 },
    current, previous, yearAgo, projection, mom: change(previous), yoy: change(yearAgo),
  };
}

export async function getTrend(ctx: TenantContext, db: Queryable, f: ResolvedFilter): Promise<PeriodMetrics[]> {
  const q = aggQuery(ctx, f);
  q.where.push(`a.period_id BETWEEN ${q.p.add(f.from)} AND ${q.p.add(f.to)}`);
  const rows = await queryRows<MetricsRow>(db,
    `SELECT a.period_id AS "periodId", ${METRICS} FROM ${q.table} a WHERE ${q.where.join(' AND ')} GROUP BY a.period_id ORDER BY a.period_id`, q.p.values);
  return rows.map(toMetrics);
}

export async function getBankShare(ctx: TenantContext, db: Queryable, f: ResolvedFilter): Promise<BankShareDto[]> {
  const q = aggQuery(ctx, f);
  q.where.push(`a.period_id = ${q.p.add(f.period)}`);
  const rows = await queryRows<Omit<BankShareDto, 'sharePct'>>(db,
    `SELECT a.bank_id AS "bankId", COALESCE(b.name, 'نامشخص') AS name, sum(a.amount)::bigint AS amount,
            sum(a.tx_count)::bigint AS "txCount", sum(a.active_terminals + a.low_terminals + a.new_terminals)::int AS terminals
       FROM ${q.table} a LEFT JOIN banks b ON b.office_id = a.office_id AND b.id = a.bank_id
      WHERE ${q.where.join(' AND ')} GROUP BY a.bank_id, b.name ORDER BY amount DESC, a.bank_id`, q.p.values);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return rows.map((r) => ({ ...r, sharePct: total > 0 ? Math.round((r.amount / total) * 10_000) / 100 : 0 }));
}

// ------------------------------------------------------------------ رشد/افت و drill-down سطوح بالا

export type GrowthBy = 'supporter' | 'route' | 'unit';

/** رشد/افت هر پشتیبان، ستاد یا مسیر در یک ماه نسبت به ماه قبل و همان ماه سال قبل. drill-down نیز با همین تابع است. */
export async function getGrowth(
  ctx: TenantContext, db: Queryable, f: ResolvedFilter, by: GrowthBy, sort: 'amount_desc' | 'pct_desc' | 'pct_asc' = 'amount_desc',
): Promise<GrowthItemDto[]> {
  const cfg = by === 'supporter'
    ? { force: 'supporter' as const, id: 'a.supporter_id', join: 'LEFT JOIN supporters e ON e.office_id = a.office_id AND e.id = a.supporter_id', name: 'e.full_name', extra: ', e.staff_unit_id AS "unitId"', group: ', e.full_name, e.staff_unit_id' }
    : by === 'unit'
      ? { force: 'unit' as const, id: 'a.staff_unit_id', join: 'LEFT JOIN staff_units e ON e.office_id = a.office_id AND e.id = a.staff_unit_id', name: 'e.name', extra: '', group: ', e.name' }
      : { force: undefined, id: 'a.route_group_id', join: 'LEFT JOIN route_groups e ON e.office_id = a.office_id AND e.id = a.route_group_id', name: 'e.name', extra: '', group: ', e.name' };
  const q = aggQuery(ctx, f, cfg.force);
  const cur = q.p.add(f.period);
  const prev = q.p.add(prevPeriodId(f.period));
  const ya = q.p.add(sameMonthLastYear(f.period));
  q.where.push(`a.period_id IN (${cur}, ${prev}, ${ya})`);
  const rows = await queryRows<{
    id: number; name: string; unitId?: number; cur: number | null; prev: number | null; ya: number | null; active: number | null; incomplete: number | null;
  }>(db,
    `SELECT ${cfg.id} AS id, COALESCE(${cfg.name}, 'نامشخص') AS name${cfg.extra},
            (sum(a.amount) FILTER (WHERE a.period_id = ${cur}))::bigint AS cur,
            (sum(a.amount) FILTER (WHERE a.period_id = ${prev}))::bigint AS prev,
            (sum(a.amount) FILTER (WHERE a.period_id = ${ya}))::bigint AS ya,
            (sum(a.active_terminals) FILTER (WHERE a.period_id = ${cur}))::int AS active,
            (sum(a.incomplete_terminals) FILTER (WHERE a.period_id = ${cur}))::int AS incomplete
       FROM ${q.table} a ${cfg.join} WHERE ${q.where.join(' AND ')} GROUP BY ${cfg.id}${cfg.group}`, q.p.values);

  const total = rows.reduce((s, r) => s + (r.cur ?? 0), 0);
  const items: GrowthItemDto[] = rows.map((r) => {
    const amount = r.cur ?? 0;
    return {
      id: r.id, name: r.name, ...(r.unitId !== undefined ? { unitId: r.unitId } : {}),
      amount, previous: r.prev ?? 0, yearAgo: r.ya ?? 0,
      momPct: pctChange(r.cur === null ? null : amount, r.prev), yoyPct: pctChange(r.cur === null ? null : amount, r.ya),
      sharePct: total > 0 ? Math.round((amount / total) * 10_000) / 100 : 0,
      activeTerminals: r.active ?? 0, incompleteTerminals: r.incomplete ?? 0,
    };
  }).filter((r) => r.amount > 0 || r.previous > 0 || r.yearAgo > 0);

  const pctKey = (x: GrowthItemDto): number | null => x.momPct;
  items.sort((a, b) => {
    if (sort === 'amount_desc') return b.amount - a.amount || a.id - b.id;
    const pa = pctKey(a), pb = pctKey(b);
    if (pa === null && pb === null) return a.id - b.id;
    if (pa === null) return 1; // بدون مبنا همیشه آخر
    if (pb === null) return -1;
    return (sort === 'pct_desc' ? pb - pa : pa - pb) || a.id - b.id;
  });
  return items;
}

export async function getHeatmap(
  ctx: TenantContext, db: Queryable, f: ResolvedFilter, metric: 'amount' | 'txCount' | 'active',
): Promise<HeatmapDto> {
  const expr = metric === 'amount' ? 'sum(a.amount)' : metric === 'txCount' ? 'sum(a.tx_count)' : 'sum(a.active_terminals)';
  const q = aggQuery(ctx, f, 'supporter');
  q.where.push(`a.period_id BETWEEN ${q.p.add(f.from)} AND ${q.p.add(f.to)}`);
  const rows = await queryRows<{ id: number; name: string; unitId: number; period: number; v: number }>(db,
    `SELECT a.supporter_id AS id, COALESCE(s.full_name, 'نامشخص') AS name, COALESCE(s.staff_unit_id, 0) AS "unitId",
            a.period_id AS period, (${expr})::bigint AS v
       FROM agg_supporter_month a LEFT JOIN supporters s ON s.office_id = a.office_id AND s.id = a.supporter_id
      WHERE ${q.where.join(' AND ')} GROUP BY a.supporter_id, s.full_name, s.staff_unit_id, a.period_id`, q.p.values);
  const periods: number[] = [];
  for (let p = f.from; p <= f.to; p = shiftPeriod(p, 1)) periods.push(p);
  const index = new Map(periods.map((p, i) => [p, i]));
  const bySup = new Map<number, HeatmapDto['rows'][number]>();
  for (const r of rows) {
    let row = bySup.get(r.id);
    if (!row) {
      row = { supporterId: r.id, name: r.name, unitId: r.unitId, values: periods.map(() => 0) };
      bySup.set(r.id, row);
    }
    const i = index.get(r.period);
    if (i !== undefined) row.values[i] = r.v;
  }
  return { metric, periods, rows: [...bySup.values()].sort((a, b) => a.name.localeCompare(b.name, 'fa') || a.supporterId - b.supporterId) };
}

// ------------------------------------------------------------------ سطح ترمینال

const amountCursor = z.object({ a: z.number(), id: z.number().int() });
const idCursor = z.object({ id: z.number().int() });

/** ترمینال‌های یک ماه (از fact) با مقایسه‌ی ماه قبل؛ cursor pagination روی id یا (مبلغ، id) */
export async function getDrilldownTerminals(
  ctx: TenantContext, db: Queryable, f: ResolvedFilter, order: 'id' | 'amount_desc', page: { cursor?: string | undefined; limit: number },
): Promise<Page<DrillTerminalDto>> {
  assertRoles(ctx, READERS);
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 'f.office_id', unit: 'f.staff_unit_id', supporter: 'f.supporter_id' });
  where.push(`f.period_id = ${p.add(f.period)}`);
  if (f.unitIds) where.push(`f.staff_unit_id = ANY(${p.add(f.unitIds)}::int[])`);
  if (f.supporterIds) where.push(`f.supporter_id = ANY(${p.add(f.supporterIds)}::int[])`);
  if (f.routeIds) where.push(`f.route_group_id = ANY(${p.add(f.routeIds)}::int[])`);
  if (f.bankIds) where.push(`f.bank_id = ANY(${p.add(f.bankIds)}::int[])`);
  if (page.cursor) {
    if (order === 'id') where.push(`f.terminal_id > ${p.add(decodeCursor(page.cursor, idCursor).id)}`);
    else {
      const c = decodeCursor(page.cursor, amountCursor);
      where.push(`(f.amount, f.terminal_id) < (${p.add(c.a)}::bigint, ${p.add(c.id)}::bigint)`);
    }
  }
  const prev = p.add(prevPeriodId(f.period));
  const orderBy = order === 'id' ? 'f.terminal_id' : 'f.amount DESC, f.terminal_id DESC';
  const rows = await queryRows<Omit<DrillTerminalDto, 'changePct'>>(db,
    `SELECT f.terminal_id AS id, t.terminal_no AS "terminalNo", t.shop_name AS "shopName", f.amount, f.tx_count AS "txCount",
            f.activity_class AS "activityClass", f.is_complete AS "isComplete", f.supporter_id AS "supporterId",
            f.route_group_id AS "routeGroupId", f.bank_id AS "bankId", pf.amount AS "previousAmount"
       FROM fact_terminal_month f
       JOIN terminals t ON t.office_id = f.office_id AND t.id = f.terminal_id
       LEFT JOIN fact_terminal_month pf ON pf.office_id = f.office_id AND pf.period_id = ${prev} AND pf.terminal_id = f.terminal_id
      WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ${p.add(page.limit + 1)}`, p.values);
  let nextCursor: string | null = null;
  if (rows.length > page.limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor(order === 'id' ? { id: last.id } : { a: last.amount, id: last.id });
  }
  return { items: rows.map((r) => ({ ...r, changePct: pctChange(r.amount, r.previousAmount) })), nextCursor };
}

/** سری ماهانه‌ی یک ترمینال از fact (نه جدول خام) */
export async function getTerminalMonthly(ctx: TenantContext, db: Queryable, terminalId: number): Promise<TerminalMonthDto[]> {
  await getTerminal(ctx, db, terminalId); // کنترل دسترسی
  return queryRows(db,
    `SELECT period_id AS "periodId", amount, tx_count AS "txCount", total_amount AS "totalAmount", total_tx_count AS "totalTxCount",
            activity_class AS "activityClass", is_complete AS "isComplete",
            last_as_of_date AS "lastAsOfDate", supporter_id AS "supporterId", staff_unit_id AS "unitId",
            route_group_id AS "routeGroupId", bank_id AS "bankId"
       FROM fact_terminal_month WHERE office_id = $1 AND terminal_id = $2 ORDER BY period_id`, [ctx.officeId, terminalId]);
}

const DAY_MS = 86_400_000;
/**
 * مقدار واقعی هر روز = اختلاف دو snapshot متوالی همان ماه شمسی (استثنای «فقط جدول خام» با بازه‌ی حداکثر ۹۲ روز).
 * اگر بین دو فایل چند روز فاصله باشد spanDays > 1 و estimated=true است: مقدار مربوط به کل فاصله است نه یک روز.
 */
export async function getDailyDeltas(
  ctx: TenantContext, db: Queryable, terminalId: number, from: string, to: string,
): Promise<DailyDeltaDto[]> {
  await getTerminal(ctx, db, terminalId);
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
  if (!(days >= 0) || days > 92) throw new HttpError(400, 'INVALID_RANGE', 'بازه باید بین ۰ تا ۹۲ روز باشد');
  const rows = await queryRows<Omit<DailyDeltaDto, 'estimated'>>(db,
    `SELECT * FROM (
       SELECT s.as_of_date AS "asOfDate",
              (s.cum_amount - COALESCE(lag(s.cum_amount) OVER w, 0))::bigint AS "deltaAmount",
              (s.cum_count - COALESCE(lag(s.cum_count) OVER w, 0))::int AS "deltaCount",
              (s.as_of_date - COALESCE(lag(s.as_of_date) OVER w, p.start_date - 1))::int AS "spanDays"
         FROM transactions_snapshot s
         JOIN periods p ON s.as_of_date >= p.start_date AND s.as_of_date < p.end_date
        WHERE s.office_id = $1 AND s.terminal_id = $2
          AND s.as_of_date >= (SELECT start_date FROM periods WHERE $3::date >= start_date AND $3::date < end_date)
          AND s.as_of_date <= $4::date
       WINDOW w AS (PARTITION BY p.period_id ORDER BY s.as_of_date)) x
      WHERE x."asOfDate" >= $3::date ORDER BY x."asOfDate"`, [ctx.officeId, terminalId, from, to]);
  return rows.map((r) => ({ ...r, estimated: r.spanDays > 1 }));
}

// ------------------------------------------------------------------ هشدارها و پوشش

const dropCursor = z.object({ d: z.string().regex(/^-?\d+(\.\d+)?$/), id: z.number().int() });

/** هشدار قطعی افت (فقط ماه‌های کامل) از terminal_alerts */
export async function listDroppedTerminals(
  ctx: TenantContext, db: Queryable, f: ResolvedFilter, page: { cursor?: string | undefined; limit: number },
): Promise<Page<DroppedTerminalDto>> {
  assertRoles(ctx, READERS);
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 'a.office_id', unit: 'a.staff_unit_id', supporter: 'a.supporter_id' });
  where.push(`a.period_id = ${p.add(f.period)}`);
  if (f.unitIds) where.push(`a.staff_unit_id = ANY(${p.add(f.unitIds)}::int[])`);
  if (f.supporterIds) where.push(`a.supporter_id = ANY(${p.add(f.supporterIds)}::int[])`);
  if (f.routeIds || f.bankIds) {
    const extra: string[] = [];
    if (f.routeIds) extra.push(`x.route_group_id = ANY(${p.add(f.routeIds)}::int[])`);
    if (f.bankIds) extra.push(`x.bank_id = ANY(${p.add(f.bankIds)}::int[])`);
    where.push(`EXISTS (SELECT 1 FROM fact_terminal_month x WHERE x.office_id = a.office_id AND x.period_id = a.period_id
                          AND x.terminal_id = a.terminal_id AND ${extra.join(' AND ')})`);
  }
  if (page.cursor) {
    const c = decodeCursor(page.cursor, dropCursor);
    where.push(`(a.drop_pct, a.terminal_id) < (${p.add(c.d)}::numeric, ${p.add(c.id)}::bigint)`);
  }
  const rows = await queryRows<DroppedTerminalDto & { dropText: string }>(db,
    `SELECT a.terminal_id AS id, t.terminal_no AS "terminalNo", t.shop_name AS "shopName", a.supporter_id AS "supporterId",
            a.staff_unit_id AS "unitId", a.avg3_amount AS "avg3Amount", a.cur_amount AS "currentAmount",
            a.drop_pct::float8 AS "dropPct", a.drop_pct::text AS "dropText"
       FROM terminal_alerts a JOIN terminals t ON t.office_id = a.office_id AND t.id = a.terminal_id
      WHERE ${where.join(' AND ')} ORDER BY a.drop_pct DESC, a.terminal_id DESC LIMIT ${p.add(page.limit + 1)}`, p.values);
  let nextCursor: string | null = null;
  if (rows.length > page.limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor({ d: last.dropText, id: last.id });
  }
  return { items: rows.map(({ dropText: _d, ...r }) => r), nextCursor };
}

export interface PreliminaryAlertsDto extends Page<PreliminaryAlertDto> {
  available: boolean;
  reason?: 'TOO_EARLY' | 'NO_DATA';
  method?: 'curve' | 'linear';
  daysCovered?: number;
}

/**
 * هشدار «مقدماتی» ماه جاری: مبلغ پیش‌بینی‌شده‌ی پایان ماه کمتر از (۱-درصد) × میانگین ۳ ماه کامل قبل.
 * فقط از روز preliminary_alert_min_day (قابل تنظیم) که نوسان اوایل ماه هشدار کاذب نسازد؛ هشدار قطعی بعد از کامل‌شدن ماه است.
 */
export async function listPreliminaryAlerts(
  ctx: TenantContext, db: Queryable, f: ResolvedFilter, today: string, page: { cursor?: string | undefined; limit: number },
): Promise<PreliminaryAlertsDto> {
  assertRoles(ctx, READERS);
  const empty = (reason: 'TOO_EARLY' | 'NO_DATA'): PreliminaryAlertsDto => ({ available: false, reason, items: [], nextCursor: null });
  const settings = await queryOne<{ minDay: number; pct: number }>(db,
    `SELECT preliminary_alert_min_day AS "minDay", drop_alert_threshold_pct AS pct FROM office_settings WHERE office_id = $1`, [ctx.officeId]);
  const periodId = periodIdOfDate(today);
  const pc = await projectionContext(db, ctx.officeId, periodId);
  if (!settings || !pc) return empty('NO_DATA');
  if (pc.daysCovered < settings.minDay) return empty('TOO_EARLY');
  const proj = projectMonth({ amount: 1, txCount: 1, daysCovered: pc.daysCovered, daysInMonth: pc.daysInMonth, curve: pc.curve });
  if (proj.method === 'none') return empty('NO_DATA'); // ماه کامل است؛ هشدار قطعی استفاده شود

  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 'f.office_id', unit: 'f.staff_unit_id', supporter: 'f.supporter_id' });
  const factor = `${p.add(proj.factor)}::numeric`;
  const prevIds = p.add([prevPeriodId(periodId), shiftPeriod(periodId, -2), shiftPeriod(periodId, -3)]);
  const thr = p.add(settings.pct);
  where.push(`f.period_id = ${p.add(periodId)}`, 'NOT f.is_complete', 'f.activity_class <> 3', 'pv.total > 0',
    `f.amount::numeric * ${factor} * 300 < pv.total::numeric * (100 - ${thr}::int)`);
  if (f.unitIds) where.push(`f.staff_unit_id = ANY(${p.add(f.unitIds)}::int[])`);
  if (f.supporterIds) where.push(`f.supporter_id = ANY(${p.add(f.supporterIds)}::int[])`);
  if (f.routeIds) where.push(`f.route_group_id = ANY(${p.add(f.routeIds)}::int[])`);
  if (f.bankIds) where.push(`f.bank_id = ANY(${p.add(f.bankIds)}::int[])`);
  if (page.cursor) where.push(`f.terminal_id > ${p.add(decodeCursor(page.cursor, idCursor).id)}`);

  const rows = await queryRows<PreliminaryAlertDto>(db,
    `SELECT f.terminal_id AS id, t.terminal_no AS "terminalNo", t.shop_name AS "shopName", f.supporter_id AS "supporterId",
            f.staff_unit_id AS "unitId", (pv.total / 3)::bigint AS "avg3Amount", f.amount AS "currentAmount",
            round((1 - 3.0 * f.amount * ${factor} / pv.total) * 100, 2)::float8 AS "dropPct",
            round(f.amount * ${factor})::bigint AS "projectedAmount"
       FROM fact_terminal_month f
       JOIN terminals t ON t.office_id = f.office_id AND t.id = f.terminal_id
       CROSS JOIN LATERAL (SELECT COALESCE(sum(x.amount), 0) AS total FROM fact_terminal_month x
                            WHERE x.office_id = f.office_id AND x.terminal_id = f.terminal_id AND x.period_id = ANY(${prevIds}::int[])) pv
      WHERE ${where.join(' AND ')} ORDER BY f.terminal_id LIMIT ${p.add(page.limit + 1)}`, p.values);
  let nextCursor: string | null = null;
  if (rows.length > page.limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor({ id: last.id });
  }
  return { available: true, method: proj.method, daysCovered: pc.daysCovered, items: rows, nextCursor };
}

/** پوشش فایل‌ها در ۶ ماه اخیر: ماه‌های ناقص، آخرین تاریخ فایل، ترمینال‌های بدون فایل */
export async function getCoverage(ctx: TenantContext, db: Queryable): Promise<CoverageDto[]> {
  assertRoles(ctx, READERS);
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 'f.office_id', unit: 'f.staff_unit_id', supporter: 'f.supporter_id' });
  where.push(`f.period_id IN (SELECT DISTINCT period_id FROM agg_office_month WHERE office_id = ${p.add(ctx.officeId)}
                              ORDER BY period_id DESC LIMIT 6)`);
  const rows = await queryRows<Omit<CoverageDto, 'isComplete'>>(db,
    `SELECT f.period_id AS "periodId", max(f.last_as_of_date)::text AS "lastFileDate", count(*)::int AS terminals,
            (count(*) FILTER (WHERE f.last_as_of_date IS NULL))::int AS "withoutFile",
            (count(*) FILTER (WHERE NOT f.is_complete))::int AS incomplete
       FROM fact_terminal_month f WHERE ${where.join(' AND ')} GROUP BY f.period_id ORDER BY f.period_id DESC`, p.values);
  return rows.map((r) => ({ ...r, isComplete: r.incomplete === 0 }));
}
