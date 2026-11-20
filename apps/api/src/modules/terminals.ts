import type { FastifyInstance } from 'fastify';
import {
  assignmentSchema, bulkAssignSchema, createTerminalSchema, idParamsSchema, lookupTerminalsSchema, pageQuerySchema, patchTerminalSchema,
  reactivateTerminalSchema, returnTerminalSchema, terminalListQuerySchema, todayInTehran, transferSupporterUnitSchema,
  transferTerminalsSchema,
} from '@pos/shared';
import {
  assignTerminal, bulkAssignTerminals, createTerminal, getTerminal, getTerminalHistory, listTerminalAudit, listTerminals, lookupTerminals,
  patchTerminal, reactivateTerminal, returnTerminal, transferSupporterTerminals, transferSupporterUnit,
} from '@pos/core';
import { requirePermission, tenantCtx } from '../plugins/auth';
import { kickAggregation, type RouteDeps } from './deps';

export async function terminalRoutes(app: FastifyInstance, { pools, queue }: RouteDeps): Promise<void> {
  const managers = { preHandler: [requirePermission(pools.read, 'terminals.edit')] };
  const auditors = { preHandler: [requirePermission(pools.read, 'terminals.audit')] };

  app.get('/terminals', async (req) =>
    listTerminals(tenantCtx(req), pools.read, terminalListQuerySchema.parse(req.query)));

  // جستجوی هم‌زمان چند شماره ترمینال (فقط داخل دامنه‌ی دسترسی کاربر)
  app.post('/terminals/lookup', async (req) =>
    lookupTerminals(tenantCtx(req), pools.read, lookupTerminalsSchema.parse(req.body).terminalNos));

  app.get('/terminals/:id', async (req) =>
    getTerminal(tenantCtx(req), pools.read, idParamsSchema.parse(req.params).id));

  app.post('/terminals', managers, async (req, reply) => {
    const ctx = tenantCtx(req);
    const t = await createTerminal(ctx, pools.write, createTerminalSchema.parse(req.body));
    kickAggregation(queue, ctx.officeId);
    return reply.status(201).send(t);
  });

  app.patch('/terminals/:id', managers, async (req) => {
    const ctx = tenantCtx(req);
    const t = await patchTerminal(ctx, pools.write, idParamsSchema.parse(req.params).id, patchTerminalSchema.parse(req.body));
    kickAggregation(queue, ctx.officeId);
    return t;
  });

  app.post('/terminals/:id/assignments', managers, async (req) => {
    const ctx = tenantCtx(req);
    const t = await assignTerminal(
      ctx, pools.write, idParamsSchema.parse(req.params).id, assignmentSchema.parse(req.body), todayInTehran());
    kickAggregation(queue, ctx.officeId);
    return t;
  });

  app.get('/terminals/:id/history', async (req) =>
    getTerminalHistory(tenantCtx(req), pools.read, idParamsSchema.parse(req.params).id));

  app.get('/terminals/:id/audit', auditors, async (req) =>
    listTerminalAudit(tenantCtx(req), pools.read, idParamsSchema.parse(req.params).id, pageQuerySchema.parse(req.query)));

  // ---- فاز ۵: انصراف/برگشت ----
  app.post('/terminals/:id/return', managers, async (req) => {
    const ctx = tenantCtx(req);
    const t = await returnTerminal(ctx, pools.write, idParamsSchema.parse(req.params).id, returnTerminalSchema.parse(req.body ?? {}), todayInTehran());
    kickAggregation(queue, ctx.officeId);
    return t;
  });

  app.post('/terminals/:id/reactivate', managers, async (req) => {
    const ctx = tenantCtx(req);
    const t = await reactivateTerminal(ctx, pools.write, idParamsSchema.parse(req.params).id, reactivateTerminalSchema.parse(req.body ?? {}));
    kickAggregation(queue, ctx.officeId);
    return t;
  });

  // ---- ویرایش گروهی: تعویض پشتیبان/مسیر/بانک (همه یا هیچ) ----
  app.post('/terminals/bulk/assign', managers, async (req) => {
    const ctx = tenantCtx(req);
    const r = await bulkAssignTerminals(ctx, pools.write, bulkAssignSchema.parse(req.body), todayInTehran());
    kickAggregation(queue, ctx.officeId);
    return r;
  });

  // ---- انتقال بین ستادها ----
  const admins = { preHandler: [requirePermission(pools.read, 'masterdata.manage')] };

  app.post('/supporters/:id/transfer-unit', admins, async (req) => {
    const ctx = tenantCtx(req);
    const r = await transferSupporterUnit(ctx, pools.write, idParamsSchema.parse(req.params).id, transferSupporterUnitSchema.parse(req.body), todayInTehran());
    kickAggregation(queue, ctx.officeId);
    return r;
  });

  app.post('/supporters/:id/transfer-terminals', managers, async (req) => {
    const ctx = tenantCtx(req);
    const r = await transferSupporterTerminals(ctx, pools.write, idParamsSchema.parse(req.params).id, transferTerminalsSchema.parse(req.body), todayInTehran());
    kickAggregation(queue, ctx.officeId);
    return r;
  });
}
