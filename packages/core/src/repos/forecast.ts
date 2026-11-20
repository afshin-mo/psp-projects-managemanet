import type pg from 'pg';
import type {
  ForecastDto, ForecastHistoryPoint, ForecastModel, ForecastQuery, ForecastRunDto, ForecastSummaryDto,
} from '@pos/shared';
import { SqlParams } from '../db/sql';
import { queryOne, queryRows, type Queryable } from '../db/types';
import { HttpError, forbidden, notFound } from '../errors';
import { assertRoles, scopeWhere, type TenantContext, type TenantRole } from '../tenant/scope';

const MANAGERS: readonly TenantRole[] = ['office_manager', 'data_admin'];
const HISTORY_MONTHS = 24;

const RUN_COLS = `id, status, horizon, base_period AS "basePeriod", series_count AS "seriesCount", message,
  created_at AS "createdAt", finished_at AS "finishedAt"`;

/** جدول تجمیع و ستون شناسه‌ی هر سطح */
const AGG = {
  office: { table: 'agg_office_month', col: null },
  unit: { table: 'agg_unit_month', col: 'staff_unit_id' },
  supporter: { table: 'agg_supporter_month', col: 'supporter_id' },
} as const;

/** کنترل دسترسی به یک سری؛ اسم سری را هم برمی‌گرداند */
async function resolveScope(ctx: TenantContext, db: Queryable, scope: ForecastQuery['scope'], id: number | undefined): Promise<{ id: number; name: string }> {
  if (scope === 'office') {
    assertRoles(ctx, MANAGERS);
    return { id: 0, name: 'کل دفتر' };
  }
  if (id === undefined) throw new HttpError(400, 'ID_REQUIRED', 'شناسه‌ی سری لازم است');
  if (scope === 'unit') {
    if (!MANAGERS.includes(ctx.role) && !(ctx.role === 'unit_head' && ctx.unitId === id)) throw forbidden();
    const row = await queryOne<{ name: string }>(db, 'SELECT name FROM staff_units WHERE office_id = $1 AND id = $2', [ctx.officeId, id]);
    if (!row) throw notFound('ستاد');
    return { id, name: row.name };
  }
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, { office: 's.office_id', unit: 's.staff_unit_id', supporter: 's.id' });
  where.push(`s.id = ${p.add(id)}`);
  const row = await queryOne<{ name: string }>(db, `SELECT s.full_name AS name FROM supporters s WHERE ${where.join(' AND ')}`, p.values);
  if (!row) throw notFound('پشتیبان');
  return { id, name: row.name };
}

/** سابقه‌ی ماهانه‌ی سری (۲۴ ماه اخیر) + پیش‌بینی ذخیره‌شده */
export async function getForecast(ctx: TenantContext, db: Queryable, q: ForecastQuery): Promise<ForecastDto> {
  const sc = await resolveScope(ctx, db, q.scope, q.id);
  const agg = AGG[q.scope];

  // «کامل» بودن ماه در سطح دفتر سنجیده می‌شود (ماه ناقص = هنوز فایل پایان ماه نیامده)
  const history = await queryRows<ForecastHistoryPoint>(db,
    `WITH cm AS (
       SELECT period_id, (sum(incomplete_terminals) = 0) AS is_complete FROM agg_office_month
        WHERE office_id = $1 GROUP BY period_id ORDER BY period_id DESC LIMIT ${HISTORY_MONTHS})
     SELECT cm.period_id AS "periodId", COALESCE(a.amount, 0)::bigint AS amount, cm.is_complete AS "isComplete"
       FROM cm LEFT JOIN (
         SELECT period_id, sum(amount)::bigint AS amount FROM ${agg.table}
          WHERE office_id = $1 ${agg.col ? `AND ${agg.col} = $2` : ''} GROUP BY period_id) a ON a.period_id = cm.period_id
      ORDER BY cm.period_id`,
    agg.col ? [ctx.officeId, sc.id] : [ctx.officeId]);

  const fc = await queryRows<{
    periodId: number; value: number; lower: number; upper: number; basePeriod: number; model: ForecastModel; mape: number | null; generatedAt: string;
  }>(db,
    `SELECT target_period AS "periodId", value, lower, upper, base_period AS "basePeriod", model, mape, generated_at AS "generatedAt"
       FROM forecast_results WHERE office_id = $1 AND scope_type = $2 AND scope_id = $3 ORDER BY target_period`,
    [ctx.officeId, q.scope, sc.id]);

  const first = fc[0];
  return {
    scope: q.scope, id: sc.id, name: sc.name,
    basePeriod: first?.basePeriod ?? null, model: first?.model ?? null, mape: first?.mape ?? null, generatedAt: first?.generatedAt ?? null,
    history,
    forecast: fc.map((r) => ({ periodId: r.periodId, value: r.value, lower: r.lower, upper: r.upper })),
  };
}

