import type { FastifyInstance } from 'fastify';
import { createUserSchema, idParamsSchema, patchUserSchema } from '@pos/shared';
import { createUser, hashPassword, listUsers, patchUser, revokeAllUserTokens } from '@pos/core';
import { invalidatePermissions, requirePermission, tenantCtx } from '../plugins/auth';
import type { RouteDeps } from './deps';

export async function userRoutes(app: FastifyInstance, { pools }: RouteDeps): Promise<void> {
  const managerOnly = { preHandler: [requirePermission(pools.read, 'users.manage')] };

  app.get('/users', managerOnly, async (req) => listUsers(tenantCtx(req), pools.read));

  app.post('/users', managerOnly, async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    const user = await createUser(tenantCtx(req), pools.write, body, await hashPassword(body.password));
    return reply.status(201).send(user);
  });

  app.patch('/users/:id', managerOnly, async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = patchUserSchema.parse(req.body);
    const hash = body.password === undefined ? undefined : await hashPassword(body.password);
    const user = await patchUser(tenantCtx(req), pools.write, id, body, hash);
    // غیرفعال‌سازی یا تغییر رمز: نشست‌های فعال باید باطل شوند
    if (hash !== undefined || body.isActive === false) await revokeAllUserTokens(pools.write, id);
    invalidatePermissions(id); // سطح دسترسی/فعال‌بودن جدید فوراً اعمال شود
    return user;
  });
}
