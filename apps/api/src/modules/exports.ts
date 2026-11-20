import type { FastifyInstance } from 'fastify';
import { createExportSchema, exportIdSchema } from '@pos/shared';
import { HttpError, QUEUES, createExportJob, getExportJob, resolveFilter } from '@pos/core';
import { requirePermission, tenantCtx } from '../plugins/auth';
import type { RouteDeps } from './deps';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** خروجی بزرگ (ترمینال‌های یک ماه) به‌صورت job: ساخت در Worker، دانلود فقط توسط سازنده، انقضا بعد از ۲ روز */
export async function exportRoutes(app: FastifyInstance, { pools, storage, queue }: RouteDeps): Promise<void> {
  const exporter = { preHandler: [requirePermission(pools.read, 'export.run')] };
  app.post('/exports', exporter, async (req, reply) => {
    const ctx = tenantCtx(req);
    const body = createExportSchema.parse(req.body);
    const f = await resolveFilter(ctx, pools.read, { period: body.period });
    const job = await createExportJob(ctx, pools.write, body, f.period);
    await queue.enqueue(QUEUES.exportBuild, { jobId: job.id });
    return reply.status(202).send(job);
  });

  app.get('/exports/:id', exporter, async (req) => {
    const { storageKey: _k, ...job } = await getExportJob(tenantCtx(req), pools.read, exportIdSchema.parse(req.params).id);
    return job;
  });

  app.get('/exports/:id/download', exporter, async (req, reply) => {
    const job = await getExportJob(tenantCtx(req), pools.read, exportIdSchema.parse(req.params).id);
    if (job.status !== 'done' || !job.storageKey) throw new HttpError(409, 'NOT_READY', 'خروجی هنوز آماده نیست یا منقضی شده است');
    return reply
      .header('content-type', XLSX_MIME)
      .header('content-disposition', `attachment; filename="export-${job.id}.xlsx"`)
      .send(await storage.get(job.storageKey));
  });
}