/** پیش‌بینی ماه بعد همه‌ی ستادها/پشتیبان‌ها (در دامنه‌ی کاربر) در برابر آخرین ماه واقعی */
export async function listForecastSummary(ctx: TenantContext, db: Queryable, scope: 'unit' | 'supporter'): Promise<ForecastSummaryDto[]> {
  const p = new SqlParams();
  let sql: string;
  if (scope === 'supporter') {
    const where = scopeWhere(ctx, p, { office: 'fr.office_id', unit: 's.staff_unit_id', supporter: 's.id' });
    where.push(`fr.scope_type = 'supporter'`);
    sql = `SELECT fr.scope_id AS "scopeId", s.full_name AS name, s.staff_unit_id AS "unitId", fr.base_period AS "basePeriod",
                  fr.target_period AS "targetPeriod", fr.value, fr.lower, fr.upper, fr.model, fr.mape,
                  COALESCE((SELECT sum(a.amount) FROM agg_supporter_month a
                             WHERE a.office_id = fr.office_id AND a.supporter_id = fr.scope_id AND a.period_id = fr.base_period), 0)::bigint AS "lastActual"
             FROM forecast_results fr JOIN supporters s ON s.office_id = fr.office_id AND s.id = fr.scope_id
            WHERE ${where.join(' AND ')}
              AND fr.target_period = (SELECT min(x.target_period) FROM forecast_results x WHERE x.office_id = fr.office_id AND x.scope_type = fr.scope_type AND x.scope_id = fr.scope_id)
            ORDER BY s.full_name`;
  } else {
    const where = scopeWhere(ctx, p, { office: 'fr.office_id', unit: 'su.id' });
    where.push(`fr.scope_type = 'unit'`);
    sql = `SELECT fr.scope_id AS "scopeId", su.name AS name, NULL::int AS "unitId", fr.base_period AS "basePeriod",
                  fr.target_period AS "targetPeriod", fr.value, fr.lower, fr.upper, fr.model, fr.mape,
                  COALESCE((SELECT sum(a.amount) FROM agg_unit_month a
                             WHERE a.office_id = fr.office_id AND a.staff_unit_id = fr.scope_id AND a.period_id = fr.base_period), 0)::bigint AS "lastActual"
             FROM forecast_results fr JOIN staff_units su ON su.office_id = fr.office_id AND su.id = fr.scope_id
            WHERE ${where.join(' AND ')}
              AND fr.target_period = (SELECT min(x.target_period) FROM forecast_results x WHERE x.office_id = fr.office_id AND x.scope_type = fr.scope_type AND x.scope_id = fr.scope_id)
            ORDER BY su.name`;
  }
  const rows = await queryRows<Omit<ForecastSummaryDto, 'changePct'>>(db, sql, p.values);
  return rows.map((r) => ({
    ...r,
    changePct: r.lastActual > 0 ? Math.round(((r.value - r.lastActual) / r.lastActual) * 10_000) / 100 : null,
  }));
}

/** ثبت درخواست اجرا (فقط مدیر). یک اجرای فعال برای هر دفتر مجاز است. */
export async function createForecastRun(ctx: TenantContext, pool: pg.Pool, horizon: number): Promise<ForecastRunDto> {
  assertRoles(ctx, MANAGERS);
  const active = await queryOne<{ id: number }>(pool,
    `SELECT id FROM forecast_runs WHERE office_id = $1 AND status IN ('queued','running') AND created_at > now() - interval '2 hours' LIMIT 1`,
    [ctx.officeId]);
  if (active) throw new HttpError(409, 'FORECAST_RUNNING', 'یک اجرای پیش‌بینی در حال انجام است');
  return (await queryOne<ForecastRunDto>(pool,
    `INSERT INTO forecast_runs (office_id, requested_by, horizon) VALUES ($1, $2, $3) RETURNING ${RUN_COLS}`,
    [ctx.officeId, ctx.userId, horizon])) as ForecastRunDto;
}

export async function getLatestForecastRun(ctx: TenantContext, db: Queryable): Promise<ForecastRunDto | null> {
  assertRoles(ctx, MANAGERS);
  return (await queryOne<ForecastRunDto>(db,
    `SELECT ${RUN_COLS} FROM forecast_runs WHERE office_id = $1 ORDER BY id DESC LIMIT 1`, [ctx.officeId])) ?? null;
}
