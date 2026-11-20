import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { isStreamableOrder } from './xlsx-source';
import { readHeaders, readRows, type RawRow } from './reader';

async function build(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function collect(buf: Buffer): Promise<RawRow[]> {
  const out: RawRow[] = [];
  for await (const r of readRows(Readable.from([buf]), 'xlsx')) out.push(r);
  return out;
}

describe('خواندن xlsx به‌صورت stream', () => {
  it('ترتیب ورودی‌های zip را تشخیص می‌دهد', () => {
    expect(isStreamableOrder(['[Content_Types].xml', 'xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'])).toBe(true);
    expect(isStreamableOrder(['xl/worksheets/sheet1.xml', 'xl/workbook.xml'])).toBe(false);
    expect(isStreamableOrder(['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml'])).toBe(false);
  });

  it('فایلی که ExcelJS نوشته (workbook.xml در انتها) خوانده می‌شود؛ متن، عدد، تاریخ، سلول خالی', async () => {
    const d = new Date(Date.UTC(2025, 5, 22));
    const rows = await collect(await build([
      ['شماره ترمینال', 'مبلغ', 'تاریخ'],
      ['۰۰۱۲۳', 1500, d],
      [null, null, null],
      ['00456', 'متن', null],
    ]));
    expect(rows.map((r) => r.rowNo)).toEqual([1, 2, 3, 4]);
    expect(rows[0]?.cells.slice(0, 3)).toEqual(['شماره ترمینال', 'مبلغ', 'تاریخ']);
    expect(rows[1]?.cells[0]).toBe('۰۰۱۲۳');
    expect(rows[1]?.cells[1]).toBe(1500);
    expect((rows[1]?.cells[2] as Date).toISOString().slice(0, 10)).toBe('2025-06-22');
    expect(rows[3]?.cells[0]).toBe('00456'); // صفر اول در سلول متنی حفظ می‌شود
  });

  it('readHeaders فقط هدر را می‌دهد و فایل را می‌بندد', async () => {
    const h = await readHeaders(Readable.from([await build([['الف', 'ب'], [1, 2]])]), 'xlsx', 1);
    expect(h).toEqual(['الف', 'ب']);
  });
});
