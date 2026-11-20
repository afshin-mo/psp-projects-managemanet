import type { SqlParams } from '../db/sql';
import { forbidden } from '../errors';
import type { UserRole } from '../db/schema';

export type TenantRole = Exclude<UserRole, 'system_admin'>;

/** هویت و دامنه‌ی دسترسی کاربر؛ از JWT ساخته می‌شود و همه‌ی Repositoryها آن را الزاماً می‌گیرند. */
export interface TenantContext {
  readonly userId: number;
  readonly officeId: number;
  readonly role: TenantRole;
  readonly unitId: number | null;
  readonly supporterId: number | null;
}

export interface ScopeColumns {
  /** ستون office_id (الزامی) */
  office: string;
  /** ستون ستاد؛ برای مسئول ستاد (و پشتیبان وقتی ستون پشتیبان ندارد) */
  unit?: string;
  /** ستون پشتیبان؛ برای نقش پشتیبان */
  supporter?: string;
  /** داده‌ی مرجع دفتر (بانک، مسیر): همه‌ی نقش‌های دفتر می‌بینند */
  officeWide?: boolean;
}

/**
 * «تنها نقطه‌ی» ساخت فیلتر tenant و نقش. خروجی: لیست شرط‌ها (با AND ترکیب شود).
 * اصل fail-closed: اگر ستون لازم برای محدودسازی نقش داده نشود، خطا می‌دهد، نه اینکه همه‌چیز را نشان بدهد.
 */
export function scopeWhere(ctx: TenantContext, p: SqlParams, cols: ScopeColumns): string[] {
  const out = [`${cols.office} = ${p.add(ctx.officeId)}`];
  if (cols.officeWide || ctx.role === 'office_manager' || ctx.role === 'data_admin') return out;

  const byUnit = (): string[] => {
    if (!cols.unit) throw new Error('scopeWhere: unit column is required for this role');
    out.push(ctx.unitId === null ? 'FALSE' : `${cols.unit} = ${p.add(ctx.unitId)}`);
    return out;
  };

  if (ctx.role === 'unit_head') return byUnit();

  // supporter
  if (cols.supporter) {
    out.push(ctx.supporterId === null ? 'FALSE' : `${cols.supporter} = ${p.add(ctx.supporterId)}`);
    return out;
  }
  return byUnit();
}

export function assertRoles(ctx: TenantContext, allowed: readonly TenantRole[]): void {
  if (!allowed.includes(ctx.role)) throw forbidden();
}
