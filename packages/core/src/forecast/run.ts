import { fillSeriesGaps, forecastSeries, nextPeriodId, type ForecastResult } from '@pos/shared';
import type pg from 'pg';
import { withTx } from '../db/types';
import type { Logger } from '../logging/pino';

export interface ForecastDeps { pool: pg.Pool; logger: Logger }

const MIN_COMPLETE_MONTHS = 4;
const MAX_HISTORY_MONTHS = 60;

interface SeriesKey { type: 'office' | 'unit' | 'supporter'; id: number }

/** شناسه‌ی دوره‌های پیاپی از first تا last (شامل هر دو) */
function periodRange(first: number, last: number): number[] {
  const out: number[] = [];
  for (let p = first; p <= last && out.length < 1000; p = nextPeriodId(p)) out.push(p);
  return out;
}

/** ماه‌های «کامل» دفتر: همه‌ی ترمینال‌های آن ماه فایل پایان ماه دارند و مبلغ > ۰ است */
async function completePeriods(pool: pg.Pool, officeId: number): Promise<number[]> {
  const r = await pool.query<{ period_id: number }>(
    `SELECT period_id FROM agg_office_month WHERE office_id = $1
      GROUP BY period_id HAVING sum(incomplete_terminals) = 0 AND sum(amount) > 0 ORDER BY period_id`, [officeId]);
  return r.rows.map((x) => x.period_id);
}

/**
 * ساخت سری‌ها از جدول‌های تجمیع. ماه‌های ناکامل دفتر (سوراخ) برای همه‌ی سری‌ها null می‌شوند و درون‌یابی می‌گردند؛
 * ماه کامل بدون ردیف برای یک ستاد/پشتیبان یعنی صفر. ماه‌های قبل از اولین ردیف هر سری حذف می‌شوند.
 */
async function loadSeries(pool: pg.Pool, officeId: number, range: number[], complete: Set<number>): Promise<Map<string, { key: SeriesKey; values: Array<number | null> }>> {
  const from = range[0] as number;
  const to = range[range.length - 1] as number;
  const rows = await pool.query<{ scope_type: SeriesKey['type']; scope_id: number; period_id: number; amount: number }>(
    `SELECT 'office' AS scope_type, 0 AS scope_id, period_id, sum(amount)::bigint AS amount
       FROM agg_office_month WHERE office_id = $1 AND period_id BETWEEN $2 AND $3 GROUP BY period_id
     UNION ALL
     SELECT 'unit', staff_unit_id, period_id, sum(amount)::bigint
       FROM agg_unit_month WHERE office_id = $1 AND period_id BETWEEN $2 AND $3 GROUP BY staff_unit_id, period_id
     UNION ALL
     SELECT 'supporter', supporter_id, period_id, sum(amount)::bigint
       FROM agg_supporter_month WHERE office_id = $1 AND period_id BETWEEN $2 AND $3 GROUP BY supporter_id, period_id`,
    [officeId, from, to]);

  const byKey = new Map<string, { key: SeriesKey; amounts: Map<number, number> }>();
  for (const r of rows.rows) {
    const k = `${r.scope_type}:${r.scope_id}`;
    const e = byKey.get(k) ?? { key: { type: r.scope_type, id: r.scope_id }, amounts: new Map() };
    e.amounts.set(r.period_id, r.amount);
    byKey.set(k, e);
  }
  const out = new Map<string, { key: SeriesKey; values: Array<number | null> }>();
  for (const [k, e] of byKey) {
    const firstIdx = range.findIndex((p) => e.amounts.has(p));
    if (firstIdx < 0) continue;
    out.set(k, { key: e.key, values: range.slice(firstIdx).map((p) => (complete.has(p) ? (e.amounts.get(p) ?? 0) : null)) });
  }
  return out;
}

export interface ForecastRunResult { series: number; basePeriod: number | null; skipped: number }

/**
 * پیش‌بینی همه‌ی سری‌های یک دفتر (کل دفتر، هر ستاد، هر پشتیبان) و جایگزینی کامل forecast_results آن دفتر.
 * فقط ماه‌های کامل استفاده می‌شوند؛ پشتیبان/ستادی که در ۳ ماه کامل اخیر مبلغ صفر داشته (غیرفعال) پیش‌بینی نمی‌شود.
 */
