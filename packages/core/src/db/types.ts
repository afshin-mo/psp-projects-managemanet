import pg from 'pg';
import type { CustomTypesConfig } from 'pg';

/** رابط حداقلی اجرای کوئری؛ هم Pool و هم PoolClient با آن سازگارند. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export async function queryRows<T>(db: Queryable, text: string, values: unknown[] = []): Promise<T[]> {
  return (await db.query(text, values)).rows as T[];
}

export async function queryOne<T>(db: Queryable, text: string, values: unknown[] = []): Promise<T | undefined> {
  return (await queryRows<T>(db, text, values))[0];
}

export async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* اتصال خراب است؛ خطای اصلی مهم‌تر است */
    }
    throw err;
  } finally {
    client.release();
  }
}

const defaultTimestamptz = pg.types.getTypeParser(1184, 'text');

/**
 * parserهای اختصاصی (فقط برای pool های این برنامه، نه سراسری):
 *  - bigint → number (اگر از محدوده‌ی امن JS بیرون بود خطا)
 *  - date → رشته‌ی YYYY-MM-DD (بدون تبدیل به Date و مشکل منطقه‌ی زمانی)
 *  - timestamptz → رشته‌ی ISO (UTC)
 */
export const pgTypes = {
  getTypeParser(oid: number, format?: string) {
    if (format !== 'binary') {
      if (oid === 20) {
        return (v: string): number => {
          const n = Number(v);
          if (!Number.isSafeInteger(n)) throw new RangeError(`bigint out of safe range: ${v}`);
          return n;
        };
      }
      if (oid === 1082) return (v: string): string => v;
      if (oid === 1184) {
        return (v: string): string => {
          const d = defaultTimestamptz(v) as unknown;
          return d instanceof Date ? d.toISOString() : String(d);
        };
      }
    }
    return pg.types.getTypeParser(oid, format as 'text');
  },
} as unknown as CustomTypesConfig;
