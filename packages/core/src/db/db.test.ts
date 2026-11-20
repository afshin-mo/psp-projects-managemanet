import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate';
import { seedPeriods } from './periods';

/**
 * تست‌های دیتابیس‌دار. فقط وقتی اجرا می‌شوند که TEST_DATABASE_URL تنظیم شده باشد.
 * هر اجرا یک schema موقت می‌سازد (search_path) و در پایان حذف می‌کند، پس به داده‌ی واقعی دست نمی‌زند.
 */
const url = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../migrations');

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe.skipIf(!url)('database: migrations, periods, partitions, constraints', () => {
  const schema = `t_${randomBytes(5).toString('hex')}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 4 });
    await runMigrations(pool, MIGRATIONS_DIR);
    await seedPeriods(pool, 1402, 1410);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('اجرای دوباره‌ی مهاجرت‌ها چیزی اعمال نمی‌کند (idempotent)', async () => {
    const r = await runMigrations(pool, MIGRATIONS_DIR);
    expect(r.applied).toEqual([]);
    expect(r.skipped.length).toBeGreaterThanOrEqual(2);
  });

  it('تغییر فایل مهاجرت اعمال‌شده خطا می‌دهد', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await cp(MIGRATIONS_DIR, tmp, { recursive: true });
    const f = path.join(tmp, '0001_base.sql');
    await writeFile(f, `${await readFile(f, 'utf8')}\n-- tampered\n`);
    await expect(runMigrations(pool, tmp)).rejects.toThrow(/modified/);
  });

  it('seedPeriods idempotent است و ۱۲ دوره در هر سال می‌سازد', async () => {
    expect(await seedPeriods(pool, 1402, 1410)).toBe(0);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM periods');
    expect(rows[0].n).toBe(9 * 12);
  });

  it('دوره‌های هم‌پوشان رد می‌شوند (EXCLUDE)', async () => {
    const code = await pgCode(
      pool.query(`INSERT INTO periods (period_id, year, month, start_date, end_date)
                  VALUES (140499, 1404, 99, '2025-06-25', '2025-07-25')`),
    );
    expect(code).toBeDefined(); // 23514 (CHECK ماه) یا 23P01 (EXCLUDE)؛ هر دو رد شدن است
    const code2 = await pgCode(
      pool.query(`INSERT INTO periods (period_id, year, month, start_date, end_date)
                  VALUES (141101, 1411, 1, '2025-06-25', '2025-07-25')`),
    );
    expect(code2).toBe('23P01');
  });

  it('ensure_period_partition پارتیشن را می‌سازد و داده را به آن مسیر می‌دهد', async () => {
    const a = await pool.query('SELECT ensure_period_partition(140404) AS n');
    const b = await pool.query('SELECT ensure_period_partition(140404) AS n');
    expect(a.rows[0].n).toBe('transactions_snapshot_140404');
    expect(b.rows[0].n).toBe(a.rows[0].n);

    await pool.query(`INSERT INTO transactions_snapshot
      (office_id, terminal_id, as_of_date, cum_amount, cum_count, source, import_batch_id)
      VALUES (1, 10, '2025-06-22', 1000, 2, 1, 1), (1, 10, '2025-07-22', 5000, 9, 1, 1)`);
    const { rows } = await pool.query(
      `SELECT tableoid::regclass::text AS part, count(*)::int AS n FROM transactions_snapshot GROUP BY 1`,
    );
    expect(rows).toEqual([{ part: expect.stringMatching(/transactions_snapshot_140404$/), n: 2 }]);
  });

  it('ردیف خارج از پارتیشن‌های موجود رد می‌شود', async () => {
    const code = await pgCode(
      pool.query(`INSERT INTO transactions_snapshot
        (office_id, terminal_id, as_of_date, cum_amount, cum_count, source, import_batch_id)
        VALUES (1, 10, '2030-01-01', 1, 1, 1, 1)`),
    );
    expect(code).toBe('23514');
  });

  it('کلید اصلی snapshot تکرار (دفتر، ترمینال، تاریخ) را رد می‌کند', async () => {
    const code = await pgCode(
      pool.query(`INSERT INTO transactions_snapshot
        (office_id, terminal_id, as_of_date, cum_amount, cum_count, source, import_batch_id)
        VALUES (1, 10, '2025-06-22', 1, 1, 1, 1)`),
    );
    expect(code).toBe('23505');
  });

  it('دوره‌ی نامعتبر خطای مشخص می‌دهد', async () => {
    expect(await pgCode(pool.query('SELECT ensure_period_partition(150001)'))).toBe('P0002');
  });

  it('ensure_period_partitions همه‌ی دوره‌های هم‌پوشان را می‌سازد', async () => {
    const { rows } = await pool.query(`SELECT * FROM ensure_period_partitions('2025-06-22', '2025-09-23')`);
    expect(rows.map((r) => Object.values(r)[0])).toEqual([
      'transactions_snapshot_140404', 'transactions_snapshot_140405', 'transactions_snapshot_140406',
    ]);
  });

  it('ensure_audit_partition پارتیشن ماهانه‌ی میلادی می‌سازد', async () => {
    const { rows } = await pool.query(`SELECT ensure_audit_partition('2025-07-15') AS n`);
    expect(rows[0].n).toBe('audit_log_2025_07');
    await pool.query(`INSERT INTO audit_log (office_id, entity_type, entity_id, action, created_at)
                      VALUES (1, 'terminal', 5, 'create', '2025-07-15T12:00:00Z')`);
    const r = await pool.query(`SELECT count(*)::int AS n FROM audit_log`);
    expect(r.rows[0].n).toBe(1);
  });

  it('ایجاد دفتر، تنظیمات پیش‌فرض را می‌سازد', async () => {
    const o = await pool.query(`INSERT INTO offices (name, code) VALUES ('دفتر تست', 'T1') RETURNING id`);
    const s = await pool.query('SELECT * FROM office_settings WHERE office_id = $1', [o.rows[0].id]);
    expect(s.rows[0]).toMatchObject({
      new_terminal_cutoff_day: 20, preliminary_alert_min_day: 10, drop_alert_threshold_pct: 30,
    });
  });

  it('محدوده‌ی مقادیر تنظیمات کنترل می‌شود', async () => {
    const o = await pool.query(`INSERT INTO offices (name, code) VALUES ('دفتر ۲', 'T2') RETURNING id`);
    const code = await pgCode(
      pool.query('UPDATE office_settings SET new_terminal_cutoff_day = 0 WHERE office_id = $1', [o.rows[0].id]),
    );
    expect(code).toBe('23514');
  });

  it('قواعد نقش و دامنه‌ی کاربران', async () => {
    const o = await pool.query(`INSERT INTO offices (name, code) VALUES ('دفتر ۳', 'T3') RETURNING id`);
    const officeId = o.rows[0].id as number;
    const unit = await pool.query(
      `INSERT INTO staff_units (office_id, name) VALUES ($1, 'ستاد ۱') RETURNING id`, [officeId]);
    const sup = await pool.query(
      `INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1, $2, 'پشتیبان ۱') RETURNING id`,
      [officeId, unit.rows[0].id]);

    const ins = (office: number | null, role: string, unitId: number | null, supId: number | null, name: string) =>
      pool.query(
        `INSERT INTO users (office_id, username, password_hash, full_name, role, staff_unit_id, supporter_id)
         VALUES ($1, $2, 'x', 'n', $3, $4, $5)`, [office, name, role, unitId, supId]);

    // معتبر
    await ins(null, 'system_admin', null, null, 'root');
    await ins(officeId, 'office_manager', null, null, 'mgr');
    await ins(officeId, 'unit_head', unit.rows[0].id, null, 'head');
    await ins(officeId, 'supporter', null, sup.rows[0].id, 'sup');

    // نامعتبر
    expect(await pgCode(ins(officeId, 'system_admin', null, null, 'bad1'))).toBe('23514');
    expect(await pgCode(ins(null, 'office_manager', null, null, 'bad2'))).toBe('23514');
    expect(await pgCode(ins(officeId, 'unit_head', null, null, 'bad3'))).toBe('23514');
    expect(await pgCode(ins(officeId, 'supporter', unit.rows[0].id, sup.rows[0].id, 'bad4'))).toBe('23514');
    // نام کاربری تکراری
    expect(await pgCode(ins(null, 'system_admin', null, null, 'root'))).toBe('23505');
    expect(await pgCode(ins(officeId, 'office_manager', null, null, 'mgr'))).toBe('23505');
  });

  it('کلید خارجی ترکیبی مانع اتصال پشتیبان دفتر دیگر می‌شود (ایزوله‌ی tenant)', async () => {
    const a = await pool.query(`INSERT INTO offices (name, code) VALUES ('A', 'TA') RETURNING id`);
    const b = await pool.query(`INSERT INTO offices (name, code) VALUES ('B', 'TB') RETURNING id`);
    const unitA = await pool.query(
      `INSERT INTO staff_units (office_id, name) VALUES ($1, 'u') RETURNING id`, [a.rows[0].id]);
    const code = await pgCode(
      pool.query(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1, $2, 'x')`,
        [b.rows[0].id, unitA.rows[0].id]),
    );
    expect(code).toBe('23503');
  });
});