export async function runForecastOffice(deps: ForecastDeps, officeId: number, horizon = 6): Promise<ForecastRunResult> {
  const complete = await completePeriods(deps.pool, officeId);
  if (complete.length < MIN_COMPLETE_MONTHS) return { series: 0, basePeriod: null, skipped: 0 };

  const base = complete[complete.length - 1] as number;
  const first = complete[Math.max(0, complete.length - MAX_HISTORY_MONTHS)] as number;
  const range = periodRange(first, base);
  const series = await loadSeries(deps.pool, officeId, range, new Set(complete));

  const targets: number[] = [];
  for (let p = nextPeriodId(base), i = 0; i < horizon; p = nextPeriodId(p), i += 1) targets.push(p);

  const rows: Array<{ type: string; id: number; target: number; r: ForecastResult; step: number }> = [];
  let count = 0;
  let skipped = 0;
  for (const { key, values } of series.values()) {
    const filled = fillSeriesGaps(values);
    const recent = (filled ?? []).slice(-3);
    if (!filled || filled.length < 3 || (key.type !== 'office' && recent.every((v) => v === 0))) {
      skipped += 1;
      continue;
    }
    const result = forecastSeries(filled, horizon);
    if (!result) {
      skipped += 1;
      continue;
    }
    count += 1;
    for (const pt of result.points) rows.push({ type: key.type, id: key.id, target: targets[pt.step - 1] as number, r: result, step: pt.step });
  }

  await withTx(deps.pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`forecast:${officeId}`]);
    await c.query('DELETE FROM forecast_results WHERE office_id = $1', [officeId]);
    const CHUNK = 4000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      await c.query(
        `INSERT INTO forecast_results (office_id, scope_type, scope_id, target_period, base_period, model, value, lower, upper, mape)
         SELECT $1::int, x.t, x.i, x.tp, $2::int, x.m, x.v, x.lo, x.up, x.mp
           FROM unnest($3::text[], $4::int[], $5::int[], $6::text[], $7::bigint[], $8::bigint[], $9::bigint[], $10::float8[])
                AS x(t, i, tp, m, v, lo, up, mp)`,
        [officeId, base, part.map((x) => x.type), part.map((x) => x.id), part.map((x) => x.target), part.map((x) => x.r.model),
         part.map((x) => x.r.points[x.step - 1]?.value ?? 0), part.map((x) => x.r.points[x.step - 1]?.lower ?? 0),
         part.map((x) => x.r.points[x.step - 1]?.upper ?? 0), part.map((x) => x.r.mape)]);
    }
    await c.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [officeId]);
  });
  deps.logger.info({ officeId, series: count, skipped, basePeriod: base, horizon }, 'forecast done');
  return { series: count, basePeriod: base, skipped };
}

/** اجرای ثبت‌شده در forecast_runs (از API) */
export async function runForecastJob(deps: ForecastDeps, runId: number): Promise<void> {
  const run = (await deps.pool.query<{ office_id: number; horizon: number; status: string }>(
    'SELECT office_id, horizon, status FROM forecast_runs WHERE id = $1', [runId])).rows[0];
  if (!run || !['queued', 'running'].includes(run.status)) return;
  await deps.pool.query(`UPDATE forecast_runs SET status = 'running' WHERE id = $1`, [runId]);
  try {
    const r = await runForecastOffice(deps, run.office_id, run.horizon);
    const message = r.basePeriod === null ? 'داده‌ی کافی نیست (حداقل ۴ ماه کامل لازم است)' : null;
    await deps.pool.query(
      `UPDATE forecast_runs SET status = 'done', base_period = $2, series_count = $3, message = $4, finished_at = now() WHERE id = $1`,
      [runId, r.basePeriod, r.series, message]);
  } catch (err) {
    await deps.pool.query(
      `UPDATE forecast_runs SET status = 'failed', message = $2, finished_at = now() WHERE id = $1`,
      [runId, err instanceof Error ? err.message.slice(0, 500) : 'unknown error']);
    throw err;
  }
}

/** اجرای زمان‌بندی‌شده برای همه‌ی دفترهای فعال */
export async function runForecastAll(deps: ForecastDeps, horizon = 6): Promise<number> {
  const offices = (await deps.pool.query<{ id: number }>('SELECT id FROM offices WHERE is_active ORDER BY id')).rows;
  let done = 0;
  for (const o of offices) {
    try {
      await runForecastOffice(deps, o.id, horizon);
      done += 1;
    } catch (err) {
      deps.logger.error({ err, officeId: o.id }, 'forecast failed for office');
    }
  }
  return done;
}
