import { generatePeriods, periodIdOfDate } from '@pos/shared';
import type { Pool } from 'pg';

/** پر کردن جدول periods (idempotent). تعداد ردیف‌های جدید را برمی‌گرداند. */
export async function seedPeriods(pool: Pick<Pool, 'query'>, fromYear: number, toYear: number): Promise<number> {
  const ps = generatePeriods(fromYear, toYear);
  const res = await pool.query(
    `INSERT INTO periods (period_id, year, month, start_date, end_date)
     SELECT * FROM unnest($1::int[], $2::smallint[], $3::smallint[], $4::date[], $5::date[])
     ON CONFLICT (period_id) DO NOTHING`,
    [
      ps.map((p) => p.periodId),
      ps.map((p) => p.year),
      ps.map((p) => p.month),
      ps.map((p) => p.startDate),
      ps.map((p) => p.endDate),
    ],
  );
  return res.rowCount ?? 0;
}

/** ساخت پارتیشن‌های snapshot از ماه شمسی (today - back) تا (today + ahead) */
export async function ensureSnapshotPartitions(
  pool: Pick<Pool, 'query'>,
  today: string,
  back: number,
  ahead: number,
): Promise<string[]> {
  const cur = periodIdOfDate(today);
  const ids: number[] = [];
  let y = Math.trunc(cur / 100);
  let m = (cur % 100) - back;
  while (m < 1) { m += 12; y -= 1; }
  for (let i = 0; i <= back + ahead; i += 1) {
    ids.push(y * 100 + m);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  const out: string[] = [];
  for (const id of ids) {
    const { rows } = await pool.query<{ n: string }>('SELECT ensure_period_partition($1) AS n', [id]);
    if (rows[0]) out.push(rows[0].n);
  }
  return out;
}

/** ساخت پارتیشن‌های ماهانه‌ی audit_log از (ماه جاری - back) تا (ماه جاری + ahead) */
export async function ensureAuditPartitions(
  pool: Pick<Pool, 'query'>, today: string, back: number, ahead: number,
): Promise<string[]> {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = -back; i <= ahead; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 10);
    const { rows } = await pool.query<{ n: string }>('SELECT ensure_audit_partition($1::date) AS n', [d]);
    if (rows[0]) out.push(rows[0].n);
  }
  return out;
}
