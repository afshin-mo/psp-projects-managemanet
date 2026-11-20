import ExcelJS from 'exceljs';
import { PassThrough, type Readable } from 'node:stream';
import { IMPORT_REGISTRY, type ImportType } from '@pos/shared';
import type { Queryable } from '../db/types';
import { listImportErrors } from '../repos/imports';
import type { TenantContext } from '../tenant/scope';

/** قالب پیش‌فرض (وقتی ستاد مرکزی قالب رسمی بارگذاری نکرده): ستون شماره ترمینال به‌صورت «متن» تا صفر اول حفظ شود */
export async function buildDefaultTemplate(type: ImportType): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Template', { views: [{ rightToLeft: true }] });
  const fields = IMPORT_REGISTRY[type].fields;
  ws.addRow(fields.map((f) => f.label));
  fields.forEach((f, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(16, f.label.length + 4);
    if (f.kind === 'terminal_no' || f.kind === 'phone') col.numFmt = '@';
  });
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** گزارش خطا به‌صورت stream (xlsx) بدون لود کامل در حافظه. دسترسی را قبلاً کنترل کنید. */
export function createErrorReportStream(ctx: TenantContext, db: Queryable, batchId: number): Readable {
  const out = new PassThrough();
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: false, useSharedStrings: false });
  const ws = wb.addWorksheet('Errors', { views: [{ rightToLeft: true }] });
  void (async () => {
    try {
      ws.addRow(['ردیف', 'ستون', 'کد خطا', 'توضیح']).commit();
      let cursor: string | undefined;
      do {
        const page = await listImportErrors(ctx, db, batchId, { cursor, limit: 5000 });
        for (const r of page.items) ws.addRow([r.rowNo, r.columnName ?? '', r.code, r.message]).commit();
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      ws.commit();
      await wb.commit();
    } catch (err) {
      out.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  return out;
}
