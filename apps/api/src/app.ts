import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ZodError } from 'zod';
import { PgCache, mapPgError, pingPool, type CacheProvider, type Env, type JobQueue, type Logger, type StorageProvider } from '@pos/core';
import { analyticsRoutes } from './modules/analytics';
import { authRoutes } from './modules/auth';
import { exportRoutes } from './modules/exports';
import { forecastRoutes } from './modules/forecast';
import { importRoutes } from './modules/imports';
import { masterDataRoutes } from './modules/masterdata';
import { pendingRoutes } from './modules/pending';
import { projectRoutes } from './modules/projects';
import { settingsRoutes } from './modules/settings';
import { systemRoutes } from './modules/system';
import { terminalRoutes } from './modules/terminals';
import { userRoutes } from './modules/users';
import { registerAuth } from './plugins/auth';

export interface AppDeps {
  env: Env;
  logger: Logger;
  pools: { write: pg.Pool; read: pg.Pool; hasReplica: boolean };
  storage: StorageProvider;
  queue: JobQueue;
  /** پیش‌فرض: PgCache روی جدول stats_cache */
  cache?: CacheProvider;
  /** schema جدول‌های staging ایمپورت */
  stagingSchema?: string;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

function describeError(raw: unknown): { status: number; code: string | undefined; message: string; details?: unknown } {
  const err = mapPgError(raw) ?? raw;
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    statusCode?: unknown; code?: unknown; message?: unknown; details?: unknown;
  };
  const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
  return {
    status,
    code: typeof e.code === 'string' ? e.code : undefined,
    message: typeof e.message === 'string' ? e.message : 'Bad request',
    details: e.details,
  };
}

/** سازنده‌ی برنامه؛ بدون حالت (stateless) و بدون شنیدن روی پورت، تا در تست با inject استفاده شود. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env, logger, pools } = deps;

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: true, // پشت Nginx
    bodyLimit: 1_048_576, // آپلود فایل با multipart (فاز ۲) سقف جدا دارد
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
  });

  app.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = String(req.id);
    if (err instanceof ZodError) {
      const body: ErrorBody = {
        error: { code: 'VALIDATION_ERROR', message: 'ورودی نامعتبر است', details: err.flatten(), requestId },
      };
      return reply.status(400).send(body);
    }
    const { status, code, message, details } = describeError(err);
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    const body: ErrorBody = {
      error: {
        code: status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'INTERNAL_ERROR' : (code ?? 'BAD_REQUEST'),
        message: status >= 500 ? 'خطای داخلی سرور' : message,
        ...(details !== undefined && status < 500 ? { details } : {}),
        requestId,
      },
    };
    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    const body: ErrorBody = {
      error: { code: 'NOT_FOUND', message: 'مسیر یافت نشد', requestId: String(req.id) },
    };
    return reply.status(404).send(body);
  });

  // Liveness: بدون وابستگی به دیتابیس (برای PM2/Nginx/لود بالانسر)
  app.get('/health', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
  }));

  // Readiness: دسترسی به هر دو pool
  app.get('/health/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    const [write, read] = await Promise.all([pingPool(pools.write), pingPool(pools.read)]);
    const ok = write.ok && read.ok;
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ready' : 'degraded',
      checks: { dbWrite: write, dbRead: { ...read, replica: pools.hasReplica } },
    });
  });

  await registerAuth(app, env);
  await app.register(multipart, {
    limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1, fields: 10, fieldSize: 10_000, parts: 12 },
  });
  const routeDeps = { env, logger, pools, storage: deps.storage, queue: deps.queue, cache: deps.cache ?? new PgCache(pools.read, pools.write), stagingSchema: deps.stagingSchema ?? 'staging' };

  await app.register(
    async (api) => {
      api.get('/ping', async () => ({ pong: true }));
      await authRoutes(api, routeDeps);
      // همه‌ی مسیرهای زیر نیازمند ورود هستند
      await api.register(async (priv) => {
        priv.addHook('onRequest', app.authenticate);
        await userRoutes(priv, routeDeps);
        await masterDataRoutes(priv, routeDeps);
        await terminalRoutes(priv, routeDeps);
        await importRoutes(priv, routeDeps);
        await settingsRoutes(priv, routeDeps);
        await analyticsRoutes(priv, routeDeps);
        await exportRoutes(priv, routeDeps);
        await projectRoutes(priv, routeDeps);
        await forecastRoutes(priv, routeDeps);
        await pendingRoutes(priv, routeDeps);
        await systemRoutes(priv, routeDeps);
      });
    },
    { prefix: '/api/v1' },
  );

  return app;
}
