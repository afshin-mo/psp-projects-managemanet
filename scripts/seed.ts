import { randomBytes } from 'node:crypto';
import { createLogger, createPools, hashPassword, loadEnv, runRebuild } from '@pos/core';
import { periodIdOfDate, todayInTehran } from '@pos/shared';
import { stringArg } from './_args';

/**
 * داده‌ی آزمایشی (کاملاً set-based داخل PostgreSQL):
 *   npm run seed -- --size=small    (۲۰ پشتیبان، ۲۰۰۰ ترمینال، ۱۸ ماه)
 *   npm run seed -- --size=large    (۵۰۰ پشتیبان، ۲۰۰٬۰۰۰ ترمینال، ۱۲ ماه) برای تست بار
 * اختیاری: --office=<code>. اگر دفتر وجود داشته باشد متوقف می‌شود (برای تکرار، کد دیگری بدهید یا دیتابیس آزمایشی را بازسازی کنید).
 * بعد از ساخت snapshotها، تجمیع کامل (runRebuild) اجرا می‌شود.
 */
const size = (stringArg('size') ?? 'small') as 'small' | 'large';
if (size !== 'small' && size !== 'large') throw new Error('--size must be small or large');
const cfg = size === 'large'
  ? { units: 50, supporters: 500, terminals: 200_000, months: 12 }
  : { units: 4, supporters: 20, terminals: 2000, months: 18 };
const code = stringArg('office') ?? `seed-${size}`;

