import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeSearchText, todayInTehran } from '@pos/shared';
import { createLogger } from '../logging/pino';
import { LocalStorage } from '../storage/storage';
import { createTestDb, type TestDb } from '../testing';
import { createTerminal } from '../repos/terminals';
import { requestImportCommit, getImportBatch } from '../repos/imports';
import type { TenantContext } from '../tenant/scope';
import { housekeepingJob } from '../jobs/maintenance';
import { runCommit } from './commit';
import { runValidate } from './validate';
import type { ImportDeps } from './batches';

const url = process.env.TEST_DATABASE_URL;
const TODAY = todayInTehran();

describe.skipIf(!url)('ایمپورت: staging، اعتبارسنجی، merge', () => {
  let db: TestDb;
  let deps: ImportDeps;
  let ctx: TenantContext;
  let officeId = 0;
  let aliId = 0;
  let mariaId = 0;

  async function xlsx(rows: unknown[][]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async function newBatch(
    type: string, data: Buffer, columnMap: Record<string, string>, options: Record<string, unknown> = {}, kind: 'xlsx' | 'csv' = 'xlsx',
  ): Promise<number> {
    const key = `t/${randomUUID()}.${kind}`;
    await deps.storage.put(key, Readable.from([data]));
    const r = await db.pool.query(
      `INSERT INTO import_batches (office_id, type, status, file_name, file_size, file_hash, file_kind, storage_key, options, created_by)
       VALUES ($1,$2,'uploaded','f',$3,$4,$5,$6,$7::jsonb,1) RETURNING id`,
      [officeId, type, data.length, createHash('sha256').update(key).digest('hex'), kind, key,
       JSON.stringify({ headerRow: 1, calendar: 'auto', source: 'daily', ...options, columnMap })]);
    return (r.rows[0] as { id: number }).id;
  }

  const batchRow = async (id: number) => (await db.pool.query('SELECT * FROM import_batches WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
  const errorsOf = async (id: number) =>
    (await db.pool.query('SELECT row_no, code FROM import_batch_errors WHERE batch_id = $1 ORDER BY row_no', [id])).rows as Array<{ row_no: number; code: string }>;
  async function validate(id: number) { await runValidate(deps, id); return batchRow(id); }
  async function commit(id: number, mode: 'strict' | 'skip_invalid') {
    await requestImportCommit(ctx, db.pool, id, mode);
    await runCommit(deps, id);
    return batchRow(id);
  }

  beforeAll(async () => {
    db = await createTestDb();
    const o = await db.pool.query(`INSERT INTO offices (name, code) VALUES ('دفتر','IMP') RETURNING id`);
    officeId = (o.rows[0] as { id: number }).id;
    const u = await db.pool.query(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد') RETURNING id`, [officeId]);
    const unit = (u.rows[0] as { id: number }).id;
    const sup = async (n: string) => ((await db.pool.query(
      `INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,$3) RETURNING id`, [officeId, unit, n])).rows[0] as { id: number }).id;
    aliId = await sup('علی رضایی');
    mariaId = await sup('مریم احمدی');
    await db.pool.query(`INSERT INTO banks (office_id, name) VALUES ($1,'ملی')`, [officeId]);
    await db.pool.query(`INSERT INTO route_groups (office_id, name) VALUES ($1,'مسیر ۱')`, [officeId]);
    ctx = { userId: 1, officeId, role: 'office_manager', unitId: null, supporterId: null };
    deps = {
      pool: db.pool, storage: new LocalStorage(mkdtempSync(path.join(os.tmpdir(), 'pos-imp-'))),
      logger: createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }, 'test'),
      stagingSchema: db.schema, maxRows: 1000, vacuumThreshold: 1_000_000_000, today: () => TODAY,
    };
  });
  afterAll(async () => { await db?.cleanup(); });

  // ------------------------------------------------------------------ ترمینال‌ها
  const TMAP = { terminal_no: 'شماره ترمینال', shop_name: 'نام فروشگاه', supporter_name: 'پشتیبان', route_name: 'مسیر', bank_name: 'بانک', installed_at: 'تاریخ نصب' };

  it('ترمینال: اعتبارسنجی ردیف‌ها، strict مسدود، skip_invalid فقط معتبرها', async () => {
    const id = await newBatch('terminals', await xlsx([
      ['شماره ترمینال', 'نام فروشگاه', 'پشتیبان', 'مسیر', 'بانک', 'تاریخ نصب'],
      ['۰۰۱', 'فروشگاه الف', 'علي رضايي', 'مسیر ۱', 'ملی', '1404/01/10'],
      ['002', 'ب', 'نامعلوم', null, null, null],
      ['001', 'تکراری', 'علی رضایی', null, null, null],
      ['003', 'ج', null, null, null, null],
      ['004', 'د', 'مریم احمدی', null, null, 'bad'],
    ]), TMAP);
    const b = await validate(id);
    expect(b.status).toBe('validated');
    expect([b.total_rows, b.error_rows, b.valid_rows]).toEqual([5, 4, 1]);
    expect(await errorsOf(id)).toEqual([
      { row_no: 3, code: 'SUPPORTER_NAME_NOT_FOUND' }, { row_no: 4, code: 'DUPLICATE_IN_FILE' },
      { row_no: 5, code: 'SUPPORTER_REQUIRED' }, { row_no: 6, code: 'BAD_DATE' },
    ]);
    await expect(requestImportCommit(ctx, db.pool, id, 'strict')).rejects.toMatchObject({ code: 'HAS_ERRORS' });

    const done = await commit(id, 'skip_invalid');
    expect(done.status).toBe('completed');
    expect([done.inserted_rows, done.updated_rows]).toEqual([1, 0]);
    const t = (await db.pool.query(`SELECT id, terminal_no, search_norm, current_supporter_id, route_group_id, bank_id FROM terminals WHERE office_id = $1`, [officeId])).rows;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ terminal_no: '001', search_norm: '001 فروشگاه الف', current_supporter_id: aliId });
    expect(t[0].route_group_id).not.toBeNull();
    const h = (await db.pool.query(`SELECT start_date::text AS s, end_date FROM terminal_supporter_history WHERE terminal_id = $1`, [t[0].id])).rows;
    expect(h).toEqual([{ s: '2025-03-30', end_date: null }]);
    const a = await db.pool.query(`SELECT action FROM audit_log WHERE entity_id = $1`, [t[0].id]);
    expect(a.rows).toEqual([{ action: 'import' }]);
    expect((await db.pool.query('SELECT data_version FROM offices WHERE id = $1', [officeId])).rows[0]).toEqual({ data_version: 1 });
  });

  it('ترمینال: ویرایش، تعویض پشتیبان (SCD2)، ایدمپوتنت، و تاریخ اعمال قبل از شروع', async () => {
    const map = { terminal_no: 'شماره ترمینال', shop_name: 'نام فروشگاه', supporter_name: 'پشتیبان' };
    const rows = [['شماره ترمینال', 'نام فروشگاه', 'پشتیبان'], ['001', 'فروشگاه ب', 'مریم احمدی']];
    const id = await newBatch('terminals', await xlsx(rows), map, { effectiveDate: TODAY });
    expect((await validate(id)).error_rows).toBe(0);
    const done = await commit(id, 'strict');
    expect([done.inserted_rows, done.updated_rows, done.unchanged_rows]).toEqual([0, 1, 0]);

    const t = (await db.pool.query(`SELECT id, shop_name, current_supporter_id, search_norm FROM terminals WHERE terminal_no = '001'`)).rows[0];
    expect(t).toMatchObject({ shop_name: 'فروشگاه ب', current_supporter_id: mariaId, search_norm: '001 فروشگاه ب' });
    const hist = (await db.pool.query(
      `SELECT supporter_id, start_date::text AS s, end_date::text AS e FROM terminal_supporter_history WHERE terminal_id = $1 ORDER BY start_date`, [t.id])).rows;
    expect(hist).toEqual([{ supporter_id: aliId, s: '2025-03-30', e: TODAY }, { supporter_id: mariaId, s: TODAY, e: null }]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM recompute_outbox WHERE terminal_id = $1 AND reason = 'assignment'`, [t.id])).rows[0]).toEqual({ n: 1 });

    // همان داده دوباره: هیچ تغییری
    const again = await newBatch('terminals', await xlsx(rows), map, { effectiveDate: TODAY });
    await validate(again);
    const d2 = await commit(again, 'strict');
    expect([d2.inserted_rows, d2.updated_rows, d2.unchanged_rows]).toEqual([0, 0, 1]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM terminal_supporter_history WHERE terminal_id = $1`, [t.id])).rows[0]).toEqual({ n: 2 });

    // تاریخ اعمال قبل از شروع تخصیص جاری
    const bad = await newBatch('terminals', await xlsx([['شماره ترمینال', 'پشتیبان'], ['001', 'علی رضایی']]),
      { terminal_no: 'شماره ترمینال', supporter_name: 'پشتیبان' }, { effectiveDate: '2020-01-01' });
    await validate(bad);
    expect(await errorsOf(bad)).toEqual([{ row_no: 2, code: 'EFFECTIVE_BEFORE_START' }]);
  });

  it('ترمینال از CSV (صفر اول حفظ می‌شود)', async () => {
    const csv = Buffer.from('شماره ترمینال,نام فروشگاه,پشتیبان\n00555,فروشگاه ث,علی رضایی\n', 'utf8');
    const id = await newBatch('terminals', csv, { terminal_no: 'شماره ترمینال', shop_name: 'نام فروشگاه', supporter_name: 'پشتیبان' }, {}, 'csv');
    expect((await validate(id)).error_rows).toBe(0);
    await commit(id, 'strict');
    expect((await db.pool.query(`SELECT terminal_no FROM terminals WHERE terminal_no = '00555'`)).rowCount).toBe(1);
  });

  // ------------------------------------------------------------------ تراکنش تجمعی
  const XMAP = { terminal_no: 'شماره ترمینال', amount: 'مبلغ', tx_count: 'تعداد' };
  const XHEAD = ['شماره ترمینال', 'مبلغ', 'تعداد'];
  const snap = async (no: string) => (await db.pool.query(
    `SELECT s.as_of_date::text AS d, s.cum_amount, s.cum_count, s.source FROM transactions_snapshot s
       JOIN terminals t ON t.id = s.terminal_id WHERE t.terminal_no = $1 ORDER BY 1`, [no])).rows;

  it('تراکنش: ترمینال تعریف‌نشده، خطای عدد، commit، affected', async () => {
    for (const no of ['002', '003']) {
      await createTerminal(ctx, db.pool, { terminalNo: no, supporterId: aliId });
    }
    const id = await newBatch('transactions_cumulative', await xlsx([
      XHEAD, ['001', '۱٬۰۰۰٬۰۰۰', 5], ['002', 500, 2], ['999', 10, 1], ['002', 'abc', 1],
    ]), XMAP, { asOfDate: '2025-06-25' });
    const b = await validate(id);
    expect([b.total_rows, b.error_rows, b.skipped_rows, b.valid_rows]).toEqual([4, 1, 1, 2]);
    expect(await errorsOf(id)).toEqual([{ row_no: 5, code: 'BAD_AMOUNT' }]);
    const unk = await db.pool.query('SELECT terminal_no, rows_count FROM import_unknown_terminals WHERE batch_id = $1', [id]);
    expect(unk.rows).toEqual([{ terminal_no: '999', rows_count: 1 }]);

    const done = await commit(id, 'skip_invalid');
    expect([done.inserted_rows, done.updated_rows]).toEqual([2, 0]);
    expect(await snap('001')).toEqual([{ d: '2025-06-25', cum_amount: 1_000_000, cum_count: 5, source: 1 }]);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM import_batch_affected WHERE batch_id = $1', [id])).rows[0]).toEqual({ n: 2 });
  });

  it('تراکنش: یکنوایی نسبت به رکوردهای قبل و بعد در دیتابیس', async () => {
    const lower = await newBatch('transactions_cumulative', await xlsx([XHEAD, ['001', '900,000', 6], ['002', 700, 4]]), XMAP, { asOfDate: '2025-06-28' });
    await validate(lower);
    expect(await errorsOf(lower)).toEqual([{ row_no: 2, code: 'CUM_NON_MONOTONIC' }]);
    await commit(lower, 'skip_invalid');
    expect(await snap('002')).toHaveLength(2);
    expect(await snap('001')).toHaveLength(1);

    // همان ماه شمسی (تیر ۱۴۰۴ از ۲۰۲۵-۰۶-۲۲ شروع می‌شود): ۲٬۰۰۰٬۰۰۰ در ۰۶-۲۳ از رکورد بعدی (۰۶-۲۵) بزرگ‌تر است
    const older = await newBatch('transactions_cumulative', await xlsx([XHEAD, ['001', '2,000,000', 9]]), XMAP, { asOfDate: '2025-06-23' });
    await validate(older);
    expect(await errorsOf(older)).toEqual([{ row_no: 2, code: 'CUM_NON_MONOTONIC' }]);

    // ماه شمسی قبل (خرداد): مانده از ابتدای ماه صفر می‌شود، پس مقایسه با تیر معنا ندارد و مجاز است
    const prevMonth = await newBatch('transactions_cumulative', await xlsx([XHEAD, ['001', '2,000,000', 9]]), XMAP, { asOfDate: '2025-06-20' });
    await validate(prevMonth);
    expect(await errorsOf(prevMonth)).toEqual([]);
  });

  it('تراکنش: ایمپورت دوباره‌ی همان داده تغییری ایجاد نمی‌کند', async () => {
    const id = await newBatch('transactions_cumulative', await xlsx([XHEAD, ['001', 1000000, 5], ['002', 500, 2]]), XMAP, { asOfDate: '2025-06-25' });
    expect((await validate(id)).error_rows).toBe(0);
    const done = await commit(id, 'strict');
    expect([done.inserted_rows, done.updated_rows, done.unchanged_rows]).toEqual([0, 0, 2]);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM import_batch_affected WHERE batch_id = $1', [id])).rows[0]).toEqual({ n: 0 });
  });

  it('تراکنش: ناسازگاری داخل فایل، تاریخ از ستون شمسی، و تاریخ آینده', async () => {
    const id = await newBatch('transactions_cumulative', await xlsx([
      [...XHEAD, 'تاریخ'], ['003', 10, 1, '1404/04/05'], ['003', 5, 1, '1404/04/06'],
    ]), { ...XMAP, as_of_date: 'تاریخ' });
    await validate(id);
    expect(await errorsOf(id)).toEqual([{ row_no: 2, code: 'CUM_NON_MONOTONIC' }, { row_no: 3, code: 'CUM_NON_MONOTONIC' }]);

    const fut = await newBatch('transactions_cumulative', await xlsx([XHEAD, ['003', 10, 1]]), XMAP, { asOfDate: '2999-01-01' });
    await validate(fut);
    expect(await errorsOf(fut)).toEqual([{ row_no: 2, code: 'FUTURE_DATE' }]);

    const noDate = await newBatch('transactions_cumulative', await xlsx([XHEAD, ['003', 10, 1]]), XMAP, {});
    const nb = await validate(noDate);
    expect(nb.status).toBe('failed');
    expect((nb.error_summary as { code: string }).code).toBe('ASOF_REQUIRED');
  });

  it('تراکنش: فایل ماهانه روی آخرین روز ماه با source=2 ثبت می‌شود', async () => {
    const id = await newBatch('transactions_cumulative', await xlsx([XHEAD, ['003', 1500, 9]]), XMAP, { source: 'monthly', periodId: 140404 });
    expect((await validate(id)).error_rows).toBe(0);
    await commit(id, 'strict');
    expect(await snap('003')).toEqual([{ d: '2025-07-22', cum_amount: 1500, cum_count: 9, source: 2 }]);
  });

  it('ستون الزامی در فایل نباشد، دسته failed می‌شود', async () => {
    const id = await newBatch('transactions_cumulative', await xlsx([['شماره ترمینال', 'مبلغ'], ['001', 1]]), XMAP, { asOfDate: '2025-06-25' });
    const b = await validate(id);
    expect(b.status).toBe('failed');
    expect((b.error_summary as { code: string }).code).toBe('MAPPING_INVALID');
  });

  // ------------------------------------------------------------------ سایر
  it('fa_normalize در SQL با normalizeSearchText هم‌ارز است', async () => {
    const samples = ['عليرضا  احمدي', 'كوروش\u200cبزرگ', 'محمَّد ٠١٢٣ ۴۵۶', 'فروشگاه\u00A0مرکزی', 'ABC def', '  ', 'ة'];
    for (const s of samples) {
      const r = await db.pool.query('SELECT fa_normalize($1) AS v', [s]);
      expect((r.rows[0] as { v: string }).v).toBe(normalizeSearchText(s));
    }
  });

  it('housekeeping: staging یتیم پاک می‌شود', async () => {
    await db.pool.query(`CREATE UNLOGGED TABLE ${db.schema}.s_999999 (x int)`);
    const r = await housekeepingJob(db.pool, deps.logger, db.schema);
    expect(r.stagingDropped).toBeGreaterThanOrEqual(1);
    expect((await db.pool.query(`SELECT to_regclass('${db.schema}.s_999999')::text AS r`)).rows[0]).toEqual({ r: null });
  });

  it('getImportBatch در دامنه‌ی دفتر دیگر یافت نمی‌شود', async () => {
    const id = await newBatch('terminals', await xlsx([['شماره ترمینال'], ['1']]), { terminal_no: 'شماره ترمینال' });
    await expect(getImportBatch({ ...ctx, officeId: officeId + 999 }, db.pool, id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
