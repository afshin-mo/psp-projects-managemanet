import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * اجراکننده‌ی مهاجرت‌های SQL (یک زنجیره‌ی ترتیبی برای جدول‌ها، پارتیشن‌ها و توابع).
 *  - هر فایل در یک transaction اجرا می‌شود، مگر خط اول آن `-- no-transaction` باشد.
 *  - checksum فایل‌های اعمال‌شده کنترل می‌شود؛ تغییر فایل قدیمی خطا است.
 *  - advisory lock مانع اجرای هم‌زمان از چند پروسه می‌شود.
 */
export async function runMigrations(pool: Pool, dir: string, log: (msg: string) => void = () => {}): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['pos:migrate']);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);

    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    const seen = new Set<string>();
    for (const file of files) {
      const prefix = file.slice(0, 4);
      if (seen.has(prefix)) throw new Error(`Duplicate migration number ${prefix}`);
      seen.add(prefix);

      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev !== undefined) {
        if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        result.skipped.push(file);
        continue;
      }

      const useTx = !sql.startsWith('-- no-transaction');
      log(`applying ${file}`);
      try {
        if (useTx) await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        if (useTx) await client.query('COMMIT');
      } catch (err) {
        if (useTx) await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['pos:migrate']);
    } finally {
      client.release();
    }
  }
}