const env = loadEnv();
const logger = createLogger(env, 'seed');
const pools = createPools(env, logger, 'pos-seed');
const pool = pools.write;
const today = todayInTehran();
const t0 = Date.now();
const lap = (msg: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

try {
  if ((await pool.query('SELECT 1 FROM offices WHERE code = $1', [code])).rowCount) {
    throw new Error(`office "${code}" already exists; choose another --office or recreate the test database`);
  }
  const officeId = (await pool.query<{ id: number }>('INSERT INTO offices (name, code) VALUES ($1, $2) RETURNING id', [`دفتر آزمایشی ${size}`, code])).rows[0]!.id;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

  await q(`INSERT INTO staff_units (office_id, name) SELECT $1, 'ستاد ' || g FROM generate_series(1, $2::int) g`, [officeId, cfg.units]);
  await q(`WITH u AS (SELECT array_agg(id ORDER BY id) AS ids FROM staff_units WHERE office_id = $1)
           INSERT INTO supporters (office_id, staff_unit_id, full_name)
           SELECT $1, u.ids[1 + (g % $2::int)], 'پشتیبان ' || g FROM generate_series(1, $3::int) g, u`, [officeId, cfg.units, cfg.supporters]);
  await q(`INSERT INTO banks (office_id, name) SELECT $1, 'بانک ' || g FROM generate_series(1, 8) g`, [officeId]);
  await q(`INSERT INTO route_groups (office_id, name) SELECT $1, 'مسیر ' || g FROM generate_series(1, 20) g`, [officeId]);
  await q(`INSERT INTO activity_rules (office_id, bank_id, valid_from_period, min_monthly_amount) VALUES ($1, 0, 139801, 20000000)`, [officeId]);
  const password = randomBytes(9).toString('base64url');
  await q(`INSERT INTO users (office_id, username, password_hash, full_name, role) VALUES ($1, 'seed-admin', $2, 'مدیر آزمایشی', 'office_manager')`,
    [officeId, await hashPassword(password)]);
  lap('office, units, supporters, banks, routes');

  await q(`WITH s AS (SELECT array_agg(id ORDER BY id) AS ids FROM supporters WHERE office_id = $1),
                b AS (SELECT array_agg(id ORDER BY id) AS ids FROM banks WHERE office_id = $1),
                r AS (SELECT array_agg(id ORDER BY id) AS ids FROM route_groups WHERE office_id = $1)
           INSERT INTO terminals (office_id, terminal_no, owner_name, shop_name, route_group_id, bank_id, installed_at,
                                  current_supporter_id, current_unit_id, search_norm)
           SELECT $1, lpad(g::text, 8, '0'), 'مالک ' || g, 'فروشگاه ' || g,
                  r.ids[1 + g % array_length(r.ids, 1)], b.ids[1 + g % array_length(b.ids, 1)], DATE '2022-01-01' + (g % 900),
                  sp.id, sp.staff_unit_id, fa_normalize(lpad(g::text, 8, '0') || ' فروشگاه ' || g || ' مالک ' || g)
             FROM generate_series(1, $2::int) g CROSS JOIN s CROSS JOIN b CROSS JOIN r
             JOIN supporters sp ON sp.id = s.ids[1 + g % array_length(s.ids, 1)]`, [officeId, cfg.terminals]);
  await q(`INSERT INTO terminal_supporter_history (office_id, terminal_id, supporter_id, staff_unit_id, route_group_id, bank_id, start_date)
           SELECT office_id, id, current_supporter_id, current_unit_id, COALESCE(route_group_id, 0), COALESCE(bank_id, 0), installed_at
             FROM terminals WHERE office_id = $1`, [officeId]);
  lap(`${cfg.terminals} terminals + history`);

  const current = periodIdOfDate(today);
  const periods = (await q(
    `SELECT period_id, start_date::text AS sd, end_date::text AS ed, (end_date - start_date)::int AS days FROM periods
      WHERE end_date <= $1::date ORDER BY period_id DESC LIMIT $2`, [today, cfg.months])).rows as
    Array<{ period_id: number; sd: string; ed: string; days: number }>;
  periods.reverse();
  const cur = (await q('SELECT period_id, start_date::text AS sd, (end_date - start_date)::int AS days FROM periods WHERE period_id = $1', [current])).rows[0] as
    { period_id: number; sd: string; days: number } | undefined;
  for (const p of [...periods.map((x) => x.period_id), current]) await q('SELECT ensure_period_partition($1)', [p]);

  /** مبلغ شبه‌تصادفی ولی قطعی؛ ۵٪ ترمینال‌ها فایل ندارند؛ در آخرین ماه ۳٪ افت شدید (برای هشدار) */
  const snap = (dateSql: string) => `
    INSERT INTO transactions_snapshot (office_id, terminal_id, as_of_date, cum_amount, cum_count, source, import_batch_id)
    SELECT $1, t.id, ${dateSql}, a.amt, (a.amt / 150000)::int, 1, 0
      FROM terminals t
      CROSS JOIN LATERAL (SELECT floor(((((t.id * 7919 + $3::bigint * 104729) % 1000) + 100) * 50000 * (10 + ($3::int % 12)) / 10)
                              * CASE WHEN $4::boolean AND t.id % 33 = 0 THEN 0.4 ELSE 1 END * $5::numeric)::bigint AS amt) a
     WHERE t.office_id = $1 AND (t.id * 31 + $3::bigint * 17) % 20 <> 0 AND t.installed_at < $2::date`;
  for (const [i, p] of periods.entries()) {
    const last = i === periods.length - 1;
    await q(snap(`$2::date - 1`), [officeId, p.ed, i, last, 1]);
    if (i >= periods.length - 3) await q(snap(`$2::date - ${p.days - 14}`), [officeId, p.ed, i, last, 0.55]); // فایل روز ۱۵ برای منحنی پیشرفت ماه
  }
  if (cur) {
    const elapsed = (await q('SELECT ($1::date - $2::date)::int AS d', [today, cur.sd])).rows[0] as { d: number };
    if (elapsed.d >= 3) {
      await q(snap(`$2::date + ${elapsed.d - 1}`), [officeId, cur.sd, periods.length, false, Math.min(0.95, (elapsed.d / cur.days) * 0.9)]);
    }
  }
  const snaps = (await q('SELECT count(*)::bigint AS n FROM transactions_snapshot WHERE office_id = $1', [officeId])).rows[0] as { n: number };
  lap(`${snaps.n} snapshots over ${periods.length} complete months${cur ? ' + partial current month' : ''}`);

  await runRebuild({ pool, logger, today: () => today }, officeId);
  lap('aggregation rebuild');
  for (const t of ['transactions_snapshot', 'terminals', 'terminal_supporter_history', 'fact_terminal_month', 'agg_supporter_month', 'agg_unit_month', 'agg_office_month', 'terminal_alerts']) {
    await q(`ANALYZE ${t}`);
  }
  const counts = (await q(
    `SELECT (SELECT count(*) FROM fact_terminal_month WHERE office_id = $1)::bigint AS fact,
            (SELECT count(*) FROM agg_supporter_month WHERE office_id = $1)::bigint AS agg_sup,
            (SELECT count(*) FROM terminal_alerts WHERE office_id = $1)::bigint AS alerts`, [officeId])).rows[0];
  lap(`done: ${JSON.stringify(counts)}`);
  console.log(`\nدفتر: ${code}   کاربر: seed-admin   رمز: ${password}\n`);
} catch (err) {
  logger.error({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await pools.close();
}
