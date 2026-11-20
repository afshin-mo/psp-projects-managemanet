import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { effectivePermissions, type Permission } from '@pos/shared';
import { HttpError, type Env, type Queryable, type TenantContext, type UserRole } from '@pos/core';

/** محتوای JWT (کوتاه‌مدت). تغییر نقش/ستاد حداکثر تا انقضای توکن (یا refresh بعدی) اعمال می‌شود. */
export interface AuthClaims {
  sub: string; // userId
  role: UserRole;
  oid: number | null; // officeId (null فقط برای system_admin)
  unit: number | null;
  sup: number | null;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthClaims;
    user: AuthClaims;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest) => Promise<void>;
  }
}

export async function registerAuth(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(fastifyJwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.ACCESS_TOKEN_TTL },
  });
  app.decorate('authenticate', async (req: FastifyRequest): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      throw new HttpError(401, 'UNAUTHORIZED', 'نیاز به ورود مجدد دارید');
    }
  });
}

/** TenantContext درخواست. کاربر ستاد مرکزی (بدون دفتر) به داده‌ی دفترها دسترسی ندارد. */
export function tenantCtx(req: FastifyRequest): TenantContext {
  const u = req.user;
  if (u.role === 'system_admin' || u.oid === null) {
    throw new HttpError(403, 'FORBIDDEN', 'این حساب به داده‌ی دفترها دسترسی ندارد');
  }
  return { userId: Number(u.sub), officeId: u.oid, role: u.role, unitId: u.unit, supporterId: u.sup };
}

export function requireRoles(...roles: UserRole[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!roles.includes(req.user.role)) throw new HttpError(403, 'FORBIDDEN', 'دسترسی مجاز نیست');
  };
}

// ---------------------------------------------------------------- سطح دسترسی (مجوزها)
interface PermEntry { at: number; role: string; stored: string[] | null; active: boolean }
const permCache = new Map<number, PermEntry>();
const PERM_TTL_MS = 15_000;

/** بعد از تغییر دسترسی یک کاربر فراخوانی شود تا در همین پروسه بلافاصله اعمال شود (سایر پروسه‌ها حداکثر ~۱۵ ثانیه). */
export function invalidatePermissions(userId?: number): void {
  if (userId === undefined) permCache.clear(); else permCache.delete(userId);
}

async function loadPerms(db: Queryable, userId: number): Promise<PermEntry | undefined> {
  const hit = permCache.get(userId);
  if (hit && Date.now() - hit.at < PERM_TTL_MS) return hit;
  const r = await db.query(
    'SELECT role, permissions, is_active FROM users WHERE id = $1', [userId]);
  const row = r.rows[0] as { role: string; permissions: string[] | null; is_active: boolean } | undefined;
  if (!row) return undefined;
  const e: PermEntry = { at: Date.now(), role: row.role, stored: row.permissions, active: row.is_active };
  permCache.set(userId, e);
  return e;
}

/**
 * مجوز لازم برای یک مسیر (هرکدام از کلیدها کافی است). مجوز از دیتابیس خوانده می‌شود (نه JWT) تا تغییر دسترسی
 * بدون ورود مجدد اعمال شود. سقف هر نقش همان رفتار قبلی requireRoles است.
 */
export function requirePermission(db: Queryable, ...keys: Permission[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const e = await loadPerms(db, Number(req.user.sub));
    if (!e || !e.active) throw new HttpError(403, 'FORBIDDEN', 'دسترسی مجاز نیست');
    const eff = effectivePermissions(e.role, e.stored);
    if (!keys.some((k) => eff.includes(k))) throw new HttpError(403, 'FORBIDDEN', 'برای این بخش مجوز دسترسی ندارید');
  };
}
