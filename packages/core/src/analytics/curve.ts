import { buildProgressCurve, todayInTehran, type CurvePoint } from '@pos/shared';
import type pg from 'pg';
import { withTx } from '../db/types';
import type { Logger } from '../logging/pino';

/**
 * ساخت منحنی «سهم تجمیعی ماه» از فایل‌های واقعی ۶ ماه کامل اخیر (فقط job پس‌زمینه؛ از جدول خام می‌خواند).
 * برای هر تاریخ فایل، مجموع مانده‌ی تجمعیِ همه‌ی ترمینال‌ها بر مجموع آخرین فایل کامل ماه تقسیم می‌شود.
 * فقط فایل‌های «کامل» (حداقل نیمی از بیشترین تعداد ردیف در آن ماه) به حساب می‌آیند.
 */
export async function refreshProgressCurve(
  pool: pg.Pool, logger: Logger, officeId: number, today: string = todayInTehran(),
): Promise<{ months: number; stored: boolean }> {
  const periods = (await pool.query<{ period_id: number; days: number }>(
    `SELECT p.period_id, (p.end_date - p.start_date)::int AS days FROM periods p
      WHERE p.end_date <= $2::date
        AND EXISTS (SELECT 1 FROM transactions_snapshot s WHERE s.office_id = $1 AND s.as_of_date >= p.start_date AND s.as_of_date < p.end_date)
      ORDER BY p.period_id DESC LIMIT 6`, [officeId, today])).rows;

  const inputs: Array<{ daysInMonth: number; points: CurvePoint[] }> = [];
  for (const p of periods) {
    const days = (await pool.query<{ day: number; total: string; n: number }>(
      `SELECT (s.as_of_date - pp.start_date + 1)::int AS day, sum(s.cum_amount)::numeric AS total, count(*)::int AS n
         FROM transactions_snapshot s JOIN periods pp ON pp.period_id = $2
        WHERE s.office_id = $1 AND s.as_of_date >= pp.start_date AND s.as_of_date < pp.end_date
        GROUP BY 1 ORDER BY 1`, [officeId, p.period_id])).rows;
    const maxN = Math.max(0, ...days.map((d) => d.n));
    const full = days.filter((d) => d.n >= maxN * 0.5);
    const last = full[full.length - 1];
    if (!last || Number(last.total) <= 0) continue;
    inputs.push({ daysInMonth: p.days, points: full.map((d) => ({ day: d.day, share: Number(d.total) / Number(last.total) })) });
  }

  const curve = buildProgressCurve(inputs);
  if (!curve) {
    logger.info({ officeId, months: inputs.length }, 'progress curve: not enough data, linear projection will be used');
    return { months: inputs.length, stored: false };
  }
  const used = inputs.filter((i) => i.points.length >= 2).length;
  await withTx(pool, async (c) => {
    await c.query('DELETE FROM month_progress_curve WHERE office_id = $1', [officeId]);
    await c.query(
      `INSERT INTO month_progress_curve (office_id, day_of_month, share, months_used)
       SELECT $1::int, d, s, $4::smallint FROM unnest($2::smallint[], $3::float8[]) AS t(d, s)`,
      [officeId, curve.map((x) => x.day), curve.map((x) => x.share), used]);
    await c.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [officeId]);
  });
  logger.info({ officeId, months: used }, 'progress curve refreshed');
  return { months: used, stored: true };
}

export async function refreshProgressCurveAll(pool: pg.Pool, logger: Logger, today?: string): Promise<void> {
  const offices = (await pool.query<{ id: number }>('SELECT id FROM offices WHERE is_active ORDER BY id')).rows;
  for (const o of offices) await refreshProgressCurve(pool, logger, o.id, today);
}
