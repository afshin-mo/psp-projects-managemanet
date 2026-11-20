import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from '../db/migrate';
import { seedPeriods } from '../db/periods';
import { pgTypes } from '../db/types';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../migrations');

export interface TestDb {
  pool: pg.Pool;
  schema: string;
  cleanup(): Promise<void>;
}

/** schema موقت + مهاجرت‌ها + periods + پارتیشن audit ماه‌های اطراف. نیازمند TEST_DATABASE_URL. */
export async function createTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  const schema = `t_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: url, options: `-c search_path=${schema},public`, max: 6, types: pgTypes,
  });
  await runMigrations(pool, MIGRATIONS_DIR);
  await seedPeriods(pool, 1400, 1410);
  for (const off of [-1, 0, 1, 2]) {
    await pool.query(`SELECT ensure_audit_partition((date_trunc('month', now()) + make_interval(months => $1::int))::date)`, [off]);
  }
  return {
    pool, schema,
    async cleanup() {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    },
  };
}
