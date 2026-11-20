import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyActivity, pickThreshold, type ActivityRule } from '@pos/shared';
import { createLogger } from '../logging/pino';
import { assignTerminal, createTerminal } from '../repos/terminals';
import { createTestDb, type TestDb } from '../testing';
import type { TenantContext } from '../tenant/scope';
import {
  findOfficesWithPendingWork, runAggregateOffice, runReclassify, runRebuild, runRollover, type AggDeps,
} from './jobs';

const url = process.env.TEST_DATABASE_URL;
const TODAY = '2025-08-10'; // ۱۹ مرداد ۱۴۰۴ → دوره‌ی جاری 140405
// دوره‌ها: 140401 [03-21,04-21) · 140402 [04-21,05-22) · 140403 [05-22,06-22) · 140404 [06-22,07-23) · 140405 [07-23,08-23)

describe.skipIf(!url)('تجمیع آماری: fact، agg، طبقه‌بندی، هشدار', () => {
  let db: TestDb;
  let deps: AggDeps;
  let ctx: TenantContext;
  let officeId = 0;
  let s1 = 0, s2 = 0, u1 = 0, u2 = 0, bank1 = 0;
  const T: Record<string, number> = {};

  const q = async <R,>(sql: string, v: unknown[] = []) => (await db.pool.query(sql, v)).rows as R[];
  const one = async <R,>(sql: string, v: unknown[] = []) => (await q<R>(sql, v))[0];

  const snap = (id: number, date: string, amount: number, count: number, source = 1) =>
    db.pool.query(
      `INSERT INTO transactions_snapshot (office_id, terminal_id, as_of_date, cum_amount, cum_count, source, import_batch_id)
       VALUES ($1,$2,$3,$4,$5,$6,1)
       ON CONFLICT (office_id, terminal_id, as_of_date) DO UPDATE SET cum_amount = EXCLUDED.cum_amount, cum_count = EXCLUDED.cum_count`,
      [officeId, id, date, amount, count, source]);

  const fact = (no: string, period: number) =>
    one<{ amount: number; cls: number; complete: boolean; sup: number; unit: number }>(
      `SELECT f.amount, f.activity_class AS cls, f.is_complete AS complete, f.supporter_id AS sup, f.staff_unit_id AS unit
         FROM fact_terminal_month f JOIN terminals t ON t.id = f.terminal_id WHERE t.terminal_no = $1 AND f.period_id = $2`,
      [no, period]);

  /** مجموع هر سه سطح تجمیع باید با fact برابر باشد */
  async function invariants(): Promise<void> {
    const f = await q(`SELECT period_id, sum(amount)::bigint AS a, sum(tx_count)::bigint AS c, count(*)::bigint AS n
                         FROM fact_terminal_month GROUP BY period_id ORDER BY period_id`);
    for (const t of ['agg_supporter_month', 'agg_unit_month', 'agg_office_month']) {
      const a = await q(`SELECT period_id, sum(amount)::bigint AS a, sum(tx_count)::bigint AS c,
                                sum(active_terminals + low_terminals + returned_terminals + new_terminals)::bigint AS n
                           FROM ${t} GROUP BY period_id ORDER BY period_id`);
      expect(a, t).toEqual(f);
    }
  }

  beforeAll(async () => {
    db = await createTestDb();
    const logger = createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }, 'test');
    deps = { pool: db.pool, logger, today: () => TODAY };
    officeId = (await one<{ id: number }>(`INSERT INTO offices (name, code) VALUES ('دفتر','AGG') RETURNING id`))!.id;
    u1 = (await one<{ id: number }>(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد ۱') RETURNING id`, [officeId]))!.id;
    u2 = (await one<{ id: number }>(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد ۲') RETURNING id`, [officeId]))!.id;
    s1 = (await one<{ id: number }>(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,'پ۱') RETURNING id`, [officeId, u1]))!.id;
    s2 = (await one<{ id: number }>(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,'پ۲') RETURNING id`, [officeId, u2]))!.id;
    bank1 = (await one<{ id: number }>(`INSERT INTO banks (office_id, name) VALUES ($1,'بانک ۱') RETURNING id`, [officeId]))!.id;
    await db.pool.query(`INSERT INTO activity_rules (office_id, bank_id, valid_from_period, min_monthly_amount) VALUES ($1,0,140401,100000),($1,$2,140401,500000)`, [officeId, bank1]);
    for (const p of [140401, 140402, 140403, 140404, 140405, 140406]) await db.pool.query('SELECT ensure_period_partition($1)', [p]);
    ctx = { userId: 1, officeId, role: 'office_manager', unitId: null, supporterId: null };

    const mk = async (no: string, extra: Record<string, unknown>) => {
      T[no] = (await createTerminal(ctx, db.pool, { terminalNo: no, supporterId: s1, ...extra })).id;
    };
    await mk('T1', { bankId: bank1, installedAt: '2024-01-01' });
    await mk('T2', { installedAt: '2024-01-01' });
    await mk('T3', { installedAt: '2025-07-20' });
    await mk('T4', { installedAt: '2024-01-01' });
    await mk('T5', {});
    // T5 تاریخ نصب ندارد؛ برای ثبات تست، «تاریخ ایجاد» آن را دور می‌کنیم تا ردیف صفر نگیرد
    await db.pool.query(`UPDATE terminals SET created_at = '2030-01-01' WHERE id = $1`, [T.T5]);
    await db.pool.query(`UPDATE terminals SET status = 'returned', returned_at = '2025-06-30' WHERE id = $1`, [T.T4]);
    await assignTerminal(ctx, db.pool, T.T5!, { supporterId: s2, effectiveDate: '2025-07-23' }, TODAY);

    for (const [d, a, c] of [['2025-04-20', 1_000_000, 10], ['2025-05-21', 1_200_000, 12], ['2025-06-21', 1_100_000, 11], ['2025-07-22', 300_000, 3], ['2025-08-05', 100_000, 1]] as const) await snap(T.T1!, d, a, c);
    await snap(T.T2!, '2025-07-22', 50, 1);
    await snap(T.T3!, '2025-07-22', 10, 1);
    await snap(T.T4!, '2025-06-21', 500, 1);
    await snap(T.T4!, '2025-07-10', 20, 1);
    await snap(T.T5!, '2025-07-22', 700, 2);
    await snap(T.T5!, '2025-08-05', 100, 1);
  });
  afterAll(async () => { await db?.cleanup(); });

  it('rebuild: طبقه‌بندی، ردیف صفر، snapshot ابعاد، کامل/ناقص، قاعده‌ی نوپا و برگشتی', async () => {
    const r = await runRebuild(deps, officeId);
    expect(r.periods).toEqual([140401, 140402, 140403, 140404, 140405]);

    // T1: آستانه‌ی بانک ۱ = ۵۰۰٬۰۰۰
    const t1 = await Promise.all([140401, 140402, 140403, 140404, 140405].map((p) => fact('T1', p)));
    expect(t1.map((x) => x?.cls)).toEqual([1, 1, 1, 2, 2]);
    expect(t1.map((x) => x?.complete)).toEqual([true, true, true, true, false]); // ۰۸-۰۵ آخرین روز ماه نیست

    // T2: آستانه‌ی پیش‌فرض ۱۰۰٬۰۰۰؛ ماه‌های بدون فایل ردیف صفر دارند
    for (const p of [140401, 140402, 140403]) expect(await fact('T2', p)).toMatchObject({ amount: 0, cls: 2, complete: false });
    expect(await fact('T2', 140404)).toMatchObject({ amount: 50, cls: 2 });

    // T3: نصب ۰۷-۲۰ = روز ۲۹ ماه ← نوپا؛ قبل از نصب ردیفی ندارد
    expect(await fact('T3', 140403)).toBeUndefined();
    expect(await fact('T3', 140404)).toMatchObject({ amount: 10, cls: 4 });
    expect(await fact('T3', 140405)).toMatchObject({ amount: 0, cls: 2 });

    // T4: انصراف ۰۶-۳۰ (در تیر) ← تیر برگشتی؛ بعد از ماه انصراف ردیفی ندارد
    expect(await fact('T4', 140403)).toMatchObject({ amount: 500, cls: 2 });
    expect(await fact('T4', 140404)).toMatchObject({ amount: 20, cls: 3 });
    expect(await fact('T4', 140405)).toBeUndefined();

    // T5: تعویض پشتیبان با اعمال از ۰۷-۲۳ (شروع مرداد): تیر برای پشتیبان قبلی، مرداد برای جدید
    expect(await fact('T5', 140403)).toBeUndefined();
    expect(await fact('T5', 140404)).toMatchObject({ sup: s1, unit: u1 });
    expect(await fact('T5', 140405)).toMatchObject({ sup: s2, unit: u2 });

    const off = await one<{ low: number; ret: number; neu: number; act: number; inc: number }>(
      `SELECT sum(low_terminals)::int AS low, sum(returned_terminals)::int AS ret, sum(new_terminals)::int AS neu,
              sum(active_terminals)::int AS act, sum(incomplete_terminals)::int AS inc
         FROM agg_office_month WHERE period_id = 140404`);
    expect(off).toEqual({ low: 3, ret: 1, neu: 1, act: 0, inc: 1 }); // T4 فایلش آخر ماه نیست
    await invariants();
  });

  it('هشدار افت: فقط ماه کامل، غیربرگشتی، افت > ۳۰٪ نسبت به میانگین ۳ ماه قبل', async () => {
    const rows = await q<{ no: string; period_id: number; avg3_amount: number; cur_amount: number; drop_pct: string }>(
      `SELECT t.terminal_no AS no, a.period_id, a.avg3_amount, a.cur_amount, a.drop_pct
         FROM terminal_alerts a JOIN terminals t ON t.id = a.terminal_id ORDER BY 1, 2`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ no: 'T1', period_id: 140404, avg3_amount: 1_100_000, cur_amount: 300_000 });
    expect(Number(rows[0]!.drop_pct)).toBeCloseTo(72.73, 2);
  });

  it('ایدمپوتنت: rebuild دوباره هیچ ردیفی را تغییر نمی‌دهد', async () => {
    const snapshot = () => one<{ n: number; sum: number; ts: string; al: number }>(
      `SELECT count(*)::int AS n, sum(amount)::bigint AS sum, max(computed_at)::text AS ts,
              (SELECT count(*) FROM terminal_alerts)::int AS al FROM fact_terminal_month`);
    const before = await snapshot();
    await runRebuild(deps, officeId);
    expect(await snapshot()).toEqual(before);
    await invariants();
  });

  it('افزایشی: فقط کلیدهای دسته‌ی ایمپورت و رویدادهای outbox بازمحاسبه می‌شوند', async () => {
    await snap(T.T2!, '2025-08-08', 90_000, 3);
    const batch = (await one<{ id: number }>(
      `INSERT INTO import_batches (office_id, type, status, file_name, file_size, file_hash, file_kind, storage_key, options, created_by)
       VALUES ($1,'transactions_cumulative','aggregating','f',1,$2,'csv','k','{}',1) RETURNING id`,
      [officeId, 'a'.repeat(64)]))!.id;
    await db.pool.query('INSERT INTO import_batch_affected (batch_id, terminal_id, period_id) VALUES ($1,$2,140405)', [batch, T.T2]);

    const untouched = await one<{ ts: string }>(`SELECT computed_at::text AS ts FROM fact_terminal_month WHERE terminal_id = $1 AND period_id = 140401`, [T.T1]);
    const dv = await one<{ v: number }>('SELECT data_version AS v FROM offices WHERE id = $1', [officeId]);

    const r = await runAggregateOffice(deps, officeId);
    expect(r.rounds).toBeGreaterThanOrEqual(1);
    expect(await fact('T2', 140405)).toMatchObject({ amount: 90_000, cls: 2 });
    expect((await one<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [batch]))!.status).toBe('completed');
    expect((await one<{ v: number }>('SELECT data_version AS v FROM offices WHERE id = $1', [officeId]))!.v).toBeGreaterThan(dv!.v);
    expect(await one<{ ts: string }>(`SELECT computed_at::text AS ts FROM fact_terminal_month WHERE terminal_id = $1 AND period_id = 140401`, [T.T1])).toEqual(untouched);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM recompute_outbox WHERE processed_at IS NULL'))!.n).toBe(0);
    await invariants();
  });

  it('تعویض پشتیبان: ماه تغییر به بعد برای پشتیبان جدید، ماه‌های قبل دست‌نخورده', async () => {
    await assignTerminal(ctx, db.pool, T.T1!, { supporterId: s2, effectiveDate: '2025-07-23' }, TODAY);
    expect((await findOfficesWithPendingWork(db.pool))).toEqual([officeId]);
    await runAggregateOffice(deps, officeId);
    expect(await findOfficesWithPendingWork(db.pool)).toEqual([]);

    expect(await fact('T1', 140403)).toMatchObject({ sup: s1 });
    expect(await fact('T1', 140404)).toMatchObject({ sup: s1, unit: u1 });
    expect(await fact('T1', 140405)).toMatchObject({ sup: s2, unit: u2 });
    const sum = (sup: number, p: number) => one<{ a: number }>(
      `SELECT COALESCE(sum(amount), 0)::bigint AS a FROM agg_supporter_month WHERE supporter_id = $1 AND period_id = $2`, [sup, p]);
    expect((await sum(s1, 140404))!.a).toBe(300_000 + 50 + 10 + 20 + 700); // T1,T2,T3,T4,T5 هنوز زیر پ۱
    expect((await sum(s2, 140405))!.a).toBe(100_000 + 100);                // T1 و T5 در مرداد
    await invariants();
  });

  it('بازطبقه‌بندی با تغییر آستانه و روز نوپا', async () => {
    await db.pool.query(`UPDATE activity_rules SET min_monthly_amount = 600 WHERE office_id = $1 AND bank_id = 0`, [officeId]);
    await db.pool.query(`UPDATE office_settings SET new_terminal_cutoff_day = 30 WHERE office_id = $1`, [officeId]);
    await runReclassify(deps, officeId, 0);
    expect(await fact('T5', 140404)).toMatchObject({ cls: 1 }); // 700 ≥ 600
    expect(await fact('T3', 140404)).toMatchObject({ cls: 2 }); // دیگر نوپا نیست (روز ۲۹ < ۳۰)
    expect(await fact('T2', 140404)).toMatchObject({ cls: 2 });
    await invariants();
  });

  it('تابع خالص classifyActivity با SQL هم‌ارز است (روی همه‌ی ردیف‌ها)', async () => {
    const rules = await q<ActivityRule>(
      `SELECT bank_id AS "bankId", valid_from_period AS "validFromPeriod", min_monthly_amount AS "minMonthlyAmount" FROM activity_rules`);
    const cutoff = (await one<{ d: number }>('SELECT new_terminal_cutoff_day AS d FROM office_settings'))!.d;
    const rows = await q<{ cls: number; amount: number; period_id: number; bank_id: number; inst: string | null; ret: string | null; ps: string; pe: string }>(
      `SELECT f.activity_class AS cls, f.amount, f.period_id, f.bank_id, t.installed_at::text AS inst, t.returned_at::text AS ret,
              p.start_date::text AS ps, p.end_date::text AS pe
         FROM fact_terminal_month f JOIN terminals t ON t.id = f.terminal_id JOIN periods p ON p.period_id = f.period_id`);
    expect(rows.length).toBeGreaterThan(15);
    for (const r of rows) {
      const js = classifyActivity({
        amount: r.amount, threshold: pickThreshold(rules, r.bank_id, r.period_id), installedAt: r.inst, returnedAt: r.ret,
        periodStart: r.ps, periodEnd: r.pe, cutoffDay: cutoff,
      });
      expect(js, `${r.period_id}/${r.amount}`).toBe(r.cls);
    }
  });

  it('rollover ماه جدید: ردیف صفر فقط برای ترمینال‌های موجه', async () => {
    const next: AggDeps = { ...deps, today: () => '2025-09-01' }; // 140406
    const r = await runRollover(next, officeId);
    expect(r.created).toBe(3);
    for (const no of ['T1', 'T2', 'T3']) expect(await fact(no, 140406)).toMatchObject({ amount: 0 });
    expect(await fact('T1', 140406)).toMatchObject({ sup: s2 }); // پشتیبان مؤثر امروز
    expect(await fact('T4', 140406)).toBeUndefined(); // انصراف قبل از شروع ماه
    expect(await fact('T5', 140406)).toBeUndefined(); // نصب‌نشده و ایجادنشده
    expect((await runRollover(next, officeId)).created).toBe(0); // دوباره: چیزی ساخته نمی‌شود
    await invariants();
  });
});
