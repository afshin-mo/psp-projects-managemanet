import type { FastifyInstance } from 'fastify';
import { assignPendingSchema, dismissPendingSchema, pendingListQuerySchema, scoreQuerySchema } from '@pos/shared';
import {
  assignPendingTerminals, dismissPendingTerminals, getPendingSummary, getSupporterScoreboard, listPendingTerminals,
} from '@pos/core';
import { requirePermission, tenantCtx } from '../plugins/auth';
import { kickAggregation, type RouteDeps } from './deps';

/** ترمینال‌های تعریف‌نشده‌ی فایل تراکنش + امتیاز پشتیبان */
export async function pendingRoutes(app: FastifyInstance, { pools, queue }: RouteDeps): Promise<void> {
  const admins = { preHandler: [requirePermission(pools.read, 'pending.manage')] };
  const scorers = { preHandler: [requirePermission(pools.read, 'scores.view')] };

  app.get('/pending-terminals', admins, async (req) =>
    listPendingTerminals(tenantCtx(req), pools.read, pendingListQuerySchema.parse(req.query)));

  app.get('/pending-terminals/summary', admins, async (req) => getPendingSummary(tenantCtx(req), pools.read));

  app.post('/pending-terminals/assign', admins, async (req) => {
    const ctx = tenantCtx(req);
    const r = await assignPendingTerminals(ctx, pools.write, assignPendingSchema.parse(req.body));
    if (r.created > 0) kickAggregation(queue, ctx.officeId);
    return r;
  });

  app.post('/pending-terminals/dismiss', admins, async (req) =>
    dismissPendingTerminals(tenantCtx(req), pools.write, dismissPendingSchema.parse(req.body)));

  // امتیاز پشتیبان‌ها (دامنه‌ی نقش در Repository اعمال می‌شود)
  app.get('/analytics/supporter-scores', scorers, async (req) =>
    getSupporterScoreboard(tenantCtx(req), pools.read, scoreQuerySchema.parse(req.query)));
}
