import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Env } from '../config/env';
import type { Logger } from '../logging/pino';
import { pgTypes } from './types';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export interface Pools {
  /** نوشتن، صف، مهاجرت، کارهای Worker */
  write: pg.Pool;
  /** فقط کوئری آماری و لیست. اگر READ_DATABASE_URL تنظیم شود به Read Replica اشاره می‌کند. */
  read: pg.Pool;
  writeDb: Db;
  readDb: Db;
  /** true اگر pool خواندن به سرور دیگری وصل است */
  hasReplica: boolean;
  close(): Promise<void>;
}

export function createPools(env: Env, logger: Logger, applicationName = 'pos'): Pools {
  const write = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_WRITE_POOL_MAX,
    application_name: `${applicationName}-write`,
    types: pgTypes,
  });

  const hasReplica = Boolean(env.READ_DATABASE_URL);
  const read = new pg.Pool({
    connectionString: env.READ_DATABASE_URL ?? env.DATABASE_URL,
    max: env.DB_READ_POOL_MAX,
    application_name: `${applicationName}-read`,
    types: pgTypes,
    // جلوگیری از کوئری آماری بی‌پایان روی pool خواندن
    statement_timeout: env.DB_READ_STATEMENT_TIMEOUT_MS,
  });

  for (const [name, pool] of [['write', write], ['read', read]] as const) {
    pool.on('error', (err) => logger.error({ err, pool: name }, 'idle pg client error'));
  }

  return {
    write,
    read,
    writeDb: drizzle(write, { schema }),
    readDb: drizzle(read, { schema }),
    hasReplica,
    async close() {
      await Promise.all([write.end(), read.end()]);
    },
  };
}

/** رابط حداقلی برای سلامت‌سنجی (قابل جایگزینی با fake در تست) */
export interface Pingable {
  query(text: string): Promise<unknown>;
}

export async function pingPool(pool: Pingable, timeoutMs = 2000): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
