import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalStorage, createLogger, createTerminal, hashPassword, loadEnv, runForecastJob, type JobQueue, type TenantContext,
} from '@pos/core';
import { createTestDb, type TestDb } from '@pos/core/testing';
import {
  todayInTehran, type BulkResultDto, type ForecastDto, type ForecastRunDto, type ForecastSummaryDto, type Page,
  type ProjectAlertDto, type ProjectDto, type ProjectImportResultDto, type ProjectMatrixDto, type ProjectProgressDto,
  type ProjectTerminalDto, type ProjectTrendDto, type TerminalDto, type TransferUnitResultDto,
} from '@pos/shared';
import { buildApp } from './app';

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = 'Passw0rd!x';
const BOUNDARY = '----posPhase5Boundary';
const TODAY = todayInTehran();

interface Res<T> { status: number; body: T }
interface ErrBody { error: { code: string; details?: { failureCount?: number; failures?: Array<{ code: string }> } } }

function multipart(fields: Record<string, string>, file: { name: string; data: Buffer }): { payload: Buffer; headers: Record<string, string> } {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(file.data, Buffer.from('\r\n'), Buffer.from(`--${BOUNDARY}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } };
}

describe.skipIf(!url)('فاز ۵: انصراف، ویرایش گروهی، انتقال، پروژه، پیش‌بینی', () => {
  let db: TestDb;
  let app: FastifyInstance;
  const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
  const queue: JobQueue = { enqueue: async (name, data) => { sent.push({ name, data }); } };
  let mgr = '', head1 = '', head2 = '', sup1 = '';
  let officeId = 0;
  const id: Record<string, number> = {};

  async function call<T>(method: 'GET' | 'POST' | 'PATCH', p: string, token: string, body?: unknown): Promise<Res<T>> {
    const res = await app.inject({
      method, url: `/api/v1${p}`, headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as T };
  }
  const login = async (u: string): Promise<string> =>
    (await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { officeCode: 'P5', username: u, password: PASSWORD } })).json<{ accessToken: string }>().accessToken;
  const q = async <R,>(sql: string, v: unknown[] = []): Promise<R[]> => (await db.pool.query(sql, v)).rows as R[];

  beforeAll(async () => {
    db = await createTestDb();
    const env = loadEnv({
      DATABASE_URL: url as string, JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test', LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '100000', LOGIN_RATE_LIMIT_MAX: '1000',
    });
    const storage = new LocalStorage(mkdtempSync(path.join(os.tmpdir(), 'pos-p5-')));
    app = await buildApp({ env, logger: createLogger(env, 'test'), pools: { write: db.pool, read: db.pool, hasReplica: false }, storage, queue, stagingSchema: db.schema });

    const ins = async (sql: string, v: unknown[] = []): Promise<number> => (await q<{ id: number }>(sql, v))[0]!.id;
    officeId = await ins(`INSERT INTO offices (name, code) VALUES ('دفتر ۵','P5') RETURNING id`);
    id.u1 = await ins(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد ۱') RETURNING id`, [officeId]);
    id.u2 = await ins(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد ۲') RETURNING id`, [officeId]);
    const sup = (n: string, u: number) => ins(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,$3) RETURNING id`, [officeId, u, n]);
    id.s1 = await sup('پشتیبان ۱', id.u1!); id.s2 = await sup('پشتیبان ۲', id.u1!); id.s3 = await sup('پشتیبان ۳', id.u2!);

    const hash = await hashPassword(PASSWORD);
    const user = (n: string, role: string, u: number | null, s: number | null) =>
      db.pool.query(`INSERT INTO users (office_id, username, password_hash, full_name, role, staff_unit_id, supporter_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [officeId, n, hash, n, role, u, s]);
    await user('mgr', 'office_manager', null, null);
    await user('head1', 'unit_head', id.u1!, null);
    await user('head2', 'unit_head', id.u2!, null);
    await user('sup1', 'supporter', null, id.s1!);
    [mgr, head1, head2, sup1] = await Promise.all([login('mgr'), login('head1'), login('head2'), login('sup1')]);

    const ctx: TenantContext = { userId: 1, officeId, role: 'office_manager', unitId: null, supporterId: null };
    const mk = async (no: string, s: number): Promise<void> => {
      id[no] = (await createTerminal(ctx, db.pool, { terminalNo: no, supporterId: s, installedAt: '2024-01-01' })).id;
    };
    await mk('A', id.s1!); await mk('B', id.s1!); await mk('C', id.s1!); await mk('D', id.s2!); await mk('E', id.s3!); await mk('R', id.s1!);
  });

  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });

  // ---------------------------------------------------------------- انصراف / برگشت
  describe('انصراف و لغو آن', () => {
    it('ثبت انصراف: وضعیت، دلیل، و رویداد outbox', async () => {
      const r = await call<TerminalDto>('POST', `/terminals/${id.R}/return`, mgr, { returnedAt: '2025-03-01', reason: 'بستن فروشگاه' });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('returned');
      expect(r.body.returnedAt).toBe('2025-03-01');
      expect(r.body.returnReason).toBe('بستن فروشگاه');
      const ob = await q<{ reason: string; effective_date: string }>(
        `SELECT reason, effective_date FROM recompute_outbox WHERE terminal_id = $1 AND reason = 'returned_at'`, [id.R]);
      expect(ob).toHaveLength(1);
      expect(ob[0]!.effective_date).toBe('2025-03-01');
    });

    it('انصراف دوباره، تاریخ آینده و قبل از نصب رد می‌شود', async () => {
      expect((await call<ErrBody>('POST', `/terminals/${id.R}/return`, mgr, {})).body.error.code).toBe('ALREADY_RETURNED');
      const future = (await call<ErrBody>('POST', `/terminals/${id.A}/return`, mgr, { returnedAt: '2999-01-01' }));
      expect(future.status).toBe(422);
      expect(future.body.error.code).toBe('FUTURE_RETURN_DATE');
      expect((await call<ErrBody>('POST', `/terminals/${id.A}/return`, mgr, { returnedAt: '2023-01-01' })).body.error.code).toBe('RETURN_BEFORE_INSTALL');
    });

    it('پشتیبان نمی‌تواند انصراف ثبت کند؛ مسئول ستاد دیگر هم به ترمینال ستاد دیگر دسترسی ندارد', async () => {
      expect((await call<ErrBody>('POST', `/terminals/${id.A}/return`, sup1, {})).status).toBe(403);
      expect((await call<ErrBody>('POST', `/terminals/${id.A}/return`, head2, {})).status).toBe(404);
    });

    it('لغو انصراف: فعال می‌شود و دوباره‌ی آن خطا می‌دهد', async () => {
      const r = await call<TerminalDto>('POST', `/terminals/${id.R}/reactivate`, mgr, {});
      expect(r.body.status).toBe('active');
      expect(r.body.returnedAt).toBeNull();
      expect(r.body.returnReason).toBeNull();
      expect((await call<ErrBody>('POST', `/terminals/${id.R}/reactivate`, mgr, {})).body.error.code).toBe('NOT_RETURNED');
      const ob = await q(`SELECT 1 FROM recompute_outbox WHERE terminal_id = $1 AND reason = 'returned_at'`, [id.R]);
      expect(ob).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------- پروژه
  describe('مدیریت پروژه', () => {
    let p1 = 0;
    let p2 = 0;

    it('ساخت پروژه: فقط مدیر؛ نام تکراری و بازه‌ی نامعتبر رد می‌شود', async () => {
      const r = await call<ProjectDto>('POST', '/projects', mgr, { name: 'تعویض کارت‌خوان', startDate: '2025-01-01', dueDate: '2030-12-31' });
      expect(r.status).toBe(201);
      p1 = r.body.id;
      expect(r.body.total).toBe(0);
      expect((await call<ErrBody>('POST', '/projects', head1, { name: 'x', startDate: '2025-01-01', dueDate: '2025-02-01' })).status).toBe(403);
      expect((await call<ErrBody>('POST', '/projects', mgr, { name: 'تعویض کارت‌خوان', startDate: '2025-01-01', dueDate: '2030-12-31' })).body.error.code).toBe('DUPLICATE');
      expect((await call<ErrBody>('POST', '/projects', mgr, { name: 'y', startDate: '2025-02-01', dueDate: '2025-01-01' })).status).toBe(400);
      const r2 = await call<ProjectDto>('POST', '/projects', mgr, { name: 'پروژه‌ی گذشته', startDate: '2020-01-01', dueDate: '2020-12-31' });
      p2 = r2.body.id;
      expect(r2.body.lag.level).toBe('on_track'); // بدون ترمینال، عقب‌افتادگی بی‌معنی است
    });

    it('افزودن ترمینال با شماره: ناشناخته گزارش می‌شود و افزودن دوباره بی‌اثر است', async () => {
      const r = await call<ProjectImportResultDto>('POST', `/projects/${p1}/terminals`, mgr, { terminalNos: ['A', 'B', 'C', 'D', 'E', 'ZZZ'] });
      expect(r.status).toBe(200);
      expect(r.body.added).toBe(5);
      expect(r.body.unknown).toEqual(['ZZZ']);
      const again = await call<ProjectImportResultDto>('POST', `/projects/${p1}/terminals`, mgr, { terminalIds: [id.A, id.B] });
      expect(again.body.added).toBe(0);
      expect(again.body.alreadyInProject).toBe(2);
      // پروژه‌ی گذشته فقط ترمینال E را دارد
      await call('POST', `/projects/${p2}/terminals`, mgr, { terminalIds: [id.E] });
    });

    it('ایمپورت فایل CSV: وضعیت ترمینال جدید/موجود، ردیف نامعتبر و ناشناخته', async () => {
      const p3 = (await call<ProjectDto>('POST', '/projects', mgr, { name: 'پروژه‌ی فایل', startDate: '2025-01-01', dueDate: '2030-01-01' })).body.id;
      const csv = ['شماره ترمینال,وضعیت,توضیح', 'A,انجام شده,ok', 'B,,', 'QQQ,,', 'C,نامعلوم,', ',,'].join('\n');
      const m = multipart({ type: 'project_terminals' }, { name: 'p.csv', data: Buffer.from(csv, 'utf8') });
      const res = await app.inject({ method: 'POST', url: `/api/v1/projects/${p3}/terminals/import`, payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${mgr}` } });
      expect(res.statusCode).toBe(200);
      const body = res.json<ProjectImportResultDto>();
      expect(body.added).toBe(2); // A (done) و B
      expect(body.unknown).toEqual(['QQQ']);
      expect(body.invalidCount).toBe(1); // C با وضعیت نامعلوم (ردیف خالی نادیده گرفته می‌شود)
      const list = await call<Page<ProjectTerminalDto>>('GET', `/projects/${p3}/terminals`, mgr);
      expect(list.body.items.find((t) => t.terminalNo === 'A')?.status).toBe('done');
      expect(list.body.items.find((t) => t.terminalNo === 'A')?.note).toBe('ok');

      // بدون فیلد type قبل از فایل: رد می‌شود
      const bad = multipart({}, { name: 'p.csv', data: Buffer.from(csv, 'utf8') });
      const r2 = await app.inject({ method: 'POST', url: `/api/v1/projects/${p3}/terminals/import`, payload: bad.payload, headers: { ...bad.headers, authorization: `Bearer ${mgr}` } });
      expect(r2.statusCode).toBe(400);
    });

    it('تغییر وضعیت: پشتیبان فقط ترمینال خودش؛ مسئول ستاد فقط ستاد خودش؛ همه یا هیچ', async () => {
      const own = await call<BulkResultDto>('PATCH', `/projects/${p1}/terminals/${id.A}`, sup1, { status: 'in_progress', note: 'شروع شد' });
      expect(own.status).toBe(200);
      expect(own.body.updated).toBe(1);
      const other = await call<ErrBody>('PATCH', `/projects/${p1}/terminals/${id.D}`, sup1, { status: 'done' });
      expect(other.status).toBe(422);
      expect(other.body.error.code).toBe('TERMINALS_NOT_IN_PROJECT');

      const bulk = await call<BulkResultDto>('POST', `/projects/${p1}/terminals/status`, head1, { terminalIds: [id.B, id.C, id.D], status: 'done' });
      expect(bulk.body.updated).toBe(3);
      // E در ستاد ۲ است؛ همراه ترمینال معتبر هم باشد کل عملیات رد می‌شود و چیزی تغییر نمی‌کند
      const mixed = await call<ErrBody>('POST', `/projects/${p1}/terminals/status`, head1, { terminalIds: [id.A, id.E], status: 'done' });
      expect(mixed.status).toBe(422);
      const a = await q<{ status: string }>('SELECT status FROM project_terminals WHERE project_id = $1 AND terminal_id = $2', [p1, id.A]);
      expect(a[0]!.status).toBe('in_progress');
      // تاریخچه‌ی تغییر
      const ev = await q('SELECT 1 FROM project_terminal_events WHERE project_id = $1', [p1]);
      expect(ev).toHaveLength(4);
      // تکرار همان وضعیت: بدون تغییر
      const same = await call<BulkResultDto>('POST', `/projects/${p1}/terminals/status`, head1, { terminalIds: [id.B], status: 'done' });
      expect(same.body).toEqual({ updated: 0, unchanged: 1 });
    });

    it('پیشرفت پروژه: قیف و تفکیک پشتیبان با رعایت دامنه‌ی نقش', async () => {
      const full = await call<ProjectProgressDto>('GET', `/projects/${p1}/progress`, mgr);
      expect(full.body.project.total).toBe(5);
      expect(full.body.project.done).toBe(3);
      expect(full.body.project.inProgress).toBe(1);
      expect(full.body.project.notStarted).toBe(1);
      expect(full.body.funnel).toEqual([{ key: 'total', count: 5 }, { key: 'started', count: 4 }, { key: 'done', count: 3 }]);
      expect(full.body.bySupporter).toHaveLength(3);

      expect((await call<ProjectProgressDto>('GET', `/projects/${p1}/progress`, head1)).body.project.total).toBe(4);
      expect((await call<ProjectProgressDto>('GET', `/projects/${p1}/progress`, sup1)).body.project.total).toBe(3);
      expect((await call<ProjectProgressDto>('GET', `/projects/${p1}/progress`, head2)).body.project.total).toBe(1);
    });

    it('روند پیشرفت پشتیبان‌ها: نقطه‌ی آخر با وضعیت فعلی برابر است و دامنه‌ی نقش رعایت می‌شود', async () => {
      const r = await call<ProjectTrendDto>('GET', `/projects/${p1}/trend`, mgr);
      expect(r.status).toBe(200);
      const t = r.body;
      expect(t.dates[t.dates.length - 1]).toBe(TODAY);
      expect(t.expectedPct).toHaveLength(t.dates.length);
      expect(t.supporters).toHaveLength(3);
      for (const s of t.supporters) expect(s.values).toHaveLength(t.dates.length);
      const last = Object.fromEntries(t.supporters.map((s) => [s.supporterId, s.values[s.values.length - 1]]));
      expect(last[id.s1!]).toBeCloseTo(66.7, 1); // A در حال انجام، B و C انجام‌شده
      expect(last[id.s2!]).toBe(100); // D انجام‌شده
      expect(last[id.s3!]).toBe(0); // E شروع‌نشده
      const mine = await call<ProjectTrendDto>('GET', `/projects/${p1}/trend`, sup1);
      expect(mine.body.supporters.map((s) => s.supporterId)).toEqual([id.s1]);
    });

    it('ماتریس و هشدار عقب‌افتادگی (پروژه‌ی گذشته → overdue)', async () => {
      const m = await call<ProjectMatrixDto>('GET', '/projects/matrix', mgr);
      expect(m.body.projects.map((p) => p.id)).toContain(p1);
      const idx2 = m.body.projects.findIndex((p) => p.id === p2);
      const rowS3 = m.body.rows.find((r) => r.supporterId === id.s3);
      expect(rowS3?.cells[idx2]?.total).toBe(1);
      expect(rowS3?.cells[idx2]?.level).toBe('overdue');

      const al = await call<ProjectAlertDto[]>('GET', '/projects/alerts', mgr);
      const mine = al.body.find((a) => a.projectId === p2 && a.supporterId === id.s3);
      expect(mine?.level).toBe('overdue');
      expect(mine?.remaining).toBe(1);
      // مسئول ستاد ۱ هشدار ستاد ۲ را نمی‌بیند
      expect((await call<ProjectAlertDto[]>('GET', '/projects/alerts', head1)).body.some((a) => a.supporterId === id.s3)).toBe(false);
    });

    it('بستن پروژه: تغییر وضعیت ترمینال‌ها دیگر مجاز نیست', async () => {
      const r = await call<ProjectDto>('PATCH', `/projects/${p2}`, mgr, { status: 'closed' });
      expect(r.body.status).toBe('closed');
      const e = await call<ErrBody>('POST', `/projects/${p2}/terminals/status`, mgr, { terminalIds: [id.E], status: 'done' });
      expect(e.status).toBe(409);
      expect(e.body.error.code).toBe('PROJECT_NOT_ACTIVE');
    });
  });

  // ---------------------------------------------------------------- ویرایش گروهی و انتقال
  describe('ویرایش گروهی و انتقال بین ستادها', () => {
    const hist = (tid: number) => q<{ supporter_id: number; staff_unit_id: number; end_date: string | null }>(
      'SELECT supporter_id, staff_unit_id, end_date FROM terminal_supporter_history WHERE terminal_id = $1 ORDER BY start_date', [tid]);

    it('تعویض گروهی پشتیبان: همه‌ی ترمینال‌ها و تاریخچه', async () => {
      const r = await call<BulkResultDto>('POST', '/terminals/bulk/assign', mgr, { terminalIds: [id.B, id.C], supporterId: id.s2 });
      expect(r.body).toEqual({ updated: 2, unchanged: 0 });
      const h = await hist(id.B!);
      expect(h).toHaveLength(2);
      expect(h[0]!.supporter_id).toBe(id.s1);
      expect(h[0]!.end_date).toBe(TODAY);
      expect(h[1]!.supporter_id).toBe(id.s2);
    });

    it('همه یا هیچ: یک شناسه‌ی نامعتبر کل عملیات را برمی‌گرداند', async () => {
      const r = await call<ErrBody>('POST', '/terminals/bulk/assign', mgr, { terminalIds: [id.D, 99_999_999], supporterId: id.s1 });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('BULK_FAILED');
      expect(r.body.error.details?.failureCount).toBe(1);
      const d = await q<{ current_supporter_id: number }>('SELECT current_supporter_id FROM terminals WHERE id = $1', [id.D]);
      expect(d[0]!.current_supporter_id).toBe(id.s2);
    });

    it('مسئول ستاد نمی‌تواند به پشتیبان ستاد دیگر منتقل کند؛ بدون تغییر = unchanged', async () => {
      const r = await call<ErrBody>('POST', '/terminals/bulk/assign', head1, { terminalIds: [id.A], supporterId: id.s3 });
      expect(r.status).toBe(422);
      expect(r.body.error.details?.failures?.[0]?.code).toBe('FORBIDDEN');
      const same = await call<BulkResultDto>('POST', '/terminals/bulk/assign', mgr, { terminalIds: [id.B], supporterId: id.s2 });
      expect(same.body).toEqual({ updated: 0, unchanged: 1 });
    });

    it('انتقال ترمینال‌های یک پشتیبان به پشتیبان ستاد دیگر', async () => {
      const r = await call<BulkResultDto>('POST', `/supporters/${id.s2}/transfer-terminals`, mgr, { toSupporterId: id.s3 });
      expect(r.body.updated).toBe(3); // D و B و C
      const rows = await q<{ current_supporter_id: number; current_unit_id: number }>(
        'SELECT current_supporter_id, current_unit_id FROM terminals WHERE id = ANY($1::bigint[])', [[id.B, id.C, id.D]]);
      expect(rows.every((x) => x.current_supporter_id === id.s3 && x.current_unit_id === id.u2)).toBe(true);
      expect((await call<ErrBody>('POST', `/supporters/${id.s3}/transfer-terminals`, mgr, { toSupporterId: id.s3 })).body.error.code).toBe('SAME_SUPPORTER');
      // ترمینالی که مال این پشتیبان نیست
      expect((await call<ErrBody>('POST', `/supporters/${id.s1}/transfer-terminals`, mgr, { toSupporterId: id.s2, terminalIds: [id.E] })).body.error.code).toBe('TERMINALS_NOT_OWNED');
    });

    it('انتقال پشتیبان به ستاد دیگر: ترمینال‌ها، تاریخچه و ماه‌های قبل', async () => {
      const r = await call<TransferUnitResultDto>('POST', `/supporters/${id.s3}/transfer-unit`, mgr, { toUnitId: id.u1 });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ terminals: 4, clamped: 3, fromUnitId: id.u2, toUnitId: id.u1 });

      expect((await q<{ staff_unit_id: number }>('SELECT staff_unit_id FROM supporters WHERE id = $1', [id.s3]))[0]!.staff_unit_id).toBe(id.u1);
      const cur = await q<{ current_unit_id: number }>('SELECT DISTINCT current_unit_id FROM terminals WHERE current_supporter_id = $1', [id.s3]);
      expect(cur).toEqual([{ current_unit_id: id.u1 }]);
      const open = await q<{ staff_unit_id: number }>(
        'SELECT DISTINCT staff_unit_id FROM terminal_supporter_history WHERE supporter_id = $1 AND end_date IS NULL', [id.s3]);
      expect(open).toEqual([{ staff_unit_id: id.u1 }]);
      // ترمینال E: ردیف قبلی با ستاد ۲ بسته شده (گذشته دست‌نخورده) و ردیف جدید با ستاد ۱
      const e = await hist(id.E!);
      expect(e).toHaveLength(2);
      expect(e[0]!.staff_unit_id).toBe(id.u2);
      expect(e[0]!.end_date).toBe(TODAY);
      expect(e[1]!.staff_unit_id).toBe(id.u1);
    });

    it('انتقال به همان ستاد، و نقش مسئول ستاد: رد می‌شود', async () => {
      expect((await call<ErrBody>('POST', `/supporters/${id.s3}/transfer-unit`, mgr, { toUnitId: id.u1 })).body.error.code).toBe('NO_CHANGE');
      expect((await call<ErrBody>('POST', `/supporters/${id.s3}/transfer-unit`, head2, { toUnitId: id.u2 })).status).toBe(403);
      expect((await call<ErrBody>('POST', `/supporters/${id.s3}/transfer-unit`, mgr, { toUnitId: 99_999 })).body.error.code).toBe('INVALID_UNIT');
    });
  });

  // ---------------------------------------------------------------- پیش‌بینی
  describe('پیش‌بینی', () => {
    // ۱۶ ماه کامل ۱۴۰۱۰۱ تا ۱۴۰۴۱۲ (۱۲ ماه سال ۱۴۰۱ + ۴ ماه ۱۴۰۲)؛ روند صعودی
    const periods = [...Array.from({ length: 12 }, (_, i) => 140101 + i), 140201, 140202, 140203, 140204];
    const amountAt = (i: number): number => 1_000_000 + i * 50_000;

    beforeAll(async () => {
      for (const [i, pid] of periods.entries()) {
        const a = amountAt(i);
        await db.pool.query(
          `INSERT INTO agg_office_month (office_id, period_id, route_group_id, bank_id, amount, tx_count, active_terminals, low_terminals, returned_terminals, new_terminals, incomplete_terminals)
           VALUES ($1,$2,0,0,$3,10,5,0,0,0,0)`, [officeId, pid, a]);
        await db.pool.query(
          `INSERT INTO agg_unit_month (office_id, period_id, staff_unit_id, route_group_id, bank_id, amount, tx_count, active_terminals, low_terminals, returned_terminals, new_terminals, incomplete_terminals)
           VALUES ($1,$2,$3,0,0,$4,10,5,0,0,0,0)`, [officeId, pid, id.u1, a]);
        await db.pool.query(
          `INSERT INTO agg_supporter_month (office_id, period_id, supporter_id, staff_unit_id, route_group_id, bank_id, amount, tx_count, active_terminals, low_terminals, returned_terminals, new_terminals, incomplete_terminals)
           VALUES ($1,$2,$3,$4,0,0,$5,10,5,0,0,0,0)`, [officeId, pid, id.s1, id.u1, a]);
        // پشتیبان ۲: ۳ ماه آخر صفر (غیرفعال) → پیش‌بینی نمی‌شود
        await db.pool.query(
          `INSERT INTO agg_supporter_month (office_id, period_id, supporter_id, staff_unit_id, route_group_id, bank_id, amount, tx_count, active_terminals, low_terminals, returned_terminals, new_terminals, incomplete_terminals)
           VALUES ($1,$2,$3,$4,0,0,$5,1,1,0,0,0,0)`, [officeId, pid, id.s2, id.u1, i < 13 ? 100_000 : 0]);
      }
    });

    it('اجرای job: نتیجه‌ی دفتر/ستاد/پشتیبان ذخیره می‌شود و پشتیبان غیرفعال کنار می‌ماند', async () => {
      sent.length = 0;
      const run = await call<ForecastRunDto>('POST', '/forecast/run', mgr, { horizon: 6 });
      expect(run.status).toBe(202);
      expect(sent.find((s) => s.name === 'forecast.run')?.data.runId).toBe(run.body.id);
      // اجرای هم‌زمان دوم رد می‌شود
      expect((await call<ErrBody>('POST', '/forecast/run', mgr, {})).body.error.code).toBe('FORECAST_RUNNING');
      expect((await call<ErrBody>('POST', '/forecast/run', head1, {})).status).toBe(403);

      await runForecastJob({ pool: db.pool, logger: createLogger(loadEnv({ DATABASE_URL: url as string, JWT_SECRET: 'x'.repeat(40), LOG_LEVEL: 'silent' }), 'test') }, run.body.id);
      const st = await call<{ run: ForecastRunDto }>('GET', '/forecast/status', mgr);
      expect(st.body.run.status).toBe('done');
      expect(st.body.run.basePeriod).toBe(140204);
      expect(st.body.run.seriesCount).toBe(3); // دفتر + ستاد ۱ + پشتیبان ۱
    });

    it('GET /forecast: سابقه + ۶ ماه پیش‌بینی با روند صعودی', async () => {
      const r = await call<ForecastDto>('GET', '/forecast?scope=office', mgr);
      expect(r.status).toBe(200);
      expect(r.body.history).toHaveLength(16);
      expect(r.body.history.every((h) => h.isComplete)).toBe(true);
      expect(r.body.forecast.map((f) => f.periodId)).toEqual([140205, 140206, 140207, 140208, 140209, 140210]);
      expect(r.body.basePeriod).toBe(140204);
      const last = amountAt(15);
      expect(r.body.forecast[0]!.value).toBeGreaterThan(last);
      expect(r.body.forecast[0]!.lower).toBeLessThanOrEqual(r.body.forecast[0]!.value);
      expect(r.body.forecast[0]!.upper).toBeGreaterThanOrEqual(r.body.forecast[0]!.value);
    });

    it('دامنه‌ی دسترسی: پشتیبان فقط خودش، مسئول ستاد فقط ستاد خودش', async () => {
      expect((await call<ErrBody>('GET', '/forecast?scope=office', sup1)).status).toBe(403);
      expect((await call<ErrBody>('GET', '/forecast?scope=office', head1)).status).toBe(403);
      expect((await call<ForecastDto>('GET', `/forecast?scope=supporter&id=${id.s1}`, sup1)).status).toBe(200);
      expect((await call<ErrBody>('GET', `/forecast?scope=supporter&id=${id.s2}`, sup1)).status).toBe(404);
      expect((await call<ForecastDto>('GET', `/forecast?scope=unit&id=${id.u1}`, head1)).status).toBe(200);
      expect((await call<ErrBody>('GET', `/forecast?scope=unit&id=${id.u2}`, head1)).status).toBe(403);
      expect((await call<ErrBody>('GET', '/forecast?scope=unit', mgr)).body.error.code).toBe('ID_REQUIRED');
    });

    it('خلاصه‌ی پشتیبان‌ها: ماه بعد در برابر آخرین ماه واقعی', async () => {
      const r = await call<ForecastSummaryDto[]>('GET', '/forecast/summary?scope=supporter', mgr);
      expect(r.body).toHaveLength(1);
      expect(r.body[0]!.scopeId).toBe(id.s1);
      expect(r.body[0]!.targetPeriod).toBe(140205);
      expect(r.body[0]!.lastActual).toBe(amountAt(15));
      expect(r.body[0]!.changePct).not.toBeNull();
      expect((await call<ForecastSummaryDto[]>('GET', '/forecast/summary?scope=supporter', sup1)).body).toHaveLength(1);
      expect((await call<ForecastSummaryDto[]>('GET', '/forecast/summary?scope=supporter', head2)).body).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------- ورود فقط با نام کاربری
  describe('ورود با نام کاربری و رمز (بدون کد دفتر)', () => {
    const login = async (body: Record<string, unknown>): Promise<{ status: number; body: { accessToken?: string; user?: { role: string }; error?: { code: string } } }> => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: body });
      return { status: res.statusCode, body: res.json() };
    };

    it('بدون کد دفتر وارد می‌شود', async () => {
      const r = await login({ username: 'mgr', password: PASSWORD });
      expect(r.status).toBe(200);
      expect(r.body.user?.role).toBe('office_manager');
    });

    it('رمز غلط و نام ناموجود: همان ۴۰۱ یکسان', async () => {
      expect((await login({ username: 'mgr', password: 'wrong-password' })).body.error?.code).toBe('INVALID_CREDENTIALS');
      expect((await login({ username: 'ghost', password: PASSWORD })).body.error?.code).toBe('INVALID_CREDENTIALS');
    });

    it('همان نام کاربری و همان رمز در دو دفتر: ۴۰۹ و درخواست کد دفتر؛ با کد دفتر موفق', async () => {
      const o2 = (await q<{ id: number }>(`INSERT INTO offices (name, code) VALUES ('دفتر دوم','P5B') RETURNING id`))[0]!.id;
      await db.pool.query(`INSERT INTO users (office_id, username, password_hash, full_name, role) VALUES ($1,'mgr',$2,'مدیر دوم','office_manager')`,
        [o2, await hashPassword(PASSWORD)]);
      const amb = await login({ username: 'mgr', password: PASSWORD });
      expect(amb.status).toBe(409);
      expect(amb.body.error?.code).toBe('OFFICE_REQUIRED');
      expect((await login({ officeCode: 'P5B', username: 'mgr', password: PASSWORD })).status).toBe(200);
      expect((await login({ officeCode: 'P5', username: 'mgr', password: PASSWORD })).status).toBe(200);
      // رمز غلط حتی با نام کاربری تکراری چیزی درباره‌ی دفترها لو نمی‌دهد
      expect((await login({ username: 'mgr', password: 'wrong-password' })).status).toBe(401);
    });
  });
});
