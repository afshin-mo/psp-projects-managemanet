import { periodIdOfDate, todayInTehran } from '@pos/shared';
import type pg from 'pg';
import { withTx } from '../db/types';
import type { Logger } from '../logging/pino';
import { refreshProgressCurve } from '../analytics/curve';
import { ELIGIBLE, beginDirty, rebuildAggregatesForPeriod, recomputeDirty } from './pipeline';

export interface AggDeps {
  pool: pg.Pool;
  logger: Logger;
  /** برای تست قابل جایگزینی (YYYY-MM-DD) */
  today?: () => string;
}

const todayOf = (d: AggDeps): string => (d.today ?? todayInTehran)();
const lock = (c: pg.PoolClient, officeId: number) =>
  c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agg:${officeId}`]);
const bump = (db: Pick<pg.Pool, 'query'>, officeId: number) =>
  db.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [officeId]);

const OUTBOX_CHUNK = 50_000;

/**
 * مصرف همه‌ی کار معوق یک دفتر: دسته‌های ایمپورتِ «aggregating» (کلیدهای import_batch_affected)
 * و رویدادهای recompute_outbox (تعویض پشتیبان، تغییر تاریخ نصب/انصراف، ترمینال جدید).
 * فقط ماه‌ها و ترمینال‌های تغییرکرده بازمحاسبه می‌شوند. چند نمونه‌ی هم‌زمان با advisory lock سریال می‌شوند.
 */
export async function runAggregateOffice(deps: AggDeps, officeId: number): Promise<{ rounds: number; facts: number; alerts: number }> {
  const today = todayOf(deps);
  const total = { rounds: 0, facts: 0, alerts: 0 };
  for (;;) {
    const stats = await withTx(deps.pool, async (c) => {
      await lock(c, officeId);
      await beginDirty(c);

      const batches = (await c.query<{ id: number }>(
        `SELECT id FROM import_batches WHERE office_id = $1 AND status = 'aggregating'
          ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`, [officeId])).rows.map((r) => r.id);
      if (batches.length > 0) {
        await c.query(
          `INSERT INTO dirty (terminal_id, period_id)
           SELECT terminal_id, period_id FROM import_batch_affected WHERE batch_id = ANY($1::bigint[])
           ON CONFLICT DO NOTHING`, [batches]);
      }
      // رویداد outbox: ماه تاریخ اثر تا ماه جاری بازمحاسبه می‌شود (گذشته‌ی قبل از آن دست‌نخورده).
      // فقط ماه جاری و ماه‌هایی که دفتر برایشان داده دارد؛ ماه‌های بدون داده ردیف بی‌معنی نمی‌گیرند.
      await c.query(
        `WITH c AS (
           SELECT id FROM recompute_outbox WHERE office_id = $1 AND processed_at IS NULL
            ORDER BY id LIMIT ${OUTBOX_CHUNK} FOR UPDATE SKIP LOCKED),
         u AS (
           UPDATE recompute_outbox o SET processed_at = now() FROM c WHERE o.id = c.id
           RETURNING o.terminal_id, o.effective_date)
         INSERT INTO dirty (terminal_id, period_id)
         SELECT DISTINCT u.terminal_id, p.period_id
           FROM u JOIN periods p ON p.end_date > u.effective_date AND p.start_date <= $2::date
          WHERE p.period_id = $3 OR p.period_id IN (SELECT period_id FROM agg_office_month WHERE office_id = $1)
         ON CONFLICT DO NOTHING`, [officeId, today, periodIdOfDate(today)]);

      const n = Number(((await c.query('SELECT count(*)::int AS n FROM dirty')).rows[0] as { n: number }).n);
      if (batches.length === 0 && n === 0) return null;

      const s = n > 0 ? await recomputeDirty(c, officeId, today) : { facts: 0, alerts: 0 };
      if (batches.length > 0) {
        await c.query(
          `UPDATE import_batches SET status = 'completed', stage = 'aggregated', progress = 100, finished_at = now()
            WHERE id = ANY($1::bigint[])`, [batches]);
      }
      await bump(c, officeId);
      return s;
    });
    if (!stats) break;
    total.rounds += 1;
    total.facts += stats.facts;
    total.alerts += stats.alerts;
  }
  if (total.rounds > 0) deps.logger.info({ officeId, ...total }, 'aggregation done');
  return total;
}

/**
 * بازطبقه‌بندی و بازمحاسبه‌ی هشدار برای ردیف‌های fact موجود از دوره‌ی fromPeriod به بعد.
 * با تغییر آستانه‌ی قانون‌ها یا تنظیمات دفتر (روز نوپا، درصد افت) فراخوانی می‌شود.
 */
export async function runReclassify(deps: AggDeps, officeId: number, fromPeriod = 0): Promise<{ periods: number }> {
  const today = todayOf(deps);
  const periods = (await deps.pool.query<{ period_id: number }>(
    `SELECT DISTINCT period_id FROM fact_terminal_month WHERE office_id = $1 AND period_id >= $2 ORDER BY period_id`,
    [officeId, fromPeriod])).rows.map((r) => r.period_id);
  for (const periodId of periods) {
    await withTx(deps.pool, async (c) => {
      await lock(c, officeId);
      await beginDirty(c);
      await c.query(
        `INSERT INTO dirty (terminal_id, period_id)
         SELECT terminal_id, period_id FROM fact_terminal_month WHERE office_id = $1 AND period_id = $2`, [officeId, periodId]);
      await recomputeDirty(c, officeId, today);
    });
  }
  if (periods.length > 0) await bump(deps.pool, officeId);
  deps.logger.info({ officeId, fromPeriod, periods: periods.length }, 'reclassify done');
  return { periods: periods.length };
}

/** ایجاد ردیف‌های صفر ماه جاری برای ترمینال‌های موجه (روز اول هر ماه شمسی و هر روز به‌صورت idempotent) */
export async function runRollover(deps: AggDeps, officeId: number): Promise<{ created: number }> {
  const today = todayOf(deps);
  const periodId = periodIdOfDate(today);
  const created = await withTx(deps.pool, async (c) => {
    await lock(c, officeId);
    await beginDirty(c);
    await c.query(
      `INSERT INTO dirty (terminal_id, period_id)
       SELECT t.id, p.period_id FROM terminals t JOIN periods p ON p.period_id = $2
        WHERE t.office_id = $1 AND (${ELIGIBLE})
          AND NOT EXISTS (SELECT 1 FROM fact_terminal_month f
                           WHERE f.office_id = $1 AND f.period_id = p.period_id AND f.terminal_id = t.id)`, [officeId, periodId]);
    const n = Number(((await c.query('SELECT count(*)::int AS n FROM dirty')).rows[0] as { n: number }).n);
    if (n > 0) {
      await recomputeDirty(c, officeId, today);
      await bump(c, officeId);
    }
    return n;
  });
  return { created };
}

export async function runRolloverAll(deps: AggDeps): Promise<number> {
  const offices = (await deps.pool.query<{ id: number }>('SELECT id FROM offices WHERE is_active ORDER BY id')).rows;
  let total = 0;
  for (const o of offices) total += (await runRollover(deps, o.id)).created;
  deps.logger.info({ offices: offices.length, created: total }, 'period rollover done');
  return total;
}

/**
 * بازسازی کامل fact و تجمیع‌ها از روی snapshotها (بعد از ایمپورت اولیه، یا برای ترمیم).
 * فقط دوره‌هایی ساخته می‌شوند که snapshot دارند، به‌علاوه‌ی ماه جاری. هر دوره در transaction جدا.
 */
export async function runRebuild(
  deps: AggDeps, officeId: number, opts: { fromPeriod?: number; toPeriod?: number } = {},
): Promise<{ periods: number[] }> {
  const today = todayOf(deps);
  const current = periodIdOfDate(today);
  const periods = (await deps.pool.query<{ period_id: number }>(
    `SELECT p.period_id FROM periods p
      WHERE p.start_date <= $2::date AND p.period_id BETWEEN $3 AND $4
        AND (p.period_id = $5
             OR EXISTS (SELECT 1 FROM transactions_snapshot s
                         WHERE s.office_id = $1 AND s.as_of_date >= p.start_date AND s.as_of_date < p.end_date))
      ORDER BY p.period_id`,
    [officeId, today, opts.fromPeriod ?? 0, opts.toPeriod ?? 999_999, current])).rows.map((r) => r.period_id);

  for (const periodId of periods) {
    await withTx(deps.pool, async (c) => {
      await lock(c, officeId);
      await beginDirty(c);
      await c.query(
        `INSERT INTO dirty (terminal_id, period_id)
         SELECT s.terminal_id, $2::int FROM transactions_snapshot s
           JOIN periods p ON p.period_id = $2 AND s.as_of_date >= p.start_date AND s.as_of_date < p.end_date
          WHERE s.office_id = $1 GROUP BY s.terminal_id
         ON CONFLICT DO NOTHING`, [officeId, periodId]);
      await c.query(
        `INSERT INTO dirty (terminal_id, period_id)
         SELECT t.id, p.period_id FROM terminals t JOIN periods p ON p.period_id = $2
          WHERE t.office_id = $1 AND (${ELIGIBLE})
         ON CONFLICT DO NOTHING`, [officeId, periodId]);
      await c.query(
        `DELETE FROM fact_terminal_month f WHERE f.office_id = $1 AND f.period_id = $2
            AND NOT EXISTS (SELECT 1 FROM dirty d WHERE d.terminal_id = f.terminal_id AND d.period_id = f.period_id)`,
        [officeId, periodId]);
      await recomputeDirty(c, officeId, today);
      await rebuildAggregatesForPeriod(c, officeId, periodId);
    });
  }
  await bump(deps.pool, officeId);
  await refreshProgressCurve(deps.pool, deps.logger, officeId, today).catch((err: unknown) => deps.logger.warn({ err }, 'progress curve refresh failed'));
  deps.logger.info({ officeId, periods: periods.length }, 'rebuild done');
  return { periods };
}

/** دفترهایی که کار تجمیع معوق دارند (برای job پشتیبان sweep) */
export async function findOfficesWithPendingWork(pool: pg.Pool): Promise<number[]> {
  const r = await pool.query<{ office_id: number }>(
    `SELECT office_id FROM recompute_outbox WHERE processed_at IS NULL
     UNION SELECT office_id FROM import_batches WHERE status = 'aggregating'`);
  return r.rows.map((x) => x.office_id);
}
