import type pg from 'pg';

/**
 * هسته‌ی تجمیع افزایشی (idempotent). همه‌ی توابع باید داخل یک transaction روی یک PoolClient اجرا شوند.
 * هر مرحله «بازمحاسبه‌ی کامل slice از منبع» است، نه اعمال دلتا؛ پس اجرای دوباره نتیجه را عوض نمی‌کند
 * و crash در میانه خطای شمارش نمی‌سازد.
 *
 * ورودی: جدول موقت dirty(terminal_id, period_id) که فراخواننده پر می‌کند.
 */
export interface PipelineStats { facts: number; alerts: number }

/** ترمینالی که برای این دوره «باید ردیف fact داشته باشد» (حتی با مبلغ صفر)، به‌جز وجود snapshot */
export const ELIGIBLE = `COALESCE(t.installed_at, t.created_at::date) < p.end_date
  AND (t.returned_at IS NULL OR t.returned_at >= p.start_date)`;

export async function beginDirty(c: pg.PoolClient): Promise<void> {
  await c.query(`CREATE TEMP TABLE IF NOT EXISTS dirty (
    terminal_id bigint NOT NULL, period_id integer NOT NULL, PRIMARY KEY (terminal_id, period_id)) ON COMMIT DROP`);
  await c.query('TRUNCATE dirty');
}

const METRICS = `sum(f.amount)::bigint AS amount, sum(f.tx_count)::bigint AS tx_count,
  sum(f.total_amount)::bigint AS total_amount, sum(f.total_tx_count)::bigint AS total_tx_count,
  (count(*) FILTER (WHERE f.activity_class = 1))::int AS active_terminals,
  (count(*) FILTER (WHERE f.activity_class = 2))::int AS low_terminals,
  (count(*) FILTER (WHERE f.activity_class = 3))::int AS returned_terminals,
  (count(*) FILTER (WHERE f.activity_class = 4))::int AS new_terminals,
  (count(*) FILTER (WHERE NOT f.is_complete))::int AS incomplete_terminals`;
const METRIC_COLS = `amount, tx_count, total_amount, total_tx_count, active_terminals, low_terminals, returned_terminals, new_terminals, incomplete_terminals`;

const supporterAgg = (join: string, extra: string): string =>
  `INSERT INTO agg_supporter_month (office_id, period_id, supporter_id, staff_unit_id, route_group_id, bank_id, ${METRIC_COLS})
   SELECT f.office_id, f.period_id, f.supporter_id, f.staff_unit_id, f.route_group_id, f.bank_id, ${METRICS}
     FROM fact_terminal_month f ${join} WHERE f.office_id = $1 ${extra}
    GROUP BY f.office_id, f.period_id, f.supporter_id, f.staff_unit_id, f.route_group_id, f.bank_id`;
const unitAgg = (join: string, extra: string): string =>
  `INSERT INTO agg_unit_month (office_id, period_id, staff_unit_id, route_group_id, bank_id, ${METRIC_COLS})
   SELECT f.office_id, f.period_id, f.staff_unit_id, f.route_group_id, f.bank_id, ${METRICS}
     FROM fact_terminal_month f ${join} WHERE f.office_id = $1 ${extra}
    GROUP BY f.office_id, f.period_id, f.staff_unit_id, f.route_group_id, f.bank_id`;
const officeAgg = (join: string, extra: string): string =>
  `INSERT INTO agg_office_month (office_id, period_id, route_group_id, bank_id, ${METRIC_COLS})
   SELECT f.office_id, f.period_id, f.route_group_id, f.bank_id, ${METRICS}
     FROM fact_terminal_month f ${join} WHERE f.office_id = $1 ${extra}
    GROUP BY f.office_id, f.period_id, f.route_group_id, f.bank_id`;

