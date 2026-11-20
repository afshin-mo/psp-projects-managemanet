import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createLogger, loadEnv, type JobQueue, type StorageProvider } from '@pos/core';
import { buildApp } from './app';

// فقط /health به pool نیاز دارد؛ fake سبک به نوع Pool cast می‌شود
const okPool = { query: async () => ({}) } as unknown as pg.Pool;
const badPool = { query: async () => { throw new Error('connection refused'); } } as unknown as pg.Pool;

function make(over: Record<string, string> = {}, read: pg.Pool = okPool) {
  const env = loadEnv({
    DATABASE_URL: 'postgres://u:p@localhost/db',
    JWT_SECRET: 'x'.repeat(40),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...over,
  });
  const logger = createLogger(env, 'test');
  const storage = {} as unknown as StorageProvider;
  const queue: JobQueue = { enqueue: async () => undefined };
  return buildApp({ env, logger, pools: { write: okPool, read, hasReplica: false }, storage, queue });
}

describe('API: health و خطاها', () => {
  it('GET /health بدون دیتابیس پاسخ می‌دهد', async () => {
    const app = await make();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('GET /health/ready با دیتابیس سالم 200 است', async () => {
    const app = await make();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.dbWrite.ok).toBe(true);
    await app.close();
  });

  it('GET /health/ready با خرابی pool خواندن 503 است', async () => {
    const app = await make({}, badPool);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.dbRead.ok).toBe(false);
    expect(body.checks.dbWrite.ok).toBe(true);
    await app.close();
  });

  it('مسیر ناموجود، خطای JSON استاندارد می‌دهد', async () => {
    const app = await make();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });

  it('x-request-id پاسخ داده و از ورودی پذیرفته می‌شود', async () => {
    const app = await make();
    const res = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'abc-123' } });
    expect(res.headers['x-request-id']).toBe('abc-123');
    await app.close();
  });

  it('rate limit روی مسیرهای عادی اعمال می‌شود ولی /health را محدود نمی‌کند', async () => {
    const app = await make({ RATE_LIMIT_MAX: '2' });
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push((await app.inject({ method: 'GET', url: '/api/v1/ping' })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
    await app.close();
  });
});
