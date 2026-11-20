import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalStorage, createLogger, hashPassword, loadEnv, runCommit, runValidate, type ImportDeps, type JobQueue,
} from '@pos/core';
import { createTestDb, type TestDb } from '@pos/core/testing';
import type { ImportBatchDto, ImportErrorDto, MappingInfoDto, Page } from '@pos/shared';
import { buildApp } from './app';

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = 'Passw0rd!x';
const BOUNDARY = '----posTestBoundary';
const HEAD = 'شماره ترمینال,مبلغ,تعداد';

interface Res<T> { status: number; body: T }
interface ErrBody { error: { code: string } }
interface UploadRes { batch: ImportBatchDto; mapping: MappingInfoDto }

/** بدنه‌ی multipart: فیلدها به ترتیب، سپس فایل */
function multipart(fields: Record<string, string>, file: { name: string; data: Buffer }, fileFirst = false): { payload: Buffer; headers: Record<string, string> } {
  const parts: Buffer[] = [];
  const addFields = () => {
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
  };
  const addFile = () => {
    parts.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  };
  if (fileFirst) { addFile(); addFields(); } else { addFields(); addFile(); }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` } };
}

describe.skipIf(!url)('API ایمپورت: آپلود، نگاشت، قالب مرکزی، commit', () => {
  let db: TestDb;
  let app: FastifyInstance;
  let deps: ImportDeps;
  const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
  const queue: JobQueue = { enqueue: async (name, data) => { sent.push({ name, data }); } };
  let mgr = '', head = '', sup = '', central = '';
  let supporterId = 0;

  async function call<T>(method: 'GET' | 'POST' | 'PATCH', p: string, token?: string, body?: unknown): Promise<Res<T>> {
    const res = await app.inject({
      method, url: `/api/v1${p}`,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as T };
  }
  async function upload(token: string, type: string, name: string, data: string | Buffer, options: Record<string, unknown> = {}, fileFirst = false): Promise<Res<UploadRes & ErrBody>> {
    const m = multipart({ type, options: JSON.stringify(options) }, { name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') }, fileFirst);
    const res = await app.inject({ method: 'POST', url: '/api/v1/imports', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: res.json() as UploadRes & ErrBody };
  }
  async function login(office: string | undefined, username: string): Promise<string> {
    const r = await call<{ accessToken: string }>('POST', '/auth/login', undefined, { officeCode: office, username, password: PASSWORD });
    return r.body.accessToken;
  }

  beforeAll(async () => {
    db = await createTestDb();
    const env = loadEnv({
      DATABASE_URL: url as string, JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test', LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '100000', LOGIN_RATE_LIMIT_MAX: '1000',
    });
    const logger = createLogger(env, 'test');
    const storage = new LocalStorage(mkdtempSync(path.join(os.tmpdir(), 'pos-api-imp-')));
    app = await buildApp({ env, logger, pools: { write: db.pool, read: db.pool, hasReplica: false }, storage, queue, stagingSchema: db.schema });
    deps = { pool: db.pool, storage, logger, stagingSchema: db.schema, maxRows: 1000, vacuumThreshold: 1e9 };

    const q = async (sql: string, v: unknown[] = []) => (await db.pool.query(sql, v)).rows[0] as { id: number };
    const office = (await q(`INSERT INTO offices (name, code) VALUES ('دفتر','OI') RETURNING id`)).id;
    const unit = (await q(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد') RETURNING id`, [office])).id;
    supporterId = (await q(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,'پشتیبان') RETURNING id`, [office, unit])).id;
    const hash = await hashPassword(PASSWORD);
    const user = (o: number | null, n: string, role: string, u: number | null, s: number | null) =>
      db.pool.query(`INSERT INTO users (office_id, username, password_hash, full_name, role, staff_unit_id, supporter_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [o, n, hash, n, role, u, s]);
    await user(office, 'mgr', 'office_manager', null, null);
    await user(office, 'head', 'unit_head', unit, null);
    await user(office, 'sup', 'supporter', null, supporterId);
    await user(null, 'central', 'system_admin', null, null);
    mgr = await login('OI', 'mgr'); head = await login('OI', 'head'); sup = await login('OI', 'sup'); central = await login(undefined, 'central');
    await call('POST', '/terminals', mgr, { terminalNo: '001', supporterId });
    await call('POST', '/terminals', mgr, { terminalNo: '002', supporterId });
    sent.length = 0; // ثبت ترمینال‌ها تجمیع را صف کرده؛ سناریوهای ایمپورت از صفر شروع می‌کنند
  });
  afterAll(async () => { await app?.close(); await db?.cleanup(); });

  it('جریان کامل: آپلود ← نگاشت (ذخیره پروفایل) ← validate ← commit', async () => {
    const opts = { asOfDate: '2025-06-25' };
    const up = await upload(mgr, 'transactions_cumulative', 'a.csv', `${HEAD}\n001,1000,3\n`, opts);
    expect(up.status).toBe(201);
    expect(up.body.batch.status).toBe('needs_mapping');
    expect(up.body.mapping.source).toBe('suggested');
    expect(up.body.mapping.missingRequired).toEqual([]);
    expect(sent).toHaveLength(0);

    const id = up.body.batch.id;
    const mapped = await call<ImportBatchDto>('POST', `/imports/${id}/mapping`, mgr, { columnMap: up.body.mapping.columnMap, saveProfileName: 'فایل ستاد' });
    expect(mapped.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ name: 'import.validate', data: { batchId: id } });

    await runValidate(deps, id);
    const v = await call<ImportBatchDto>('GET', `/imports/${id}`, mgr);
    expect(v.body).toMatchObject({ status: 'validated', validRows: 1, errorRows: 0 });

    const c = await call<ImportBatchDto>('POST', `/imports/${id}/commit`, mgr, { mode: 'strict' });
    expect(c.body.status).toBe('committing');
    expect(sent.at(-1)).toMatchObject({ name: 'import.commit' });
    await runCommit(deps, id);
    const done = await call<ImportBatchDto>('GET', `/imports/${id}`, mgr);
    expect(done.body).toMatchObject({ status: 'completed', insertedRows: 1 });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM transactions_snapshot')).rows[0]).toEqual({ n: 1 });
  });

  it('فایل تکراری رد می‌شود (hash)', async () => {
    const r = await upload(mgr, 'transactions_cumulative', 'again.csv', `${HEAD}\n001,1000,3\n`, { asOfDate: '2025-06-25' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE_FILE');
  });

  it('پروفایل ذخیره‌شده، آپلود بعدی را خودکار منطبق و اعتبارسنجی را صف می‌کند', async () => {
    const before = sent.length;
    const up = await upload(mgr, 'transactions_cumulative', 'b.csv', `${HEAD}\n001,2000,4\n002,abc,1\n`, { asOfDate: '2025-06-26' });
    expect(up.status).toBe(201);
    expect(up.body.mapping.source).toBe('profile');
    expect(up.body.batch.status).toBe('uploaded');
    expect(sent.length).toBe(before + 1);

    const id = up.body.batch.id;
    await runValidate(deps, id);
    const errs = await call<Page<ImportErrorDto>>('GET', `/imports/${id}/errors`, mgr);
    expect(errs.body.items).toMatchObject([{ rowNo: 3, code: 'BAD_AMOUNT' }]);
    expect((await call<ErrBody>('POST', `/imports/${id}/commit`, mgr, { mode: 'strict' })).body.error.code).toBe('HAS_ERRORS');

    const x = await app.inject({ method: 'GET', url: `/api/v1/imports/${id}/errors.xlsx`, headers: { authorization: `Bearer ${mgr}` } });
    expect(x.statusCode).toBe(200);
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('کنترل فایل: نوع، محتوا، ترتیب فیلدها', async () => {
    expect((await upload(mgr, 'terminals', 'x.txt', 'abc')).body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await upload(mgr, 'terminals', 'x.xlsx', 'this is not a zip')).body.error.code).toBe('INVALID_FILE_CONTENT');
    expect((await upload(mgr, 'terminals', 'x.csv', 'a,b\n1,2\n', {}, true)).body.error.code).toBe('FIELDS_FIRST');
    expect((await upload(mgr, 'nope', 'x.csv', 'a,b\n')).status).toBe(400);
  });

  it('نقش‌ها: مسئول ستاد و پشتیبان به ایمپورت دسترسی ندارند', async () => {
    expect((await upload(head, 'terminals', 'h.csv', 'a\n1\n')).status).toBe(403);
    expect((await call('GET', '/imports', sup)).status).toBe(403);
    expect((await call('GET', '/imports', central)).status).toBe(403);
  });

  it('قالب مرکزی: پیش‌نویس، فعال‌سازی، تطبیق خودکار و دانلود', async () => {
    const sample = 'شماره پایانه,جمع خرید,تعداد خرید\n1,1,1\n';
    const m = multipart({ type: 'transactions_cumulative' }, { name: 'central.csv', data: Buffer.from(sample) });
    const created = await app.inject({ method: 'POST', url: '/api/v1/system/templates', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${central}` } });
    expect(created.statusCode).toBe(201);
    const draft = created.json() as { id: number; isActive: boolean; columnMap: Record<string, string>; missingRequired: string[] };
    expect(draft.isActive).toBe(false);
    expect(draft.missingRequired).toEqual([]);

    // مدیر دفتر نمی‌تواند قالب مرکزی بسازد
    const forbidden = await app.inject({ method: 'POST', url: '/api/v1/system/templates', payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${mgr}` } });
    expect(forbidden.statusCode).toBe(403);

    // پیش از فعال‌سازی، تطبیق خودکار نیست
    const pre = await upload(mgr, 'transactions_cumulative', 'c1.csv', 'شماره پایانه,جمع خرید,تعداد خرید\n001,5,1\n', { asOfDate: '2025-06-27' });
    expect(pre.body.mapping.source).toBe('suggested');

    const act = await call<{ isActive: boolean }>('PATCH', `/system/templates/${draft.id}`, central, { isActive: true, effectiveFrom: '2020-01-01' });
    expect(act.body.isActive).toBe(true);

    const auto = await upload(mgr, 'transactions_cumulative', 'c2.csv', 'شماره پایانه,جمع خرید,تعداد خرید\n001,6,1\n', { asOfDate: '2025-06-28' });
    expect(auto.body.mapping.source).toBe('official');
    expect(auto.body.batch.status).toBe('uploaded');

    const dl = await app.inject({ method: 'GET', url: '/api/v1/imports/templates/transactions_cumulative', headers: { authorization: `Bearer ${mgr}` } });
    expect(dl.statusCode).toBe(200);
    expect(String(dl.headers['content-disposition'])).toContain('central.csv');

    const def = await app.inject({ method: 'GET', url: '/api/v1/imports/templates/terminals', headers: { authorization: `Bearer ${mgr}` } });
    expect(def.statusCode).toBe(200);
    expect(def.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('لغو و تلاش دوباره: وضعیت‌های نامعتبر ۴۰۹ می‌دهند', async () => {
    const up = await upload(mgr, 'transactions_cumulative', 'd.csv', 'x,y\n1,2\n', { asOfDate: '2025-06-25' });
    const id = up.body.batch.id;
    expect(up.body.batch.status).toBe('needs_mapping');
    expect((await call<ErrBody>('POST', `/imports/${id}/commit`, mgr, {})).status).toBe(409);
    expect((await call<ErrBody>('POST', `/imports/${id}/mapping`, mgr, { columnMap: { amount: 'y' } })).status).toBe(422);
    expect((await call<ImportBatchDto>('POST', `/imports/${id}/cancel`, mgr)).body.status).toBe('cancelled');
    expect((await call<ErrBody>('POST', `/imports/${id}/retry`, mgr)).status).toBe(409);
  });
});