/** بازسازی کامل تجمیع‌های یک دوره از fact (برای rebuild) */
export async function rebuildAggregatesForPeriod(c: pg.PoolClient, officeId: number, periodId: number): Promise<void> {
  for (const t of ['agg_supporter_month', 'agg_unit_month', 'agg_office_month']) {
    await c.query(`DELETE FROM ${t} WHERE office_id = $1 AND period_id = $2`, [officeId, periodId]);
  }
  const only = 'AND f.period_id = $2';
  await c.query(supporterAgg('', only), [officeId, periodId]);
  await c.query(unitAgg('', only), [officeId, periodId]);
  await c.query(officeAgg('', only), [officeId, periodId]);
}

export async function recomputeDirty(c: pg.PoolClient, officeId: number, today: string): Promise<PipelineStats> {
  await c.query('DROP TABLE IF EXISTS dirty_old, calc, slices, alert_keys');
  await c.query('ANALYZE dirty');

  // A) ابعاد قبلی (برای بازسازی slice هایی که ترمینال از آن‌ها خارج می‌شود، مثلاً تعویض پشتیبان)
  await c.query(
    `CREATE TEMP TABLE dirty_old ON COMMIT DROP AS
     SELECT f.period_id, f.supporter_id, f.staff_unit_id
       FROM fact_terminal_month f JOIN dirty d ON d.period_id = f.period_id AND d.terminal_id = f.terminal_id
      WHERE f.office_id = $1 GROUP BY 1, 2, 3`, [officeId]);

  // B) محاسبه‌ی مقادیر جدید
  //  - مبلغ/تعداد: آخرین snapshot همان ماه شمسی؛ بدون snapshot = ۰
  //  - پشتیبان/ستاد/مسیر/بانک: تاریخچه‌ی معتبر در min(آخرین روز ماه, امروز)؛ اگر ردیفی شامل آن تاریخ نبود، قدیمی‌ترین ردیف
  //  - آستانه: آخرین قانون بانکِ همان ترمینال (valid_from ≤ دوره)، وگرنه قانون پیش‌فرض (bank_id=0)، وگرنه ۰
  //  - طبقه: برگشتی > نوپا > فعال/کم‌تراکنش (معادل classifyActivity در packages/shared)
  await c.query(
    `CREATE TEMP TABLE calc ON COMMIT DROP AS
     SELECT d.terminal_id, d.period_id,
            COALESCE(l.cum_amount, 0)::bigint AS amount, COALESCE(l.cum_count, 0)::int AS tx_count,
            -- مبلغ کل: اگر فایل ستون «کل» نداشت، برابر مبلغ خرید فرض می‌شود
            COALESCE(l.cum_total_amount, l.cum_amount, 0)::bigint AS total_amount,
            COALESCE(l.cum_total_count, l.cum_count, 0)::int AS total_tx_count,
            l.as_of_date AS last_as_of_date,
            (l.as_of_date IS NOT NULL AND (l.as_of_date = p.end_date - 1 OR l.source = 2)) AS is_complete,
            h.supporter_id, h.staff_unit_id, h.route_group_id, h.bank_id,
            (CASE WHEN t.returned_at IS NOT NULL AND t.returned_at < p.end_date THEN 3
                  WHEN t.installed_at >= p.start_date + (st.new_terminal_cutoff_day - 1) AND t.installed_at < p.end_date THEN 4
                  -- مبنای فعال/کم‌تراکنش طبق تنظیم دفتر: مبلغ خرید (پیش‌فرض) یا مبلغ کل
                  WHEN (CASE WHEN st.income_basis = 'total' THEN COALESCE(l.cum_total_amount, l.cum_amount, 0)
                             ELSE COALESCE(l.cum_amount, 0) END) >= COALESCE(r.min_monthly_amount, 0) THEN 1
                  ELSE 2 END)::smallint AS activity_class
       FROM dirty d
       JOIN periods p ON p.period_id = d.period_id
       JOIN terminals t ON t.office_id = $1 AND t.id = d.terminal_id
       JOIN office_settings st ON st.office_id = $1
       LEFT JOIN LATERAL (
            SELECT x.cum_amount, x.cum_count, x.cum_total_amount, x.cum_total_count, x.as_of_date, x.source FROM transactions_snapshot x
             WHERE x.office_id = $1 AND x.terminal_id = d.terminal_id
               AND x.as_of_date >= p.start_date AND x.as_of_date < p.end_date
             ORDER BY x.as_of_date DESC LIMIT 1) l ON true
       JOIN LATERAL (
            SELECT hh.supporter_id, hh.staff_unit_id, hh.route_group_id, hh.bank_id
              FROM terminal_supporter_history hh
             WHERE hh.office_id = $1 AND hh.terminal_id = d.terminal_id
             ORDER BY (hh.start_date <= LEAST(p.end_date - 1, $2::date)
                       AND (hh.end_date IS NULL OR hh.end_date > LEAST(p.end_date - 1, $2::date))) DESC,
                      hh.start_date ASC
             LIMIT 1) h ON true
       LEFT JOIN LATERAL (
            SELECT rr.min_monthly_amount FROM activity_rules rr
             WHERE rr.office_id = $1 AND rr.bank_id IN (h.bank_id, 0) AND rr.valid_from_period <= d.period_id
             ORDER BY (rr.bank_id = h.bank_id) DESC, rr.valid_from_period DESC LIMIT 1) r ON true
      WHERE l.as_of_date IS NOT NULL OR (${ELIGIBLE})`, [officeId, today]);

  // C) fact: upsert فقط ردیف‌های واقعاً تغییرکرده؛ ردیف‌های dirty که دیگر موجه نیستند حذف می‌شوند
  const up = await c.query(
    `INSERT INTO fact_terminal_month AS f
       (office_id, period_id, terminal_id, amount, tx_count, total_amount, total_tx_count, last_as_of_date, is_complete, activity_class,
        supporter_id, staff_unit_id, route_group_id, bank_id)
     SELECT $1::int, k.period_id, k.terminal_id, k.amount, k.tx_count, k.total_amount, k.total_tx_count, k.last_as_of_date, k.is_complete, k.activity_class,
            k.supporter_id, k.staff_unit_id, k.route_group_id, k.bank_id
       FROM calc k ORDER BY k.period_id, k.terminal_id
     ON CONFLICT (office_id, period_id, terminal_id) DO UPDATE
        SET amount = EXCLUDED.amount, tx_count = EXCLUDED.tx_count, total_amount = EXCLUDED.total_amount,
            total_tx_count = EXCLUDED.total_tx_count, last_as_of_date = EXCLUDED.last_as_of_date,
            is_complete = EXCLUDED.is_complete, activity_class = EXCLUDED.activity_class,
            supporter_id = EXCLUDED.supporter_id, staff_unit_id = EXCLUDED.staff_unit_id,
            route_group_id = EXCLUDED.route_group_id, bank_id = EXCLUDED.bank_id, computed_at = now()
      WHERE (f.amount, f.tx_count, f.total_amount, f.total_tx_count, f.last_as_of_date, f.is_complete, f.activity_class, f.supporter_id,
             f.staff_unit_id, f.route_group_id, f.bank_id)
            IS DISTINCT FROM
            (EXCLUDED.amount, EXCLUDED.tx_count, EXCLUDED.total_amount, EXCLUDED.total_tx_count, EXCLUDED.last_as_of_date, EXCLUDED.is_complete, EXCLUDED.activity_class,
             EXCLUDED.supporter_id, EXCLUDED.staff_unit_id, EXCLUDED.route_group_id, EXCLUDED.bank_id)`, [officeId]);
  await c.query(
    `DELETE FROM fact_terminal_month f USING dirty d
      WHERE f.office_id = $1 AND f.period_id = d.period_id AND f.terminal_id = d.terminal_id
        AND NOT EXISTS (SELECT 1 FROM calc k WHERE k.terminal_id = d.terminal_id AND k.period_id = d.period_id)`, [officeId]);

  // D) تجمیع‌ها: slice هایی که تغییر کرده‌اند (ابعاد قبلی ∪ جدید) از fact بازسازی می‌شوند
  await c.query(
    `CREATE TEMP TABLE slices ON COMMIT DROP AS
     SELECT period_id, supporter_id, staff_unit_id FROM dirty_old
     UNION SELECT period_id, supporter_id, staff_unit_id FROM calc`);
  await c.query(
    `DELETE FROM agg_supporter_month a USING (SELECT DISTINCT period_id, supporter_id FROM slices) s
      WHERE a.office_id = $1 AND a.period_id = s.period_id AND a.supporter_id = s.supporter_id`, [officeId]);
  await c.query(supporterAgg('JOIN (SELECT DISTINCT period_id, supporter_id FROM slices) s ON s.period_id = f.period_id AND s.supporter_id = f.supporter_id', ''), [officeId]);
  await c.query(
    `DELETE FROM agg_unit_month a USING (SELECT DISTINCT period_id, staff_unit_id FROM slices) s
      WHERE a.office_id = $1 AND a.period_id = s.period_id AND a.staff_unit_id = s.staff_unit_id`, [officeId]);
  await c.query(unitAgg('JOIN (SELECT DISTINCT period_id, staff_unit_id FROM slices) s ON s.period_id = f.period_id AND s.staff_unit_id = f.staff_unit_id', ''), [officeId]);
  await c.query(
    `DELETE FROM agg_office_month a USING (SELECT DISTINCT period_id FROM slices) s
      WHERE a.office_id = $1 AND a.period_id = s.period_id`, [officeId]);
  await c.query(officeAgg('JOIN (SELECT DISTINCT period_id FROM slices) s ON s.period_id = f.period_id', ''), [officeId]);

  // E) هشدار افت: برای دوره‌های P..P+3 ترمینال‌های dirty (میانگین ۳ ماه قبل هر کدام به P وابسته است)
  //    فقط ماه کامل، غیربرگشتی؛ ماه بدون ردیف fact = ۰
  await c.query(
    `CREATE TEMP TABLE alert_keys ON COMMIT DROP AS
     WITH pl AS (SELECT period_id, row_number() OVER (ORDER BY period_id) AS rn FROM periods)
     SELECT DISTINCT d.terminal_id, q.period_id
       FROM dirty d JOIN pl p ON p.period_id = d.period_id JOIN pl q ON q.rn BETWEEN p.rn AND p.rn + 3`);
  await c.query(
    `DELETE FROM terminal_alerts a USING alert_keys k
      WHERE a.office_id = $1 AND a.terminal_id = k.terminal_id AND a.period_id = k.period_id`, [officeId]);
  const al = await c.query(
    `INSERT INTO terminal_alerts (office_id, period_id, terminal_id, supporter_id, staff_unit_id, avg3_amount, cur_amount, drop_pct)
     WITH pl AS (SELECT period_id, row_number() OVER (ORDER BY period_id) AS rn FROM periods)
     SELECT $1::int, k.period_id, k.terminal_id, cur.supporter_id, cur.staff_unit_id,
            (pv.total / 3)::bigint, cur.amount, round((1 - 3.0 * cur.amount / pv.total) * 100, 2)
       FROM alert_keys k
       JOIN pl q ON q.period_id = k.period_id
       JOIN fact_terminal_month cur
         ON cur.office_id = $1 AND cur.period_id = k.period_id AND cur.terminal_id = k.terminal_id
        AND cur.is_complete AND cur.activity_class <> 3
       JOIN office_settings st ON st.office_id = $1
       CROSS JOIN LATERAL (
            SELECT COALESCE(sum(f.amount), 0) AS total
              FROM pl pp JOIN fact_terminal_month f
                ON f.office_id = $1 AND f.period_id = pp.period_id AND f.terminal_id = k.terminal_id
             WHERE pp.rn BETWEEN q.rn - 3 AND q.rn - 1) pv
      WHERE pv.total > 0 AND cur.amount::numeric * 300 < pv.total::numeric * (100 - st.drop_alert_threshold_pct)`, [officeId]);

  return { facts: up.rowCount ?? 0, alerts: al.rowCount ?? 0 };
}
