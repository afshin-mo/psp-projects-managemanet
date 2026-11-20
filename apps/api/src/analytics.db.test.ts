import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalStorage, createLogger, createTerminal, hashPassword, listPreliminaryAlerts, loadEnv, resolveFilter, runExportBuild,
  runRebuild, type JobQueue, type TenantContext,
} from '@pos/core';
import { createTestDb, type TestDb } from '@pos/core/testing';
import { projectMonth, type BankShareDto, type CoverageDto, type DailyDeltaDto, type DrillTerminalDto, type DroppedTerminalDto,
  type ExportJobDto, type GrowthItemDto, type HeatmapDto, type KpiDto, type Page, type PeriodMetrics, type TerminalMonthDto } from '@pos/shared';
import { buildApp } from './app';

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = 'Passw0rd!x';
const TODAY = '2025-08-10'; // ۱۹ مرداد ۱۴۰۴ ← ماه جاری 140405 (ناقص)
// دوره‌ها: 140401 [03-21,04-21) · 140402 [04-21,05-22) · 140403 [05-22,06-22) · 140404 [06-22,07-23) · 140405 [07-23,08-23)

interface Res<T> { status: number; body: T }
interface ErrBody { error: { code: string } }

describe.skipIf(!url)('API داشبورد تحلیلی', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let storage: LocalStorage;
  const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
  const queue: JobQueue = { enqueue: async (name, data) => { sent.push({ name, data }); } };
  let mgr = '', head1 = '', head2 = '', sup1 = '', empty = '';
  const id: Record<string, number> = {};

  async function call<T>(method: 'GET' | 'POST', p: string, token: string, body?: unknown): Promise<Res<T>> {
    const res = await app.inject({
      method, url: `/api/v1${p}`, headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as T };
  }
  const login = async (office: string, u: string) =>
    (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { officeCode: office, username: u, password: PASSWORD } })).json<{ accessToken: string }>().accessToken;
  const q = async <R,>(sql: string, v: unknown[] = []) => (await db.pool.query(sql, v)).rows as R[];

  beforeAll(async () => {
    db = await createTestDb();
    const env = loadEnv({
      DATABASE_URL: url as string, JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test', LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '100000', LOGIN_RATE_LIMIT_MAX: '1000',
    });
    const logger = createLogger(env, 'test');
    storage = new LocalStorage(mkdtempSync(path.join(os.tmpdir(), 'pos-an-')));
    app = await buildApp({ env, logger, pools: { write: db.pool, read: db.pool, hasReplica: false }, storage, queue, stagingSchema: db.schema });

    const ins = async (sql: string, v: unknown[] = []) => (await q<{ id: number }>(sql, v))[0]!.id;
    const office = await ins(`INSERT INTO offices (name, code) VALUES ('دفتر','AN') RETURNING id`);
    const office2 = await ins(`INSERT INTO offices (name, code) VALUES ('خالی','EMPTY') RETURNING id`);
    id.u1 = await ins(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد ۱') RETURNING id`, [office]);
    id.u2 = await ins(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد ۲') RETURNING id`, [office]);
    const sup = (n: string, u: number) => ins(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,$3) RETURNING id`, [office, u, n]);
    id.s1 = await sup('پشتیبان ۱', id.u1!); id.s2 = await sup('پشتیبان ۲', id.u1!); id.s3 = await sup('پشتیبان ۳', id.u2!);
    id.b1 = await ins(`INSERT INTO banks (office_id, name) VALUES ($1,'ملی') RETURNING id`, [office]);
    id.b2 = await ins(`INSERT INTO banks (office_id, name) VALUES ($1,'ملت') RETURNING id`, [office]);
    id.r1 = await ins(`INSERT INTO route_groups (office_id, name) VALUES ($1,'مسیر ۱') RETURNING id`, [office]);
    id.r2 = await ins(`INSERT INTO route_groups (office_id, name) VALUES ($1,'مسیر ۲') RETURNING id`, [office]);
    await db.pool.query(`INSERT INTO activity_rules (office_id, bank_id, valid_from_period, min_monthly_amount) VALUES ($1,0,140401,250)`, [office]);

    const hash = await hashPassword(PASSWORD);
    const user = (o: number, n: string, role: string, u: number | null, s: number | null) =>
      db.pool.query(`INSERT INTO users (office_id, username, password_hash, full_name, role, staff_unit_id, supporter_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [o, n, hash, n, role, u, s]);
    await user(office, 'mgr', 'office_manager', null, null);
    await user(office, 'head1', 'unit_head', id.u1!, null);
    await user(office, 'head2', 'unit_head', id.u2!, null);
    await user(office, 'sup1', 'supporter', null, id.s1!);
    await user(office2, 'mgr', 'office_manager', null, null);

    for (const p of [140401, 140402, 140403, 140404, 140405]) await db.pool.query('SELECT ensure_period_partition($1)', [p]);
    const ctx: TenantContext = { userId: 1, officeId: office, role: 'office_manager', unitId: null, supporterId: null };
    const mk = async (no: string, s: number, b: number, r: number) => {
      id[no] = (await createTerminal(ctx, db.pool, { terminalNo: no, supporterId: s, bankId: b, routeGroupId: r, installedAt: '2024-01-01' })).id;
    };
    await mk('A', id.s1!, id.b1!, id.r1!); await mk('B', id.s1!, id.b2!, id.r1!);
    await mk('C', id.s2!, id.b1!, id.r2!); await mk('D', id.s3!, id.b2!, id.r2!);

    // مانده‌ی تجمعی؛ تعداد = مبلغ/۱۰۰. فایل‌های میان‌ماهی (۰۶-۱۰ و ۰۷-۱۰) برای منحنی پیشرفت ماه
    const files: Array<[string, Record<string, number>]> = [
      ['2025-04-20', { A: 1000, B: 1000, C: 800, D: 200 }],
      ['2025-05-21', { A: 1000, B: 1000, C: 800, D: 200 }],
      ['2025-06-10', { A: 500, B: 250, C: 400, D: 100 }],
      ['2025-06-21', { A: 1000, B: 500, C: 800, D: 200 }],
      ['2025-07-10', { A: 600, B: 150, C: 400, D: 200 }],
      ['2025-07-22', { A: 1200, B: 300, C: 800, D: 400 }],
      ['2025-08-05', { A: 500, B: 100, C: 400, D: 100 }],
    ];
    for (const [date, vals] of files) {
      for (const [no, amount] of Object.entries(vals)) {
        await db.pool.query(
          `INSERT INTO transactions_snapshot (office_id, terminal_id, as_of_date, cum_amount, cum_count, source, import_batch_id) VALUES ($1,$2,$3,$4,$5,1,1)`,
          [office, id[no], date, amount, Math.round(amount / 100)]);
      }
    }
    await runRebuild({ pool: db.pool, logger, today: () => TODAY }, office);

    mgr = await login('AN', 'mgr'); head1 = await login('AN', 'head1'); head2 = await login('AN', 'head2');
    sup1 = await login('AN', 'sup1'); empty = await login('EMPTY', 'mgr');
    id.office = office;
  });
  afterAll(async () => { await app?.close(); await db?.cleanup(); });

  // ------------------------------------------------------------------ KPI
  it('KPI ماه کامل: مجموع بازه، MoM، YoY بدون مبنا = null', async () => {
    const r = await call<KpiDto>('GET', '/analytics/kpi?to=140404', mgr);
    expect(r.status).toBe(200);
    expect(r.body.range).toEqual({ from: 140305, to: 140404 }); // پیش‌فرض: ۱۲ ماه منتهی به to
    expect(r.body.totals).toEqual({ amount: 3000 + 3000 + 2500 + 2700, txCount: 30 + 30 + 25 + 27 });
    expect(r.body.current).toMatchObject({ periodId: 140404, amount: 2700, activeTerminals: 4, lowTerminals: 0, totalTerminals: 4, isComplete: true });
    expect(r.body.previous).toMatchObject({ periodId: 140403, amount: 2500, activeTerminals: 3, lowTerminals: 1 });
    expect(r.body.projection).toBeNull();
    expect(r.body.mom).toEqual({ basis: 'actual', amountPct: 8, txCountPct: 8, activeTerminalsPct: 33.33 });
    expect(r.body.yoy).toMatchObject({ amountPct: null, activeTerminalsPct: null });
  });

  it('KPI ماه ناقص: پیش‌بینی با منحنی، سپس خطی؛ مقایسه با ماه کامل بر پایه‌ی پیش‌بینی', async () => {
    const curve = await q<{ day: number; share: number }>('SELECT day_of_month AS day, share FROM month_progress_curve ORDER BY 1');
    expect(curve).toHaveLength(31);
    expect(curve[30]!.share).toBe(1);

    const r = await call<KpiDto>('GET', '/analytics/kpi', mgr); // پیش‌فرض: آخرین ماه (۱۴۰۴۰۵)
    expect(r.body.current).toMatchObject({ periodId: 140405, amount: 1100, isComplete: false });
    const expected = projectMonth({ amount: 1100, txCount: 11, daysCovered: 14, daysInMonth: 31, curve });
    expect(r.body.projection).toMatchObject({ method: 'curve', daysCovered: 14, daysInMonth: 31, asOfDate: '2025-08-05', projectedAmount: expected.amount });
    expect(r.body.mom.basis).toBe('projected');
    expect(r.body.mom.activeTerminalsPct).toBeNull();

    // بدون منحنی ← خطی. تغییر data_version کش را بی‌اعتبار می‌کند.
    await db.pool.query('DELETE FROM month_progress_curve');
    await db.pool.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [id.office]);
    const lin = await call<KpiDto>('GET', '/analytics/kpi', mgr);
    expect(lin.body.projection).toMatchObject({ method: 'linear', projectedAmount: 2436, projectedTxCount: 24 });
    expect(lin.body.mom).toMatchObject({ basis: 'projected', amountPct: -9.78 });
  });

  it('کش: نتیجه‌ی تکراری از کش می‌آید و با data_version جدید دوباره ساخته می‌شود', async () => {
    const count = async () => (await q<{ n: number }>('SELECT count(*)::int AS n FROM stats_cache'))[0]!.n;
    await call('GET', '/analytics/trend', mgr);
    const n1 = await count();
    await call('GET', '/analytics/trend', mgr);
    expect(await count()).toBe(n1);
    await db.pool.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [id.office]);
    await call('GET', '/analytics/trend', mgr);
    expect(await count()).toBe(n1 + 1);
  });

  // ------------------------------------------------------------------ روند، بانک، رشد، heatmap
  it('روند ماهانه و سهم بانک‌ها', async () => {
    const t = await call<PeriodMetrics[]>('GET', '/analytics/trend', mgr);
    expect(t.body.map((m) => m.amount)).toEqual([3000, 3000, 2500, 2700, 1100]);
    expect(t.body.map((m) => m.isComplete)).toEqual([true, true, true, true, false]);
    const b = await call<BankShareDto[]>('GET', '/analytics/bank-share?period=140404', mgr);
    expect(b.body.map((x) => [x.name, x.amount, x.sharePct])).toEqual([['ملی', 2000, 74.07], ['ملت', 700, 25.93]]);
  });

  it('رشد/افت هر پشتیبان، ستاد و مسیر؛ مرتب‌سازی با درصد', async () => {
    const s = await call<GrowthItemDto[]>('GET', '/analytics/growth?by=supporter&period=140404', mgr);
    expect(s.body.map((x) => [x.name, x.amount, x.previous, x.momPct])).toEqual([
      ['پشتیبان ۱', 1500, 1500, 0], ['پشتیبان ۲', 800, 800, 0], ['پشتیبان ۳', 400, 200, 100]]);
    const byPct = await call<GrowthItemDto[]>('GET', '/analytics/growth?by=supporter&period=140404&sort=pct_desc', mgr);
    expect(byPct.body.map((x) => x.name)).toEqual(['پشتیبان ۳', 'پشتیبان ۱', 'پشتیبان ۲']);
    const u = await call<GrowthItemDto[]>('GET', '/analytics/growth?by=unit&period=140404', mgr);
    expect(u.body.map((x) => [x.name, x.amount, x.momPct])).toEqual([['ستاد ۱', 2300, 0], ['ستاد ۲', 400, 100]]);
    const r = await call<GrowthItemDto[]>('GET', '/analytics/growth?by=route&period=140404', mgr);
    expect(r.body.map((x) => [x.name, x.amount, x.momPct])).toEqual([['مسیر ۱', 1500, 0], ['مسیر ۲', 1200, 20]]);
    // فیلتر بانک روی همان گزارش
    const f = await call<GrowthItemDto[]>('GET', `/analytics/growth?by=supporter&period=140404&bankId=${id.b1}`, mgr);
    expect(f.body.map((x) => [x.name, x.amount])).toEqual([['پشتیبان ۱', 1200], ['پشتیبان ۲', 800]]);
  });

  it('Heatmap پشتیبان × ماه', async () => {
    const h = await call<HeatmapDto>('GET', '/analytics/heatmap?metric=amount&from=140401', mgr);
    expect(h.body.periods).toEqual([140401, 140402, 140403, 140404, 140405]);
    const rows = Object.fromEntries(h.body.rows.map((r) => [r.name, r.values]));
    expect(rows['پشتیبان ۱']).toEqual([2000, 2000, 1500, 1500, 600]);
    expect(rows['پشتیبان ۳']).toEqual([200, 200, 200, 400, 100]);
  });

  // ------------------------------------------------------------------ drill-down
  it('drill-down: ستاد ← پشتیبان ← مسیر ← ترمینال با cursor', async () => {
    const sup = await call<{ items: GrowthItemDto[] }>('GET', `/analytics/drilldown?level=supporter&unitId=${id.u1}&period=140404`, mgr);
    expect(sup.body.items.map((x) => x.id).sort()).toEqual([id.s1, id.s2].sort());
    const route = await call<{ items: GrowthItemDto[] }>('GET', `/analytics/drilldown?level=route&supporterId=${id.s1}&period=140404`, mgr);
    expect(route.body.items.map((x) => x.id)).toEqual([id.r1]);

    const base = `/analytics/drilldown?level=terminal&supporterId=${id.s1}&routeGroupId=${id.r1}&period=140404&order=amount_desc&limit=1`;
    const p1 = await call<Page<DrillTerminalDto>>('GET', base, mgr);
    expect(p1.body.items).toMatchObject([{ terminalNo: 'A', amount: 1200, previousAmount: 1000, changePct: 20, activityClass: 1 }]);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await call<Page<DrillTerminalDto>>('GET', `${base}&cursor=${p1.body.nextCursor}`, mgr);
    expect(p2.body.items).toMatchObject([{ terminalNo: 'B', amount: 300, previousAmount: 500, changePct: -40 }]);
    expect(p2.body.nextCursor).toBeNull();
  });

  // ------------------------------------------------------------------ هشدارها و پوشش
  it('هشدار قطعی افت و دامنه‌ی نقش', async () => {
    const a = await call<Page<DroppedTerminalDto>>('GET', '/analytics/alerts/dropped-terminals?period=140404', mgr);
    expect(a.body.items).toMatchObject([{ terminalNo: 'B', avg3Amount: 833, currentAmount: 300, dropPct: 64 }]);
    expect((await call<Page<DroppedTerminalDto>>('GET', '/analytics/alerts/dropped-terminals?period=140404', head1)).body.items).toHaveLength(1);
    expect((await call<Page<DroppedTerminalDto>>('GET', '/analytics/alerts/dropped-terminals?period=140404', sup1)).body.items).toHaveLength(1);
    expect((await call<Page<DroppedTerminalDto>>('GET', '/analytics/alerts/dropped-terminals?period=140404', head2)).body.items).toHaveLength(0);
    // ماه ناقص هشدار قطعی ندارد
    expect((await call<Page<DroppedTerminalDto>>('GET', '/analytics/alerts/dropped-terminals', mgr)).body.items).toHaveLength(0);
  });

  it('هشدار مقدماتی ماه جاری: فقط از روز تنظیم‌شده و بر پایه‌ی پیش‌بینی', async () => {
    const ctx: TenantContext = { userId: 1, officeId: id.office!, role: 'office_manager', unitId: null, supporterId: null };
    const f = await resolveFilter(ctx, db.pool, {});
    const r = await listPreliminaryAlerts(ctx, db.pool, f, TODAY, { limit: 50 });
    expect(r.available).toBe(true);
    expect(r.items.map((x) => x.terminalNo)).toEqual(['B']);
    expect(r.items[0]!.projectedAmount).toBeGreaterThan(200);

    await db.pool.query('UPDATE office_settings SET preliminary_alert_min_day = 20 WHERE office_id = $1', [id.office]);
    const early = await listPreliminaryAlerts(ctx, db.pool, f, TODAY, { limit: 50 });
    expect(early).toMatchObject({ available: false, reason: 'TOO_EARLY', items: [] });
    await db.pool.query('UPDATE office_settings SET preliminary_alert_min_day = 10 WHERE office_id = $1', [id.office]);
  });

  it('پوشش فایل‌ها', async () => {
    const c = await call<CoverageDto[]>('GET', '/analytics/coverage', mgr);
    expect(c.body[0]).toMatchObject({ periodId: 140405, lastFileDate: '2025-08-05', terminals: 4, incomplete: 4, isComplete: false });
    expect(c.body[1]).toMatchObject({ periodId: 140404, lastFileDate: '2025-07-22', incomplete: 0, isComplete: true });
  });

  // ------------------------------------------------------------------ دامنه‌ی نقش
  it('دامنه‌ی نقش: مسئول ستاد و پشتیبان فقط داده‌ی خودشان؛ فیلتر دامنه را گسترش نمی‌دهد', async () => {
    expect((await call<KpiDto>('GET', '/analytics/kpi?to=140404', head2)).body.current).toMatchObject({ amount: 400, totalTerminals: 1 });
    expect((await call<KpiDto>('GET', '/analytics/kpi?to=140404', sup1)).body.current).toMatchObject({ amount: 1500, totalTerminals: 2 });
    expect((await call<KpiDto>('GET', `/analytics/kpi?to=140404&supporterId=${id.s1}`, head2)).body.current).toBeNull();
    const g = await call<GrowthItemDto[]>('GET', '/analytics/growth?by=supporter&period=140404', head2);
    expect(g.body.map((x) => x.name)).toEqual(['پشتیبان ۳']);
    const hm = await call<HeatmapDto>('GET', '/analytics/heatmap?from=140401', head1);
    expect(hm.body.rows.map((r) => r.name).sort()).toEqual(['پشتیبان ۱', 'پشتیبان ۲']);
    const t = await call<Page<DrillTerminalDto>>('GET', '/analytics/drilldown?level=terminal&period=140404', head2);
    expect(t.body.items.map((x) => x.terminalNo)).toEqual(['D']);
  });

  it('دفتر بدون داده: NO_DATA؛ ورودی نامعتبر: ۴۰۰', async () => {
    const r = await call<ErrBody>('GET', '/analytics/kpi', empty);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NO_DATA');
    expect((await call<ErrBody>('GET', '/analytics/kpi?to=140413', mgr)).status).toBe(400);
    expect((await call<ErrBody>('GET', '/analytics/kpi?from=140404&to=140401', mgr)).status).toBe(400);
    expect((await call<ErrBody>('GET', '/analytics/drilldown', mgr)).status).toBe(400);
  });

  // ------------------------------------------------------------------ سطح ترمینال
  it('سری ماهانه و تفاضل روزانه‌ی یک ترمینال (مرز ماه شمسی و فاصله‌ی چندروزه)', async () => {
    const m = await call<TerminalMonthDto[]>('GET', `/terminals/${id.A}/monthly`, mgr);
    expect(m.body.map((x) => [x.periodId, x.amount])).toEqual([[140401, 1000], [140402, 1000], [140403, 1000], [140404, 1200], [140405, 500]]);

    const d = await call<DailyDeltaDto[]>('GET', `/terminals/${id.A}/daily-deltas?from=2025-06-22&to=2025-07-23`, mgr);
    expect(d.body).toEqual([
      { asOfDate: '2025-07-10', deltaAmount: 600, deltaCount: 6, spanDays: 19, estimated: true },
      { asOfDate: '2025-07-22', deltaAmount: 600, deltaCount: 6, spanDays: 12, estimated: true },
    ]);
    // شروع بازه وسط ماه: تفاضل همچنان نسبت به فایل قبلی همان ماه حساب می‌شود
    const mid = await call<DailyDeltaDto[]>('GET', `/terminals/${id.A}/daily-deltas?from=2025-07-15&to=2025-07-23`, mgr);
    expect(mid.body).toMatchObject([{ asOfDate: '2025-07-22', deltaAmount: 600, spanDays: 12 }]);

    expect((await call<ErrBody>('GET', `/terminals/${id.A}/daily-deltas?from=2025-01-01&to=2025-07-23`, mgr)).status).toBe(400);
    expect((await call('GET', `/terminals/${id.A}/monthly`, head2)).status).toBe(404); // ترمینال ستاد دیگر
  });

  // ------------------------------------------------------------------ خروجی اکسل
  it('خروجی کوچک: xlsx مستقیم؛ خروجی بزرگ: job ← Worker ← دانلود فقط توسط سازنده', async () => {
    const x = await app.inject({ method: 'GET', url: '/api/v1/analytics/export?report=trend', headers: { authorization: `Bearer ${mgr}` } });
    expect(x.statusCode).toBe(200);
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const h = await app.inject({ method: 'GET', url: '/api/v1/analytics/export?report=heatmap&from=140401', headers: { authorization: `Bearer ${head1}` } });
    expect(h.rawPayload.subarray(0, 2).toString()).toBe('PK');

    const created = await call<ExportJobDto>('POST', '/exports', mgr, { kind: 'terminals_month', period: 140404 });
    expect(created.status).toBe(202);
    expect(sent.at(-1)).toMatchObject({ name: 'export.build', data: { jobId: created.body.id } });
    expect((await call<ErrBody>('GET', `/exports/${created.body.id}/download`, mgr)).status).toBe(409); // هنوز ساخته نشده

    await runExportBuild({ pool: db.pool, storage, logger: createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }, 't') }, created.body.id);
    const job = await call<ExportJobDto>('GET', `/exports/${created.body.id}`, mgr);
    expect(job.body).toMatchObject({ status: 'done', rowCount: 4 });
    const dl = await app.inject({ method: 'GET', url: `/api/v1/exports/${created.body.id}/download`, headers: { authorization: `Bearer ${mgr}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await call('GET', `/exports/${created.body.id}`, head1)).status).toBe(404); // فقط سازنده

    // خروجی مسئول ستاد فقط ترمینال‌های ستان خودش
    const c2 = await call<ExportJobDto>('POST', '/exports', head2, { kind: 'terminals_month', period: 140404 });
    await runExportBuild({ pool: db.pool, storage, logger: createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }, 't') }, c2.body.id);
    expect((await call<ExportJobDto>('GET', `/exports/${c2.body.id}`, head2)).body.rowCount).toBe(1);
  });
});
