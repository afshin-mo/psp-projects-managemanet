import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage, createLogger, hashPassword, loadEnv, type JobQueue } from '@pos/core';
import { createTestDb, type TestDb } from '@pos/core/testing';
import type { ActivityRuleDto, OfficeSettingsDto } from '@pos/shared';
import { buildApp } from './app';

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = 'Passw0rd!x';

interface Res<T> { status: number; body: T }
interface ErrBody { error: { code: string } }
interface Sent { name: string; data: Record<string, unknown>; singletonKey?: string | undefined }

describe.skipIf(!url)('API تنظیمات و تجمیع', () => {
  let db: TestDb;
  let app: FastifyInstance;
  const sent: Sent[] = [];
  const queue: JobQueue = { enqueue: async (name, data, opts) => { sent.push({ name, data, singletonKey: opts?.singletonKey }); } };
  let mgr = '', da = '', head = '', sup = '';
  let officeId = 0, supporterId = 0, bankId = 0;

  async function call<T>(method: 'GET' | 'POST' | 'PUT', p: string, token?: string, body?: unknown): Promise<Res<T>> {
    const res = await app.inject({
      method, url: `/api/v1${p}`,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as T };
  }
  const login = async (u: string) =>
    (await call<{ accessToken: string }>('POST', '/auth/login', undefined, { officeCode: 'ST', username: u, password: PASSWORD })).body.accessToken;

  beforeAll(async () => {
    db = await createTestDb();
    const env = loadEnv({
      DATABASE_URL: url as string, JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test', LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '100000', LOGIN_RATE_LIMIT_MAX: '1000',
    });
    app = await buildApp({
      env, logger: createLogger(env, 'test'), pools: { write: db.pool, read: db.pool, hasReplica: false },
      storage: new LocalStorage(mkdtempSync(path.join(os.tmpdir(), 'pos-st-'))), queue, stagingSchema: db.schema,
    });
    const q = async (sql: string, v: unknown[] = []) => (await db.pool.query(sql, v)).rows[0] as { id: number };
    officeId = (await q(`INSERT INTO offices (name, code) VALUES ('دفتر','ST') RETURNING id`)).id;
    const unit = (await q(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد') RETURNING id`, [officeId])).id;
    supporterId = (await q(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,'پ') RETURNING id`, [officeId, unit])).id;
    bankId = (await q(`INSERT INTO banks (office_id, name) VALUES ($1,'ملی') RETURNING id`, [officeId])).id;
    const hash = await hashPassword(PASSWORD);
    const user = (n: string, role: string, u: number | null, s: number | null) =>
      db.pool.query(`INSERT INTO users (office_id, username, password_hash, full_name, role, staff_unit_id, supporter_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [officeId, n, hash, n, role, u, s]);
    await user('mgr', 'office_manager', null, null);
    await user('da', 'data_admin', null, null);
    await user('head', 'unit_head', unit, null);
    await user('sup', 'supporter', null, supporterId);
    mgr = await login('mgr'); da = await login('da'); head = await login('head'); sup = await login('sup');
  });
  afterAll(async () => { await app?.close(); await db?.cleanup(); });

  it('خواندن تنظیمات: پیش‌فرض‌ها؛ پشتیبان دسترسی ندارد', async () => {
    const r = await call<OfficeSettingsDto>('GET', '/settings/office', head);
    expect(r.body).toMatchObject({ newTerminalCutoffDay: 20, preliminaryAlertMinDay: 10, dropAlertThresholdPct: 30 });
    expect((await call('GET', '/settings/office', sup)).status).toBe(403);
  });

  it('تغییر روز نوپا: audit قبل/بعد و صف‌شدن بازطبقه‌بندی؛ بدون تغییر چیزی صف نمی‌شود', async () => {
    const r = await call<{ settings: OfficeSettingsDto; reclassifyQueued: boolean }>('PUT', '/settings/office', mgr, { newTerminalCutoffDay: 25 });
    expect(r.status).toBe(200);
    expect(r.body.settings.newTerminalCutoffDay).toBe(25);
    expect(r.body.reclassifyQueued).toBe(true);
    expect(sent.at(-1)).toMatchObject({ name: 'activity.reclassify', data: { officeId, fromPeriod: 0 } });

    const a = await db.pool.query(`SELECT action, before, after FROM audit_log WHERE entity_type = 'office_settings' ORDER BY id DESC LIMIT 1`);
    expect(a.rows[0]).toMatchObject({ action: 'setting', before: { newTerminalCutoffDay: 20 }, after: { newTerminalCutoffDay: 25 } });

    const n = sent.length;
    const same = await call<{ reclassifyQueued: boolean }>('PUT', '/settings/office', da, { newTerminalCutoffDay: 25 });
    expect(same.body.reclassifyQueued).toBe(false);
    const alertDay = await call<{ reclassifyQueued: boolean }>('PUT', '/settings/office', da, { preliminaryAlertMinDay: 12 });
    expect(alertDay.body.reclassifyQueued).toBe(false); // فقط زمان نمایش هشدار مقدماتی؛ داده‌ی ذخیره‌شده عوض نمی‌شود
    expect(sent.length).toBe(n);
  });

  it('اعتبارسنجی تنظیمات و نقش‌ها', async () => {
    expect((await call<ErrBody>('PUT', '/settings/office', mgr, { newTerminalCutoffDay: 0 })).status).toBe(400);
    expect((await call<ErrBody>('PUT', '/settings/office', mgr, {})).status).toBe(400);
    expect((await call<ErrBody>('PUT', '/settings/office', mgr, { dropAlertThresholdPct: 100 })).status).toBe(400);
    expect((await call('PUT', '/settings/office', head, { newTerminalCutoffDay: 21 })).status).toBe(403);
  });

  it('قانون آستانه: ثبت، به‌روزرسانی، بانک نامعتبر، دوره‌ی نامعتبر و صف بازطبقه‌بندی از دوره‌ی شروع', async () => {
    const r = await call<{ rule: ActivityRuleDto }>('PUT', '/settings/activity-rules', mgr, { validFromPeriod: 140401, minMonthlyAmount: 100_000 });
    expect(r.status).toBe(200);
    expect(r.body.rule).toMatchObject({ bankId: 0, validFromPeriod: 140401, minMonthlyAmount: 100_000 });
    expect(sent.at(-1)).toMatchObject({ name: 'activity.reclassify', data: { officeId, fromPeriod: 140401 } });

    await call('PUT', '/settings/activity-rules', da, { bankId, validFromPeriod: 140404, minMonthlyAmount: 500_000 });
    await call('PUT', '/settings/activity-rules', mgr, { validFromPeriod: 140401, minMonthlyAmount: 150_000 }); // به‌روزرسانی همان کلید
    const list = await call<ActivityRuleDto[]>('GET', '/settings/activity-rules', head);
    expect(list.body.map((x) => [x.bankId, x.validFromPeriod, x.minMonthlyAmount])).toEqual([[0, 140401, 150_000], [bankId, 140404, 500_000]]);

    expect((await call<ErrBody>('PUT', '/settings/activity-rules', mgr, { bankId: 99999, validFromPeriod: 140401, minMonthlyAmount: 1 })).status).toBe(422);
    expect((await call<ErrBody>('PUT', '/settings/activity-rules', mgr, { validFromPeriod: 140413, minMonthlyAmount: 1 })).status).toBe(400);
    expect((await call<ErrBody>('PUT', '/settings/activity-rules', mgr, { validFromPeriod: 140401, minMonthlyAmount: -1 })).status).toBe(400);
    expect((await call('PUT', '/settings/activity-rules', head, { validFromPeriod: 140401, minMonthlyAmount: 1 })).status).toBe(403);
  });

  it('ثبت ترمینال تجمیع دفتر را صف می‌کند و در وضعیت تجمیع معوق دیده می‌شود', async () => {
    const before = await call<{ pendingOutbox: number }>('GET', '/admin/aggregates/status', mgr);
    const r = await call('POST', '/terminals', mgr, { terminalNo: '777', supporterId });
    expect(r.status).toBe(201);
    expect(sent.at(-1)).toMatchObject({ name: 'aggregate.office', data: { officeId }, singletonKey: `agg:${officeId}` });
    const after = await call<{ pendingOutbox: number; aggregatingBatches: number; dataVersion: number }>('GET', '/admin/aggregates/status', mgr);
    expect(after.body.pendingOutbox).toBe(before.body.pendingOutbox + 1);
    expect((await call('GET', '/admin/aggregates/status', da)).status).toBe(403);
  });

  it('بازسازی کامل: فقط مدیر دفتر و با بازه‌ی اختیاری', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/v1/admin/aggregates/rebuild', headers: { authorization: `Bearer ${mgr}` },
      payload: { fromPeriod: 140401 },
    });
    expect(r.statusCode).toBe(202);
    expect(sent.at(-1)).toMatchObject({ name: 'aggregate.rebuild', data: { officeId, fromPeriod: 140401 } });
    expect((await call('POST', '/admin/aggregates/rebuild', da, {})).status).toBe(403);
  });
});
