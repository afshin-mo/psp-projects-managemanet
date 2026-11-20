import type { CreateExportInput, ExportJobDto } from '@pos/shared';
import { queryOne, type Queryable } from '../db/types';
import { notFound } from '../errors';
import { assertRoles, type TenantContext, type TenantRole } from '../tenant/scope';

const ROLES: readonly TenantRole[] = ['office_manager', 'data_admin', 'unit_head', 'supporter'];
const COLS = `id, kind, status, row_count AS "rowCount", error, created_at AS "createdAt", expires_at AS "expiresAt"`;

/** پارامترها همراه «ctx» کاربر ذخیره می‌شوند تا Worker همان دامنه‌ی دسترسی را اعمال کند */
export async function createExportJob(ctx: TenantContext, db: Queryable, input: CreateExportInput, period: number): Promise<ExportJobDto> {
  assertRoles(ctx, ROLES);
  const params = {
    ctx, period, unitIds: input.unitIds, supporterIds: input.supporterIds, routeGroupIds: input.routeGroupIds, bankIds: input.bankIds,
  };
  return (await queryOne<ExportJobDto>(db,
    `INSERT INTO export_jobs (office_id, user_id, kind, params) VALUES ($1, $2, $3, $4::jsonb) RETURNING ${COLS}`,
    [ctx.officeId, ctx.userId, input.kind, JSON.stringify(params)])) as ExportJobDto;
}

/** فقط سازنده‌ی خروجی آن را می‌بیند */
export async function getExportJob(ctx: TenantContext, db: Queryable, id: number): Promise<ExportJobDto & { storageKey: string | null }> {
  assertRoles(ctx, ROLES);
  const row = await queryOne<ExportJobDto & { storageKey: string | null }>(db,
    `SELECT ${COLS}, storage_key AS "storageKey" FROM export_jobs WHERE office_id = $1 AND user_id = $2 AND id = $3`,
    [ctx.officeId, ctx.userId, id]);
  if (!row) throw notFound('خروجی');
  return row;
}
