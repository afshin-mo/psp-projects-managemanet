import {
  DEFAULT_SCORE_WEIGHTS, SCORE_COMPONENTS, overallScore, periodIdOfDate, prevPeriodId, projectLag, projectItemScore, scoreBand,
  scoreMonth, scoreTrend, shiftPeriod, todayInTehran,
  type ProjectScoreItem, type ScoreComponent, type ScoreProjectDto, type ScoreQuery, type ScoreWeights, type ScoreboardDto,
  type ScoreMonthDto, type SupporterScoreDto,
} from '@pos/shared';
import { SqlParams } from '../db/sql';
import { queryOne, queryRows, type Queryable } from '../db/types';
import { HttpError } from '../errors';
import { assertRoles, scopeWhere, type TenantContext, type TenantRole } from '../tenant/scope';

const READERS: readonly TenantRole[] = ['office_manager', 'data_admin', 'unit_head', 'supporter'];

interface AggRow {
  supporterId: number; periodId: number; amount: number; totalAmount: number; txCount: number; active: number; low: number;
}
interface ProjRow {
  projectId: number; name: string; startDate: string; dueDate: string; supporterId: number; periodId: number; total: number; resolved: number;
}

/** ماه کامل: دست‌کم ۹۰٪ ترمینال‌های دارای مبلغ، آخرین فایلشان پایان ماه (یا فایل ماهانه) باشد */
async function completePeriods(db: Queryable, officeId: number, today: string): Promise<{ complete: number[]; partial: number | null }> {
  const rows = await queryRows<{ periodId: number; withAmount: number; complete: number }>(db,
    `SELECT period_id AS "periodId", (count(*) FILTER (WHERE amount > 0))::int AS "withAmount",
            (count(*) FILTER (WHERE amount > 0 AND is_complete))::int AS complete
       FROM fact_terminal_month WHERE office_id = $1 AND period_id >= $2 GROUP BY period_id ORDER BY period_id`,
    [officeId, shiftPeriod(periodIdOfDate(today), -40)]);
  const complete = rows.filter((r) => r.withAmount > 0 && r.complete * 10 >= r.withAmount * 9).map((r) => r.periodId);
  const last = rows[rows.length - 1];
  const partial = last && !complete.includes(last.periodId) && last.withAmount > 0 ? last.periodId : null;
  return { complete, partial };
}

