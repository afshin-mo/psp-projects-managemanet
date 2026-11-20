import { effectivePermissions, permissionCeiling, type CreateUserInput, type PatchUserInput, type UserDto } from '@pos/shared';
import { writeAudit } from '../audit/audit';
import { SqlParams } from '../db/sql';
import { queryOne, queryRows, type Queryable } from '../db/types';
import { HttpError, notFound } from '../errors';
import { assertRoles, type TenantContext } from '../tenant/scope';

const COLS = `id, username, full_name AS "fullName", role, staff_unit_id AS "staffUnitId",
              supporter_id AS "supporterId", is_active AS "isActive", created_at AS "createdAt", permissions`;

type Row = Omit<UserDto, 'effectivePermissions'>;
const toDto = (r: Row): UserDto => ({ ...r, effectivePermissions: effectivePermissions(r.role, r.permissions) });

/** فقط مجوزهای داخل سقف نقش پذیرفته می‌شود؛ مدیر دفتر قابل محدودسازی نیست */
function checkPermissions(role: string, perms: readonly string[] | null | undefined): void {
  if (perms === null || perms === undefined) return;
  if (role === 'office_manager') throw new HttpError(422, 'MANAGER_UNRESTRICTED', 'دسترسی مدیر دفتر قابل محدودسازی نیست');
  const ceiling = new Set<string>(permissionCeiling(role));
  const bad = perms.filter((p) => !ceiling.has(p));
  if (bad.length > 0) throw new HttpError(422, 'PERMISSION_ABOVE_ROLE', `این مجوزها در سقف نقش این کاربر نیست: ${bad.join('، ')}`);
}

export async function listUsers(ctx: TenantContext, db: Queryable): Promise<UserDto[]> {
  assertRoles(ctx, ['office_manager']);
  return (await queryRows<Row>(db, `SELECT ${COLS} FROM users WHERE office_id = $1 ORDER BY username`, [ctx.officeId])).map(toDto);
}

export async function createUser(
  ctx: TenantContext, db: Queryable, input: CreateUserInput, passwordHash: string,
): Promise<UserDto> {
  assertRoles(ctx, ['office_manager']);
  checkPermissions(input.role, input.permissions);
  const staffUnitId = input.role === 'unit_head' ? input.staffUnitId : null;
  const supporterId = input.role === 'supporter' ? input.supporterId : null;
  return toDto((await queryOne<Row>(db,
    `INSERT INTO users (office_id, username, password_hash, full_name, role, staff_unit_id, supporter_id, permissions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[]) RETURNING ${COLS}`,
    [ctx.officeId, input.username, passwordHash, input.fullName, input.role, staffUnitId, supporterId, input.permissions ?? null])) as Row);
}

/** passwordHash فقط وقتی داده می‌شود که رمز عوض شود (فراخواننده توکن‌ها را باطل می‌کند). */
export async function patchUser(
  ctx: TenantContext, db: Queryable, id: number, input: PatchUserInput, passwordHash?: string,
): Promise<UserDto> {
  assertRoles(ctx, ['office_manager']);
  if (id === ctx.userId && input.isActive === false) {
    throw new HttpError(422, 'CANNOT_DEACTIVATE_SELF', 'غیرفعال‌کردن حساب خودتان مجاز نیست');
  }
  const p = new SqlParams();
  const sets: string[] = [];
  if (input.fullName !== undefined) sets.push(`full_name = ${p.add(input.fullName)}`);
  if (input.isActive !== undefined) sets.push(`is_active = ${p.add(input.isActive)}`);
  if (passwordHash !== undefined) sets.push(`password_hash = ${p.add(passwordHash)}`);
  let permBefore: string[] | null | undefined;
  if (input.permissions !== undefined) {
    const cur = await queryOne<{ role: string; permissions: string[] | null }>(db,
      'SELECT role, permissions FROM users WHERE office_id = $1 AND id = $2', [ctx.officeId, id]);
    if (!cur) throw notFound('کاربر');
    checkPermissions(cur.role, input.permissions);
    permBefore = cur.permissions;
    sets.push(`permissions = ${p.add(input.permissions)}::text[]`);
  }
  if (sets.length === 0) {
    const cur = await queryOne<Row>(db, `SELECT ${COLS} FROM users WHERE office_id = $1 AND id = $2`, [ctx.officeId, id]);
    if (!cur) throw notFound('کاربر');
    return toDto(cur);
  }
  const row = await queryOne<Row>(db,
    `UPDATE users SET ${sets.join(', ')} WHERE office_id = ${p.add(ctx.officeId)} AND id = ${p.add(id)} RETURNING ${COLS}`,
    p.values);
  if (!row) throw notFound('کاربر');
  if (input.permissions !== undefined) {
    // تغییر سطح دسترسی در تاریخچه ثبت می‌شود (چه کسی، برای چه کسی، از چه به چه)
    await writeAudit(db, {
      officeId: ctx.officeId, userId: ctx.userId, entityType: 'user', entityId: id, action: 'update',
      before: { permissions: permBefore ?? null }, after: { permissions: input.permissions },
    });
  }
  return toDto(row);
}
