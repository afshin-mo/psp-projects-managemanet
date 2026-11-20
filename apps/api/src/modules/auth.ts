import type { FastifyInstance } from 'fastify';
import {
  changePasswordSchema, loginSchema, refreshSchema,
} from '@pos/shared';
import {
  HttpError, findAuthUsersForLogin, getPasswordHash, hashPassword, issueRefreshToken, loadAuthUser,
  revokeAllUserTokens, revokeRefreshToken, rotateRefreshToken, setPasswordHash, verifyPassword,
  type AuthUser,
} from '@pos/core';
import { effectivePermissions } from '@pos/shared';
import type { AuthClaims } from '../plugins/auth';
import type { RouteDeps } from './deps';

function claimsOf(u: AuthUser): AuthClaims {
  return { sub: String(u.id), role: u.role, oid: u.officeId, unit: u.unitId, sup: u.supporterId };
}

function publicUser(u: AuthUser) {
  return { id: u.id, username: u.username, fullName: u.fullName, role: u.role, officeId: u.officeId, unitId: u.unitId, supporterId: u.supporterId,
    permissions: effectivePermissions(u.role, u.permissions) };
}

export async function authRoutes(app: FastifyInstance, { env, pools }: RouteDeps): Promise<void> {
  const accessFor = (u: AuthUser): string => app.jwt.sign(claimsOf(u));

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: env.LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (req) => {
      const body = loginSchema.parse(req.body);
      // ورود فقط با نام کاربری و رمز؛ کد دفتر فقط وقتی لازم است که همان نام کاربری در چند دفتر باشد
      const candidates = await findAuthUsersForLogin(pools.write, body.officeCode ?? null, body.username);
      if (candidates.length === 0) await verifyPassword(null, body.password); // زمان پاسخ برای نام ناموجود هم یکسان بماند
      const matches: typeof candidates = [];
      for (const c of candidates) if (await verifyPassword(c.passwordHash, body.password)) matches.push(c);
      if (matches.length > 1) {
        throw new HttpError(409, 'OFFICE_REQUIRED', 'این نام کاربری در چند دفتر ثبت شده است؛ کد دفتر را هم وارد کنید');
      }
      const user = matches[0];
      if (!user || !user.isActive) {
        // پیام یکسان برای نام کاربری ناموجود، رمز غلط و حساب غیرفعال
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'نام کاربری یا رمز عبور نادرست است');
      }
      const refreshToken = await issueRefreshToken(pools.write, user.id, env.REFRESH_TOKEN_TTL_DAYS);
      return { accessToken: accessFor(user), refreshToken, expiresIn: env.ACCESS_TOKEN_TTL, user: publicUser(user) };
    },
  );

  app.post('/auth/refresh', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const rotated = await rotateRefreshToken(pools.write, refreshToken, env.REFRESH_TOKEN_TTL_DAYS);
    if (!rotated) throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'نشست منقضی یا نامعتبر است');
    const user = await loadAuthUser(pools.write, rotated.userId);
    if (!user || !user.isActive) {
      await revokeAllUserTokens(pools.write, rotated.userId);
      throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'نشست منقضی یا نامعتبر است');
    }
    return { accessToken: accessFor(user), refreshToken: rotated.token, expiresIn: env.ACCESS_TOKEN_TTL, user: publicUser(user) };
  });

  app.post('/auth/logout', async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    await revokeRefreshToken(pools.write, refreshToken);
    return { ok: true };
  });

  app.get('/auth/me', { onRequest: [app.authenticate] }, async (req) => {
    const user = await loadAuthUser(pools.read, Number(req.user.sub));
    if (!user || !user.isActive) throw new HttpError(401, 'UNAUTHORIZED', 'نیاز به ورود مجدد دارید');
    return publicUser(user);
  });

  app.post('/auth/change-password', { onRequest: [app.authenticate] }, async (req) => {
    const body = changePasswordSchema.parse(req.body);
    const userId = Number(req.user.sub);
    const ok = await verifyPassword((await getPasswordHash(pools.write, userId)) ?? null, body.currentPassword);
    if (!ok) throw new HttpError(401, 'INVALID_CREDENTIALS', 'رمز فعلی نادرست است');
    await setPasswordHash(pools.write, userId, await hashPassword(body.newPassword));
    await revokeAllUserTokens(pools.write, userId); // همه‌ی نشست‌ها باید دوباره وارد شوند
    return { ok: true };
  });
}
