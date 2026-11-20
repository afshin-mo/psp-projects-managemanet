import type { FastifyInstance } from 'fastify';
import { activityRuleSchema, patchOfficeSettingsSchema, rebuildSchema, runAutoProjectsSchema } from '@pos/shared';
import {
  QUEUES, getAggregationStatus, getAutoProjectsStatus, getOfficeSettings, runAutoProjectsManual, listActivityRules, updateOfficeSettings, upsertActivityRule,
} from '@pos/core';
import { requirePermission, tenantCtx } from '../plugins/auth';
import type { RouteDeps } from './deps';

export async function settingsRoutes(app: FastifyInstance, { pools, queue, logger }: RouteDeps): Promise<void> {
  const readers = { preHandler: [requirePermission(pools.read, 'settings.view')] };
  const writers = { preHandler: [requirePermission(pools.read, 'settings.manage')] };
  const manager = { preHandler: [requirePermission(pools.read, 'settings.maintenance')] };

  app.get('/settings/office', readers, async (req) => getOfficeSettings(tenantCtx(req), pools.read));

  // تغییر روز نوپا یا درصد افت، طبقه‌بندی و هشدارهای موجود را عوض می‌کند → job بازطبقه‌بندی
  app.put('/settings/office', writers, async (req) => {
    const ctx = tenantCtx(req);
    const { settings, reclassify } = await updateOfficeSettings(ctx, pools.write, patchOfficeSettingsSchema.parse(req.body));
    if (reclassify) await queue.enqueue(QUEUES.activityReclassify, { officeId: ctx.officeId, fromPeriod: 0 });
    return { settings, reclassifyQueued: reclassify };
  });

  // ---- پروژه‌های خودکار «فاقد درآمد»: وضعیت و اجرای دستی (ایجاد هم‌اکنون)
  app.get('/settings/auto-projects', writers, async (req) => getAutoProjectsStatus(tenantCtx(req), pools.read));
  app.post('/settings/auto-projects/run', writers, async (req) => {
    const ctx = tenantCtx(req);
    const body = runAutoProjectsSchema.parse(req.body ?? {});
    const results = await runAutoProjectsManual(ctx, { pool: pools.write, logger }, body.kind, body.force);
    return { results };
  });

  app.get('/settings/activity-rules', readers, async (req) => listActivityRules(tenantCtx(req), pools.read));

  app.put('/settings/activity-rules', writers, async (req) => {
    const ctx = tenantCtx(req);
    const rule = await upsertActivityRule(ctx, pools.write, activityRuleSchema.parse(req.body));
    await queue.enqueue(QUEUES.activityReclassify, { officeId: ctx.officeId, fromPeriod: rule.validFromPeriod });
    return { rule, reclassifyQueued: true };
  });

  // بازسازی کامل fact/agg از snapshotها (بعد از ایمپورت اولیه‌ی تاریخچه یا برای ترمیم)
  app.post('/admin/aggregates/rebuild', manager, async (req, reply) => {
    const ctx = tenantCtx(req);
    const body = rebuildSchema.parse(req.body ?? {});
    await queue.enqueue(QUEUES.aggregateRebuild, { officeId: ctx.officeId, ...body });
    return reply.status(202).send({ queued: true });
  });

  app.get('/admin/aggregates/status', manager, async (req) => getAggregationStatus(tenantCtx(req), pools.read));
}
