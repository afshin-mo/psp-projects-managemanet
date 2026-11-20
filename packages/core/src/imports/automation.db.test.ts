import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayInTehran } from '@pos/shared';
import { createLogger } from '../logging/pino';
import { LocalStorage } from '../storage/storage';
import { createTestDb, type TestDb } from '../testing';
import { createTerminal } from '../repos/terminals';
import { assignPendingTerminals, listPendingTerminals } from '../repos/pending';
import { requestImportCommit } from '../repos/imports';
import type { TenantContext } from '../tenant/scope';
import { runCommit } from './commit';
import { runValidate } from './validate';
import type { ImportDeps } from './batches';

const url = process.env.TEST_DATABASE_URL;
const TODAY = todayInTehran();

describe.skipIf(!url)('فایل تراکنش: مبلغ کل، همگام‌سازی اطلاعات، ترمینال‌های تعریف‌نشده', () => {
  let db: TestDb;
  let deps: ImportDeps;
  let ctx: TenantContext;
  let officeId = 0;
  let aliId = 0;

  async function batch(rows: unknown[][], columnMap: Record<string, string>, asOfDate: string): Promise<number> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    rows.forEach((r) => ws.addRow(r));
    const data = Buffer.from(await wb.xlsx.writeBuffer());
    const key = `t/${randomUUID()}.xlsx`;
    await deps.storage.put(key, Readable.from([data]));
    const r = await db.pool.query(
      `INSERT INTO import_batches (office_id, type, status, file_name, file_size, file_hash, file_kind, storage_key, options, created_by)
       VALUES ($1,'transactions_cumulative','uploaded','tx.xlsx',$2,$3,'xlsx',$4,$5::jsonb,1) RETURNING id`,
      [officeId, data.length, createHash('sha256').update(key).digest('hex'), key,
       JSON.stringify({ headerRow: 1, calendar: 'auto', source: 'daily', asOfDate, columnMap })]);
    const id = (r.rows[0] as { id: number }).id;
    await runValidate(deps, id);
    await requestImportCommit(ctx, db.pool, id, 'strict');
    await runCommit(deps, id);
    return id;
  }

  const MAP = {
    terminal_no: 'ترمینال', amount: 'مبلغ خرید', tx_count: 'تعداد', total_amount: 'مبلغ کل',
    shop_name: 'فروشگاه', phone: 'موبایل', bank_name: 'بانک',
  };
  const HEAD = ['ترمینال', 'مبلغ خرید', 'تعداد', 'مبلغ کل', 'فروشگاه', 'موبایل', 'بانک'];

  beforeAll(async () => {
    db = await createTestDb();
    const o = await db.pool.query(`INSERT INTO offices (name, code) VALUES ('دفتر','AUT') RETURNING id`);
    officeId = (o.rows[0] as { id: number }).id;
    const u = await db.pool.query(`INSERT INTO staff_units (office_id, name) VALUES ($1,'ستاد') RETURNING id`, [officeId]);
    const s = await db.pool.query(`INSERT INTO supporters (office_id, staff_unit_id, full_name) VALUES ($1,$2,'علی') RETURNING id`,
      [officeId, (u.rows[0] as { id: number }).id]);
    aliId = (s.rows[0] as { id: number }).id;
    await db.pool.query(`INSERT INTO banks (office_id, name) VALUES ($1,'ملی')`, [officeId]);
    ctx = { userId: 1, officeId, role: 'office_manager', unitId: null, supporterId: null };
    deps = {
      pool: db.pool, storage: new LocalStorage(mkdtempSync(path.join(os.tmpdir(), 'pos-aut-'))),
      logger: createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }, 'test'),
      stagingSchema: db.schema, maxRows: 1000, vacuumThreshold: 1_000_000_000, today: () => TODAY,
    };
  });
  afterAll(async () => { await db?.cleanup(); });

  it('مبلغ کل ذخیره می‌شود و اطلاعات ترمینال در مغایرت به‌روز و ثبت می‌شود', async () => {
    await createTerminal(ctx, db.pool, { terminalNo: '101', supporterId: aliId, shopName: 'قدیمی' });
    const id = await batch([HEAD, ['101', 1000, 5, 1500, 'جدید', '09121234567', 'پاسارگاد']], MAP, TODAY);

    const snap = (await db.pool.query(`SELECT cum_amount, cum_total_amount FROM transactions_snapshot WHERE office_id = $1`, [officeId])).rows[0];
    expect([Number(snap.cum_amount), Number(snap.cum_total_amount)]).toEqual([1000, 1500]);

    const t = (await db.pool.query(`SELECT shop_name, phone, bank_id, info_as_of FROM terminals WHERE office_id = $1 AND terminal_no = '101'`, [officeId])).rows[0];
    expect(t.shop_name).toBe('جدید');
    expect(t.phone).toBe('09121234567');
    expect(t.bank_id).not.toBeNull(); // بانک «پاسارگاد» خودکار ساخته شد

    const audit = (await db.pool.query(
      `SELECT user_id, batch_id, before, after FROM audit_log WHERE office_id = $1 AND entity_type = 'terminal' AND action = 'import'`, [officeId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].batch_id).toBe(id);
    expect(audit[0].before.shopName).toBe('قدیمی');
    expect(audit[0].after.shopName).toBe('جدید');

    // تغییر بانک ← تاریخچه‌ی جدید با ثبت‌کننده
    const hist = (await db.pool.query(`SELECT bank_id, end_date, changed_by FROM terminal_supporter_history WHERE office_id = $1 ORDER BY start_date`, [officeId])).rows;
    expect(hist.length).toBeGreaterThanOrEqual(1);
    expect(hist[hist.length - 1].end_date).toBeNull();
    expect(hist[hist.length - 1].changed_by).toBe(1);
  });

  it('فایل قدیمی‌تر اطلاعات جدیدتر را بازنویسی نمی‌کند', async () => {
    await batch([HEAD, ['101', 900, 4, 1400, 'خیلی قدیمی', null, null]], MAP, '2000-01-02');
    const t = (await db.pool.query(`SELECT shop_name FROM terminals WHERE office_id = $1 AND terminal_no = '101'`, [officeId])).rows[0];
    expect(t.shop_name).toBe('جدید');
  });

  it('ترمینال ناشناخته در صندوق می‌ماند و با تعیین پشتیبان وارد آمار می‌شود', async () => {
    await batch([HEAD, ['555', 7000, 3, 9000, 'فروشگاه تازه', '09350000000', 'ملی']], MAP, TODAY);
    const list = await listPendingTerminals(ctx, db.pool, { status: 'pending', activeOnly: true, limit: 50 });
    const p = list.items.find((x) => x.terminalNo === '555');
    expect(p?.shopName).toBe('فروشگاه تازه');
    expect(p?.lastTotalAmount).toBe(9000);
    expect(p?.matchedBankId).not.toBeNull();
    expect((await db.pool.query(`SELECT 1 FROM transactions_snapshot s JOIN terminals t ON t.id = s.terminal_id WHERE t.terminal_no = '555'`)).rowCount).toBe(0);

    const r = await assignPendingTerminals(ctx, db.pool, { terminalNos: ['555'], supporterId: aliId });
    expect(r.created).toBe(1);
    expect(r.snapshotsAdopted).toBe(1);
    const t = (await db.pool.query(`SELECT shop_name, current_supporter_id FROM terminals WHERE office_id = $1 AND terminal_no = '555'`, [officeId])).rows[0];
    expect(t.shop_name).toBe('فروشگاه تازه');
    expect(t.current_supporter_id).toBe(aliId);
    expect((await db.pool.query(`SELECT 1 FROM pending_terminals WHERE office_id = $1 AND terminal_no = '555' AND status = 'resolved'`, [officeId])).rowCount).toBe(1);
  });
});
