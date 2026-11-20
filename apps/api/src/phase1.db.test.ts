import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage, createLogger, hashPassword, loadEnv, type JobQueue } from '@pos/core';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, type TestDb } from '@pos/core/testing';
import { todayInTehran, type Page, type TerminalDto, type TerminalHistoryDto, type AuditDto } from '@pos/shared';
import { buildApp } from './app';

/** تست یکپارچه‌ی فاز ۱ روی PostgreSQL واقعی (فقط با TEST_DATABASE_URL اجرا می‌شود). */
const url = process.env.TEST_DATABASE_URL;
const PASSWORD = 'Passw0rd!x';

interface Res<T> { status: number; body: T }
interface ErrBody { error: { code: string } }

describe.skipIf(!url)('Phase 1: auth، دسترسی، ترمینال، تاریخچه', () => {
  let db: TestDb;
  let app: FastifyInstance;
  const ids = { officeA: 0, officeB: 0, unitA1: 0, unitA2: 0, supA1: 0, supA2: 0, supB1: 0 };
  let mgrA = '', headA1 = '', supA1Token = '', mgrB = '', sysadmin = '';

  async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, token?: string, body?: unknown): Promise<Res<T>> {
    const res = await app.inject({
      method, url: `/api/v1${path}`,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as T };
  }
  async function login(officeCode: string | undefined, username: string): Promise<string> {
    const r = await call<{ accessToken: string }>('POST', '/auth/login', undefined, { officeCode, username, password: PASSWORD });
    expect(r.status).toBe(200);
    return r.body.accessToken;
  }
  const newTerminal = (token: string, no: string, supporterId: number, extra: Record<string, unknown> = {}) =>
    call<TerminalDto>('POST', '/terminals', token, { terminalNo: no, supporterId, ...extra });

  beforeAll(async () => {
    db = await createTestDb();
    const env = loadEnv({
      DATABASE_URL: url as string, JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test', LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '100000', LOGIN_RATE_LIMIT_MAX: '1000',
    });
    app = await buildApp({ env, logger: createLogger(env, 'test'), pools: { write: db.pool, read: db.pool, hasReplica: false },
      storage: new LocalStorage(mkdtempSync(path.join(os.tmpdir(), 'pos-p1-'))), queue: { enqueue: async () => undefined } as JobQueue,
      stagingSchema: db.schema });

    const q = async <R,>(sql: string, v: unknown[] = []): Promise<R> => ((await db.pool.query(sql, v)).rows[0] as R);
    const id = async (sql: string, v: unknown[]): Promise<number> => (await q<{ id: number }>(sql, v)).id;
    ids.officeA = await id(`INSERT INTO offices (name, code) VALUES ('دفتر الف','OA') RETURNING id`, []);
    ids.officeB = await id(`INSERT INTO offices (name, code) VALUES ('دفتر ب','OB') RETURNING id`, []);
    ids.unitA1 = await id(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد ۱') RETURNING id`, [ids.officeA]);
    ids.unitA2 = await id(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد ۲') RETURNING id`, [ids.officeA]);
    const unitB1 = await id(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد ب') RETURNING id`, [ids.officeB]);
    ids.supA1 = await id(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,'پشتیبان ۱') RETURNING id`, [ids.officeA, ids.unitA1]);
    ids.supA2 = await id(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,'پشتیبان ۲') RETURNING id`, [ids.officeA, ids.unitA2]);
    ids.supB1 = await id(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,'پشتیبان ب') RETURNING id`, [ids.officeB, unitB1]);

    const hash = await hashPassword(PASSWORD);
    const user = (office: number | null, name: string, role: string, unit: number | null, sup: number | null) =>
      db.pool.query(`INSERT INTO users (office_id, username, password_hash, full_name, role, staff_unit_id, supporter_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [office, name, hash, name, role, unit, sup]);
    await user(ids.officeA, 'mgra', 'office_manager', null, null);
    await user(ids.officeA, 'heada1', 'unit_head', ids.unitA1, null);
    await user(ids.officeA, 'supa1', 'supporter', null, ids.supA1);
    await user(ids.officeB, 'mgrb', 'office_manager', null, null);
    await user(null, 'central', 'system_admin', null, null);
    mgrA = await login('OA', 'mgra');
    headA1 = await login('OA', 'heada1');
    supA1Token = await login('OA', 'supa1');
    mgrB = await login('OB', 'mgrb');
    sysadmin = await login(undefined, 'central');
  });

  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });

  // ------------------------------------------------------------ احراز هویت
  it('ورود: رمز غلط و کاربر ناموجود پاسخ یکسان دارند', async () => {
    const bad = await call<ErrBody>('POST', '/auth/login', undefined, { officeCode: 'OA', username: 'mgra', password: 'wrong-password' });
    const none = await call<ErrBody>('POST', '/auth/login', undefined, { officeCode: 'OA', username: 'ghost', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(bad.body.error.code).toBe(none.body.error.code);
  });

  it('refresh token می‌چرخد؛ استفاده‌ی دوباره از توکن قدیمی همه‌ی نشست‌ها را باطل می‌کند', async () => {
    const l = await call<{ refreshToken: string }>('POST', '/auth/login', undefined, { officeCode: 'OA', username: 'mgra', password: PASSWORD });
    const r1 = await call<{ refreshToken: string; accessToken: string }>('POST', '/auth/refresh', undefined, { refreshToken: l.body.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(l.body.refreshToken);
    const replay = await call<ErrBody>('POST', '/auth/refresh', undefined, { refreshToken: l.body.refreshToken });
    expect(replay.status).toBe(401);
    const afterReplay = await call<ErrBody>('POST', '/auth/refresh', undefined, { refreshToken: r1.body.refreshToken });
    expect(afterReplay.status).toBe(401);
  });

  it('بدون توکن 401 و با ورودی نامعتبر 400', async () => {
    expect((await call('GET', '/terminals')).status).toBe(401);
    const r = await call<ErrBody>('POST', '/terminals', mgrA, { terminalNo: '1' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ------------------------------------------------------------ ترمینال
  it('شماره ترمینال نرمال می‌شود، صفر اول حفظ می‌شود و تکراری رد می‌شود', async () => {
    const a = await newTerminal(mgrA, '۰۰۱۲۳', ids.supA1);
    expect(a.status).toBe(201);
    expect(a.body.terminalNo).toBe('00123');
    expect(a.body.supporterId).toBe(ids.supA1);
    expect(a.body.unitId).toBe(ids.unitA1);
    const dup = await newTerminal(mgrA, '00 123', ids.supA1);
    expect(dup.status).toBe(409);
  });

  it('همان شماره در دفتر دیگر مجاز است (یکتایی per-office)', async () => {
    expect((await newTerminal(mgrB, '00123', ids.supB1)).status).toBe(201);
  });

  it('پشتیبان دفتر دیگر پذیرفته نمی‌شود', async () => {
    const r = await newTerminal(mgrA, '77701', ids.supB1);
    expect(r.status).toBe(422);
  });

  it('جستجوی فارسی: ی/ک عربی و فارسی یکسان‌اند', async () => {
    await newTerminal(mgrA, '55501', ids.supA1, { shopName: 'فروشگاه كوروش', ownerName: 'عليرضا احمدي' });
    for (const q of ['کوروش', 'كوروش', 'علیرضا', '55501']) {
      const r = await call<Page<TerminalDto>>('GET', `/terminals?q=${encodeURIComponent(q)}`, mgrA);
      expect(r.body.items.map((t) => t.terminalNo)).toContain('55501');
    }
    const none = await call<Page<TerminalDto>>('GET', `/terminals?q=${encodeURIComponent('وجودندارد')}`, mgrA);
    expect(none.body.items).toHaveLength(0);
  });

  it('cursor pagination: بدون تکرار و بدون افتادگی', async () => {
    for (let i = 0; i < 5; i += 1) await newTerminal(mgrA, `9900${i}`, ids.supA1);
    const all = await call<Page<TerminalDto>>('GET', '/terminals?limit=200', mgrA);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Res<Page<TerminalDto>> = await call<Page<TerminalDto>>('GET', `/terminals?limit=2${cursor ? `&cursor=${cursor}` : ''}`, mgrA);
      seen.push(...r.body.items.map((t) => t.id));
      cursor = r.body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(seen).toEqual(all.body.items.map((t) => t.id));
    expect(pages).toBeGreaterThan(2);
    expect((await call<ErrBody>('GET', '/terminals?cursor=!!!', mgrA)).status).toBe(400);
  });

  // ------------------------------------------------------------ دسترسی
  it('ایزوله‌ی دفترها: مدیر دفتر ب ترمینال دفتر الف را نمی‌بیند', async () => {
    const t = await newTerminal(mgrA, '31001', ids.supA1);
    expect((await call('GET', `/terminals/${t.body.id}`, mgrB)).status).toBe(404);
    const list = await call<Page<TerminalDto>>('GET', '/terminals?limit=200', mgrB);
    expect(list.body.items.every((x) => x.terminalNo === '00123')).toBe(true);
  });

  it('مسئول ستاد فقط ترمینال‌های ستان خودش را می‌بیند و نمی‌تواند دامنه را با فیلتر گسترش دهد', async () => {
    const t1 = await newTerminal(mgrA, '32001', ids.supA1);
    const t2 = await newTerminal(mgrA, '32002', ids.supA2);
    const list = await call<Page<TerminalDto>>('GET', '/terminals?limit=200', headA1);
    const nos = list.body.items.map((t) => t.terminalNo);
    expect(nos).toContain('32001');
    expect(nos).not.toContain('32002');
    const forced = await call<Page<TerminalDto>>('GET', `/terminals?unitId=${ids.unitA2}`, headA1);
    expect(forced.body.items).toHaveLength(0);
    expect((await call('GET', `/terminals/${t2.body.id}`, headA1)).status).toBe(404);
    expect((await call('GET', `/terminals/${t1.body.id}`, headA1)).status).toBe(200);
    expect((await newTerminal(headA1, '32003', ids.supA2)).status).toBe(403);
  });

  it('پشتیبان فقط ترمینال‌های خودش را می‌بیند و نمی‌تواند چیزی بسازد', async () => {
    const list = await call<Page<TerminalDto>>('GET', '/terminals?limit=200', supA1Token);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items.every((t) => t.supporterId === ids.supA1)).toBe(true);
    expect((await newTerminal(supA1Token, '33001', ids.supA1)).status).toBe(403);
    expect((await call('GET', '/users', supA1Token)).status).toBe(403);
  });

  it('کاربر ستاد مرکزی به داده‌ی دفترها دسترسی ندارد', async () => {
    expect((await call('GET', '/terminals', sysadmin)).status).toBe(403);
    expect((await call('GET', '/staff-units', sysadmin)).status).toBe(403);
  });

  it('داده‌ی پایه: مسئول ستاد فقط ستاد و پشتیبانان خودش را می‌بیند؛ بانک و مسیر مشترک است', async () => {
    const units = await call<Array<{ id: number }>>('GET', '/staff-units', headA1);
    expect(units.body.map((u) => u.id)).toEqual([ids.unitA1]);
    const sups = await call<Array<{ id: number }>>('GET', '/supporters', headA1);
    expect(sups.body.map((s) => s.id)).toEqual([ids.supA1]);
    expect((await call('POST', '/banks', mgrA, { name: 'بانک ملی' })).status).toBe(201);
    expect((await call<unknown[]>('GET', '/banks', supA1Token)).body).toHaveLength(1);
    expect((await call('POST', '/banks', headA1, { name: 'x' })).status).toBe(403);
  });

  // ------------------------------------------------------------ تعویض پشتیبان (SCD2)
  it('تعویض پشتیبان: تاریخچه، همان‌روز، قبل از شروع، بدون تغییر، outbox و audit', async () => {
    const today = todayInTehran();
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const t = await newTerminal(mgrA, '40001', ids.supA1);
    const id = t.body.id;

    const moved = await call<TerminalDto>('POST', `/terminals/${id}/assignments`, mgrA, { supporterId: ids.supA2 });
    expect(moved.status).toBe(200);
    expect(moved.body.supporterId).toBe(ids.supA2);
    expect(moved.body.unitId).toBe(ids.unitA2);

    let hist = (await call<TerminalHistoryDto[]>('GET', `/terminals/${id}/history`, mgrA)).body;
    expect(hist).toHaveLength(2);
    expect(hist[0]).toMatchObject({ supporterId: ids.supA1, endDate: today });
    expect(hist[1]).toMatchObject({ supporterId: ids.supA2, startDate: today, endDate: null });

    // همان روز دوباره: ردیف جاری اصلاح می‌شود، ردیف جدید نمی‌سازد
    await call('POST', `/terminals/${id}/assignments`, mgrA, { supporterId: ids.supA1 });
    hist = (await call<TerminalHistoryDto[]>('GET', `/terminals/${id}/history`, mgrA)).body;
    expect(hist).toHaveLength(2);
    expect(hist[1]).toMatchObject({ supporterId: ids.supA1, endDate: null });

    const before = await call<ErrBody>('POST', `/terminals/${id}/assignments`, mgrA, { supporterId: ids.supA2, effectiveDate: yesterday });
    expect(before.status).toBe(409);
    expect(before.body.error.code).toBe('EFFECTIVE_BEFORE_START');

    const same = await call<ErrBody>('POST', `/terminals/${id}/assignments`, mgrA, { supporterId: ids.supA1 });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('NO_CHANGE');

    const future = await call<ErrBody>('POST', `/terminals/${id}/assignments`, mgrA, { supporterId: ids.supA2, effectiveDate: '2999-01-01' });
    expect(future.status).toBe(422);

    const outbox = await db.pool.query('SELECT count(*)::int AS n FROM recompute_outbox WHERE terminal_id = $1 AND reason = $2', [id, 'assignment']);
    expect((outbox.rows[0] as { n: number }).n).toBe(2);

    const audit = await call<Page<AuditDto>>('GET', `/terminals/${id}/audit`, mgrA);
    const actions = audit.body.items.map((a) => a.action);
    expect(actions).toContain('create');
    expect(actions.filter((a) => a === 'assign')).toHaveLength(2);
    expect((await call('GET', `/terminals/${id}/audit`, supA1Token)).status).toBe(403);
  });

  it('مسئول ستاد نمی‌تواند ترمینال را به پشتیبان ستاد دیگر بدهد', async () => {
    const t = await newTerminal(mgrA, '41001', ids.supA1);
    const r = await call<ErrBody>('POST', `/terminals/${t.body.id}/assignments`, headA1, { supporterId: ids.supA2 });
    expect(r.status).toBe(403);
  });

  it('تعویض مسیر/بانک بدون تغییر پشتیبان در تاریخچه ثبت می‌شود', async () => {
    const bank = await call<{ id: number }>('POST', '/banks', mgrA, { name: 'بانک تست مسیر' });
    const route = await call<{ id: number }>('POST', '/route-groups', mgrA, { name: 'مسیر ۱' });
    const t = await newTerminal(mgrA, '42001', ids.supA1);
    const r = await call<TerminalDto>('POST', `/terminals/${t.body.id}/assignments`, mgrA, { bankId: bank.body.id, routeGroupId: route.body.id });
    expect(r.body).toMatchObject({ bankId: bank.body.id, routeGroupId: route.body.id, supporterId: ids.supA1 });
    const hist = (await call<TerminalHistoryDto[]>('GET', `/terminals/${t.body.id}/history`, mgrA)).body;
    expect(hist.at(-1)).toMatchObject({ bankId: bank.body.id, routeGroupId: route.body.id });
    // حذف بانک مورد استفاده مجاز نیست
    expect((await call('DELETE', `/banks/${bank.body.id}`, mgrA)).status).toBe(422);
  });

  it('ویرایش مشخصات: audit قبل/بعد، search_norm به‌روز، outbox برای تاریخ نصب', async () => {
    const t = await newTerminal(mgrA, '43001', ids.supA1, { shopName: 'قدیمی' });
    const p = await call<TerminalDto>('PATCH', `/terminals/${t.body.id}`, mgrA, { shopName: 'جدیدِ ویژه', installedAt: '2024-05-10' });
    expect(p.body.shopName).toBe('جدیدِ ویژه');
    const found = await call<Page<TerminalDto>>('GET', `/terminals?q=${encodeURIComponent('ویژه')}`, mgrA);
    expect(found.body.items.map((x) => x.id)).toContain(t.body.id);
    const old = await call<Page<TerminalDto>>('GET', `/terminals?q=${encodeURIComponent('قدیمی')}`, mgrA);
    expect(old.body.items.map((x) => x.id)).not.toContain(t.body.id);
    const audit = await call<Page<AuditDto>>('GET', `/terminals/${t.body.id}/audit`, mgrA);
    const upd = audit.body.items.find((a) => a.action === 'update');
    expect(upd?.before).toMatchObject({ shopName: 'قدیمی' });
    expect(upd?.after).toMatchObject({ shopName: 'جدیدِ ویژه', installedAt: '2024-05-10' });
    const ob = await db.pool.query(`SELECT effective_date::text AS d FROM recompute_outbox WHERE terminal_id = $1 AND reason = 'installed_at'`, [t.body.id]);
    expect((ob.rows[0] as { d: string }).d).toBe('2024-05-10');
  });

  // ------------------------------------------------------------ DB
  it('EXCLUDE: هم‌پوشانی تاریخچه‌ی پشتیبان در سطح دیتابیس رد می‌شود', async () => {
    const t = await newTerminal(mgrA, '44001', ids.supA1);
    const r = db.pool.query(
      `INSERT INTO terminal_supporter_history (office_id, terminal_id, supporter_id, staff_unit_id, start_date, end_date)
       VALUES ($1, $2, $3, $4, '2010-01-01', '2020-01-01')`, [ids.officeA, t.body.id, ids.supA1, ids.unitA1]);
    await expect(r).rejects.toMatchObject({ code: '23P01' });
  });

  it('کاربران: ساخت، قواعد نقش، غیرفعال‌سازی نشست‌ها را باطل می‌کند', async () => {
    const created = await call<{ id: number }>('POST', '/users', mgrA, {
      username: 'NewSup', password: 'Another-Pass1', fullName: 'کاربر جدید', role: 'supporter', supporterId: ids.supA2,
    });
    expect(created.status).toBe(201);
    const l = await call<{ refreshToken: string }>('POST', '/auth/login', undefined, { officeCode: 'OA', username: 'newsup', password: 'Another-Pass1' });
    expect(l.status).toBe(200);
    await call('PATCH', `/users/${created.body.id}`, mgrA, { isActive: false });
    expect((await call('POST', '/auth/refresh', undefined, { refreshToken: l.body.refreshToken })).status).toBe(401);
    expect((await call('POST', '/auth/login', undefined, { officeCode: 'OA', username: 'newsup', password: 'Another-Pass1' })).status).toBe(401);
    const self = await call<ErrBody>('PATCH', `/users/1`, mgrA, { isActive: false });
    expect([404, 422]).toContain(self.status);
  });
});
