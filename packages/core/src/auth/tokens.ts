import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { queryOne, withTx, type Queryable } from '../db/types';

export const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

export async function issueRefreshToken(db: Queryable, userId: number, ttlDays: number): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3::int))`,
    [userId, hashToken(raw), ttlDays],
  );
  return raw;
}

export async function revokeAllUserTokens(db: Queryable, userId: number): Promise<void> {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

export async function revokeRefreshToken(db: Queryable, raw: string): Promise<void> {
  await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(raw)]);
}

export interface RotateResult { userId: number; token: string }

/**
 * چرخش refresh token: توکن قدیمی باطل و توکن جدید صادر می‌شود.
 * اگر توکن باطل‌شده دوباره ارائه شود (احتمال سرقت)، همه‌ی توکن‌های آن کاربر باطل می‌شود.
 */
export async function rotateRefreshToken(pool: pg.Pool, raw: string, ttlDays: number): Promise<RotateResult | null> {
  return withTx(pool, async (c) => {
    const row = await queryOne<{ id: number; userId: number; revoked: boolean; expired: boolean }>(
      c,
      `SELECT id, user_id AS "userId", (revoked_at IS NOT NULL) AS revoked, (expires_at <= now()) AS expired
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(raw)],
    );
    if (!row) return null;
    if (row.revoked) {
      await revokeAllUserTokens(c, row.userId);
      return null;
    }
    if (row.expired) return null;
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    return { userId: row.userId, token: await issueRefreshToken(c, row.userId, ttlDays) };
  });
}
