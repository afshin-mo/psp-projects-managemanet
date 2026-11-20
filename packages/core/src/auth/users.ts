import { queryOne, queryRows, type Queryable } from '../db/types';
import type { UserRole } from '../db/schema';

export interface AuthUser {
  id: number;
  officeId: number | null;
  fullName: string;
  username: string;
  role: UserRole;
  unitId: number | null;
  supporterId: number | null;
  /** کاربر، دفتر و (برای پشتیبان) خود پشتیبان همگی فعال باشند */
  isActive: boolean;
  /** مجوزهای ذخیره‌شده؛ null = پیش‌فرض نقش */
  permissions: string[] | null;
}

const SELECT = `
  SELECT u.id, u.office_id AS "officeId", u.full_name AS "fullName", u.username, u.role,
         COALESCE(u.staff_unit_id, s.staff_unit_id) AS "unitId", u.supporter_id AS "supporterId", u.permissions,
         (u.is_active AND COALESCE(o.is_active, true) AND COALESCE(s.is_active, true)) AS "isActive"`;
const FROM = `
  FROM users u
  LEFT JOIN offices o ON o.id = u.office_id
  LEFT JOIN supporters s ON s.office_id = u.office_id AND s.id = u.supporter_id`;

/**
 * کاندیداهای ورود. بدون officeCode: همه‌ی کاربران با این نام کاربری (معمولاً یکی)؛
 * با officeCode: فقط همان دفتر. حداکثر ۵ ردیف (برای تشخیص نام کاربری تکراری بین دفترها).
 */
export async function findAuthUsersForLogin(
  db: Queryable, officeCode: string | null, username: string,
): Promise<Array<AuthUser & { passwordHash: string }>> {
  return queryRows<AuthUser & { passwordHash: string }>(
    db,
    `${SELECT}, u.password_hash AS "passwordHash" ${FROM}
      WHERE u.username = $1 AND ($2::text IS NULL OR o.code = $2::text)
      ORDER BY u.id LIMIT 5`,
    [username, officeCode],
  );
}

export function loadAuthUser(db: Queryable, userId: number): Promise<AuthUser | undefined> {
  return queryOne<AuthUser>(db, `${SELECT} ${FROM} WHERE u.id = $1`, [userId]);
}

export async function getPasswordHash(db: Queryable, userId: number): Promise<string | undefined> {
  return (await queryOne<{ h: string }>(db, 'SELECT password_hash AS h FROM users WHERE id = $1', [userId]))?.h;
}

export async function setPasswordHash(db: Queryable, userId: number, hash: string): Promise<void> {
  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
}
