import type { FastifyInstance } from 'fastify';
import {
  bulkCreateBanksSchema, bulkCreateRouteGroupsSchema, createBankSchema, createRouteGroupSchema, createStaffUnitSchema, createSupporterSchema, idParamsSchema,
  patchBankSchema, patchRouteGroupSchema, patchStaffUnitSchema, patchSupporterSchema, supporterListQuerySchema,
} from '@pos/shared';
import {
  bulkCreateBanks, bulkCreateRouteGroups, createBank, createRouteGroup, createStaffUnit, createSupporter, deleteBank, deleteRouteGroup, listBanks,
  listRouteGroups, listStaffUnits, listSupporters, patchBank, patchRouteGroup, patchStaffUnit, patchSupporter,
} from '@pos/core';
import { requirePermission, tenantCtx } from '../plugins/auth';
import type { RouteDeps } from './deps';

export async function masterDataRoutes(app: FastifyInstance, { pools }: RouteDeps): Promise<void> {
  const writers = { preHandler: [requirePermission(pools.read, 'masterdata.manage')] };

  // ستاد
  app.get('/staff-units', async (req) => listStaffUnits(tenantCtx(req), pools.read));
  app.post('/staff-units', writers, async (req, reply) =>
    reply.status(201).send(await createStaffUnit(tenantCtx(req), pools.write, createStaffUnitSchema.parse(req.body))));
  app.patch('/staff-units/:id', writers, async (req) =>
    patchStaffUnit(tenantCtx(req), pools.write, idParamsSchema.parse(req.params).id, patchStaffUnitSchema.parse(req.body)));

  // پشتیبان
  app.get('/supporters', async (req) =>
    listSupporters(tenantCtx(req), pools.read, supporterListQuerySchema.parse(req.query).unitId));
  app.post('/supporters', writers, async (req, reply) =>
    reply.status(201).send(await createSupporter(tenantCtx(req), pools.write, createSupporterSchema.parse(req.body))));
  app.patch('/supporters/:id', writers, async (req) =>
    patchSupporter(tenantCtx(req), pools.write, idParamsSchema.parse(req.params).id, patchSupporterSchema.parse(req.body)));

  // بانک
  app.get('/banks', async (req) => listBanks(tenantCtx(req), pools.read));
  // ثبت گروهی (چسباندن فهرست)؛ قبل از مسیرهای :id
  app.post('/banks/bulk', writers, async (req) => bulkCreateBanks(tenantCtx(req), pools.write, bulkCreateBanksSchema.parse(req.body)));
  app.post('/route-groups/bulk', writers, async (req) =>
    bulkCreateRouteGroups(tenantCtx(req), pools.write, bulkCreateRouteGroupsSchema.parse(req.body)));
  app.post('/banks', writers, async (req, reply) =>
    reply.status(201).send(await createBank(tenantCtx(req), pools.write, createBankSchema.parse(req.body))));
  app.patch('/banks/:id', writers, async (req) =>
    patchBank(tenantCtx(req), pools.write, idParamsSchema.parse(req.params).id, patchBankSchema.parse(req.body)));
  app.delete('/banks/:id', writers, async (req, reply) => {
    await deleteBank(tenantCtx(req), pools.write, idParamsSchema.parse(req.params).id);
    return reply.status(204).send();
  });

  // مسیر
  app.get('/route-groups', async (req) => listRouteGroups(tenantCtx(req), pools.read));
  app.post('/route-groups', writers, async (req, reply) =>
    reply.status(201).send(await createRouteGroup(tenantCtx(req), pools.write, createRouteGroupSchema.parse(req.body))));
  app.patch('/route-groups/:id', writers, async (req) =>
    patchRouteGroup(tenantCtx(req), pools.write, idParamsSchema.parse(req.params).id, patchRouteGroupSchema.parse(req.body)));
  app.delete('/route-groups/:id', writers, async (req, reply) => {
    await deleteRouteGroup(tenantCtx(req), pools.write, idParamsSchema.parse(req.params).id);
    return reply.status(204).send();
  });
}