export async function getSupporterScoreboard(ctx: TenantContext, db: Queryable, q: ScoreQuery, today: string = todayInTehran()): Promise<ScoreboardDto> {
  assertRoles(ctx, READERS);
  const weights = ((await queryOne<{ w: ScoreWeights }>(db, 'SELECT score_weights AS w FROM office_settings WHERE office_id = $1', [ctx.officeId]))?.w)
    ?? DEFAULT_SCORE_WEIGHTS;

  const { complete, partial } = await completePeriods(db, ctx.officeId, today);
  const upTo = q.to ? complete.filter((p) => p <= q.to!) : complete;
  const periods = upTo.slice(-q.months);
  if (periods.length === 0) throw new HttpError(404, 'NO_DATA', 'هنوز ماه کاملی برای امتیازدهی وجود ندارد');
  const first = periods[0] as number;
  const skippedPartialPeriod = partial !== null && partial > (periods[periods.length - 1] as number) ? partial : null;

  // ---- مبلغ، تعداد و دستگاه‌ها (از تجمیع)
  const p1 = new SqlParams();
  const w1 = scopeWhere(ctx, p1, { office: 'a.office_id', unit: 'a.staff_unit_id', supporter: 'a.supporter_id' });
  w1.push(`a.period_id BETWEEN ${p1.add(prevPeriodId(first))} AND ${p1.add(periods[periods.length - 1])}`);
  if (q.unitId !== undefined) w1.push(`a.staff_unit_id = ${p1.add(q.unitId)}`);
  if (q.supporterId !== undefined) w1.push(`a.supporter_id = ${p1.add(q.supporterId)}`);
  const agg = await queryRows<AggRow>(db,
    `SELECT a.supporter_id AS "supporterId", a.period_id AS "periodId", sum(a.amount)::float8 AS amount,
            sum(a.total_amount)::float8 AS "totalAmount", sum(a.tx_count)::float8 AS "txCount",
            sum(a.active_terminals)::int AS active, sum(a.low_terminals)::int AS low
       FROM agg_supporter_month a WHERE ${w1.join(' AND ')} GROUP BY a.supporter_id, a.period_id`, p1.values);

  // ---- پروژه‌ها: وضعیت هر ترمینال در پایان هر ماه (از تاریخچه‌ی رویدادها)
  const p2 = new SqlParams();
  const pOffice = p2.add(ctx.officeId);
  const pToday = p2.add(today);
  const pPeriods = p2.add(periods);
  const w2 = scopeWhere(ctx, p2, { office: 't.office_id', unit: 't.current_unit_id', supporter: 't.current_supporter_id' });
  if (q.unitId !== undefined) w2.push(`t.current_unit_id = ${p2.add(q.unitId)}`);
  if (q.supporterId !== undefined) w2.push(`t.current_supporter_id = ${p2.add(q.supporterId)}`);
  const cutTs = `((m.cutoff + 1)::timestamp AT TIME ZONE 'Asia/Tehran')`;
  const proj = await queryRows<ProjRow>(db,
    `WITH m AS (SELECT period_id, start_date, LEAST(end_date - 1, ${pToday}::date) AS cutoff FROM periods WHERE period_id = ANY(${pPeriods}::int[]))
     SELECT pr.id AS "projectId", pr.name, pr.start_date::text AS "startDate", pr.due_date::text AS "dueDate",
            t.current_supporter_id AS "supporterId", m.period_id AS "periodId",
            count(*)::int AS total, (count(*) FILTER (WHERE x.st IN ('done', 'failed')))::int AS resolved
       FROM m
       JOIN projects pr ON pr.office_id = ${pOffice} AND pr.status <> 'cancelled' AND pr.start_date <= m.cutoff AND pr.due_date >= m.start_date
       JOIN project_terminals pt ON pt.office_id = pr.office_id AND pt.project_id = pr.id AND pt.added_at < ${cutTs}
       JOIN terminals t ON t.office_id = pt.office_id AND t.id = pt.terminal_id
       CROSS JOIN LATERAL (SELECT COALESCE(
            (SELECT e.to_status FROM project_terminal_events e
              WHERE e.office_id = pt.office_id AND e.project_id = pt.project_id AND e.terminal_id = pt.terminal_id AND e.created_at < ${cutTs}
              ORDER BY e.created_at DESC, e.id DESC LIMIT 1),
            (SELECT COALESCE(e.from_status, 'not_started') FROM project_terminal_events e
              WHERE e.office_id = pt.office_id AND e.project_id = pt.project_id AND e.terminal_id = pt.terminal_id
              ORDER BY e.created_at ASC, e.id ASC LIMIT 1),
            pt.status) AS st) x
      WHERE ${w2.join(' AND ')}
      GROUP BY pr.id, pr.name, pr.start_date, pr.due_date, t.current_supporter_id, m.period_id`, p2.values);

  // ---- نام و ستاد پشتیبان‌ها
  const ids = [...new Set([...agg.map((a) => a.supporterId), ...proj.map((r) => r.supporterId)])];
  const sups = ids.length === 0 ? [] : await queryRows<{ id: number; name: string; unitId: number }>(db,
    `SELECT id, full_name AS name, staff_unit_id AS "unitId" FROM supporters WHERE office_id = $1 AND id = ANY($2::int[])`, [ctx.officeId, ids]);

  const aggBy = new Map(agg.map((a) => [`${a.supporterId}:${a.periodId}`, a]));
  const projBy = new Map<string, ProjRow[]>();
  for (const r of proj) {
    const k = `${r.supporterId}:${r.periodId}`;
    projBy.set(k, [...(projBy.get(k) ?? []), r]);
  }

  // آخرین روز هر ماه (یا امروز اگر ماه ناتمام است): مبنای «پیشرفت مورد انتظار» پروژه
  const cutoffs = new Map((await queryRows<{ periodId: number; last: string }>(db,
    `SELECT period_id AS "periodId", (end_date - 1)::text AS last FROM periods WHERE period_id = ANY($1::int[])`, [periods]))
    .map((r) => [r.periodId, r.last < today ? r.last : today]));

  const out: SupporterScoreDto[] = [];
  for (const s of sups) {
    const months: ScoreMonthDto[] = [];
    for (const periodId of periods) {
      const cur = aggBy.get(`${s.id}:${periodId}`);
      const prev = aggBy.get(`${s.id}:${prevPeriodId(periodId)}`);
      const pRows = projBy.get(`${s.id}:${periodId}`) ?? [];
      const periodEnd = cutoffs.get(periodId) ?? today;
      const items: Array<ProjectScoreItem & { name: string; projectId: number }> = pRows.map((r) => ({
        projectId: r.projectId, name: r.name, total: r.total, resolved: r.resolved,
        expectedPct: projectLag({ startDate: r.startDate, dueDate: r.dueDate, today: periodEnd, total: r.total, done: r.resolved, failed: 0 }).expectedPct,
      }));
      const sc = scoreMonth({
        amount: cur?.amount ?? 0, prevAmount: prev ? prev.amount : null,
        txCount: cur?.txCount ?? 0, prevTxCount: prev ? prev.txCount : null,
        activeTerminals: cur?.active ?? 0, prevActiveTerminals: prev ? prev.active : null,
        measurableTerminals: (cur?.active ?? 0) + (cur?.low ?? 0), projects: items,
      }, weights);
      const projectDtos: ScoreProjectDto[] = items.map((i) => ({
        projectId: i.projectId, name: i.name, total: i.total, resolved: i.resolved,
        actualPct: i.total ? Math.round((i.resolved / i.total) * 1000) / 10 : 0, expectedPct: i.expectedPct, score: projectItemScore(i),
      }));
      months.push({
        periodId, total: cur ? sc.total : null, components: sc.components,
        growth: { amount: sc.amountGrowthPct, count: sc.countGrowthPct, devices: sc.deviceGrowthPct },
        metrics: {
          amount: cur?.amount ?? 0, totalAmount: cur?.totalAmount ?? 0, txCount: cur?.txCount ?? 0,
          activeTerminals: cur?.active ?? 0, measurableTerminals: (cur?.active ?? 0) + (cur?.low ?? 0), activeRatioPct: sc.activeRatioPct,
        },
        projects: projectDtos,
      });
    }
    const totals = months.map((m) => m.total);
    const overall = overallScore(totals);
    const componentAverages = Object.fromEntries(SCORE_COMPONENTS.map((k) => [k, overallScore(months.map((m) => m.components[k]))])) as Record<ScoreComponent, number | null>;
    out.push({ supporterId: s.id, name: s.name, unitId: s.unitId, overall, band: scoreBand(overall), trend: scoreTrend(totals), componentAverages, rank: null, months });
  }
  out.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1) || a.name.localeCompare(b.name, 'fa'));
  let rank = 0;
  for (const s of out) if (s.overall !== null) { rank += 1; s.rank = rank; }

  const officeAverage = periods.map((_, i) => overallScore(out.map((s) => s.months[i]?.total ?? null)));
  return { periods, skippedPartialPeriod, weights, officeAverage, supporters: out };
}
