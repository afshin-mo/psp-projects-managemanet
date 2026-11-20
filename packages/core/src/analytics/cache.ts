import { createHash } from 'node:crypto';
import { queryOne, type Queryable } from '../db/types';
import type { TenantContext } from '../tenant/scope';

/** کش نتایج آماری؛ در صورت نیاز می‌توان بعداً با Redis جایگزین کرد. */
export interface CacheProvider {
  get<T>(officeId: number, key: string, dataVersion: number): Promise<T | null>;
  set(officeId: number, key: string, dataVersion: number, value: unknown): Promise<void>;
}

/** read: خواندن (ممکن است replica باشد)، write: نوشتن */
export class PgCache implements CacheProvider {
  constructor(private readonly read: Queryable, private readonly write: Queryable) {}

  async get<T>(officeId: number, key: string, dataVersion: number): Promise<T | null> {
    const row = await queryOne<{ payload: T }>(this.read,
      'SELECT payload FROM stats_cache WHERE office_id = $1 AND cache_key = $2 AND data_version = $3', [officeId, key, dataVersion]);
    return row ? row.payload : null;
  }

  async set(officeId: number, key: string, dataVersion: number, value: unknown): Promise<void> {
    await this.write.query(
      `INSERT INTO stats_cache (office_id, cache_key, data_version, payload) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT DO NOTHING`, [officeId, key, dataVersion, JSON.stringify(value)]);
  }
}

/**
 * کش با کلید (endpoint + فیلترها + دامنه‌ی نقش + نسخه‌ی داده). خطای کش هرگز درخواست را خراب نمی‌کند.
 * هر تغییر داده (ایمپورت، تجمیع، تنظیمات) offices.data_version را زیاد می‌کند.
 */
export async function cached<T>(
  cache: CacheProvider, db: Queryable, ctx: TenantContext, endpoint: string, params: unknown, compute: () => Promise<T>,
): Promise<T> {
  const dv = (await queryOne<{ v: number }>(db, 'SELECT data_version AS v FROM offices WHERE id = $1', [ctx.officeId]))?.v ?? 0;
  const key = createHash('sha256')
    .update(JSON.stringify([endpoint, params, ctx.role, ctx.unitId, ctx.supporterId]))
    .digest('hex');
  try {
    const hit = await cache.get<T>(ctx.officeId, key, dv);
    if (hit !== null) return hit;
  } catch { /* کش در دسترس نیست؛ مستقیم محاسبه می‌شود */ }
  const value = await compute();
  try {
    await cache.set(ctx.officeId, key, dv, value);
  } catch { /* ignore */ }
  return value;
}
