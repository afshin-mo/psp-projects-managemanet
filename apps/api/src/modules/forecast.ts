import type { FastifyInstance } from 'fastify';
import { forecastQuerySchema, forecastSummaryQuerySchema, runForecastSchema } from '@pos/shared';
import { QUEUES, createForecastRun, getForecast, getLatestForecastRun, listForecastSummary } from '@pos/core';
import { requirePermission, tenantCtx } from '../plugins/auth';
import type { RouteDeps } from './deps';

/**
 * پیش‌بینی ماهانه (Holt / Holt-Winters). محاسبه در Worker است؛ API فقط نتیجه‌ی ذخیره‌شده را می‌خواند.
 * دامنه: مدیر دفتر و ادمین داده همه‌ی سطح‌ها؛ مسئول ستاد ستاد و پشتیبان‌های خودش؛ پشتیبان فقط خودش.
 */
export async function forecastRoutes(app: FastifyInstance, { pools, queue }: RouteDeps): Promise<void> {
  const managers = { preHandler: [requirePermission(pools.read, 'forecast.manage')] };
  const viewers = { preHandler: [requirePermission(pools.read, 'forecast.view')] };

  app.get('/forecast', viewers, async (req) => getForecast(tenantCtx(req), pools.read, forecastQuerySchema.parse(req.query)));

  app.get('/forecast/summary', viewers, async (req) =>
    listForecastSummary(tenantCtx(req), pools.read, forecastSummaryQuerySchema.parse(req.query).scope));

  app.get('/forecast/status', managers, async (req) => ({ run: await getLatestForecastRun(tenantCtx(req), pools.read) }));

  app.post('/forecast/run', managers, async (req, reply) => {
    const ctx = tenantCtx(req);
    const body = runForecastSchema.parse(req.body ?? {});
    const run = await createForecastRun(ctx, pools.write, body.horizon);
    await queue.enqueue(QUEUES.forecastRun, { runId: run.id }, { singletonKey: `forecast:${ctx.officeId}` });
    return reply.status(202).send(run);
  });
}
