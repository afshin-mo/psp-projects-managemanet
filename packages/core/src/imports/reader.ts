import ExcelJS from 'exceljs';
import type { Readable } from 'node:stream';
import { csvRows } from './csv';
import { ensureStreamableXlsx } from './xlsx-source';

export type FileKind = 'xlsx' | 'csv';
export interface RawRow { rowNo: number; cells: unknown[] }

interface StreamRow { number: number; values: unknown }

/**
 * خواندن ردیف‌به‌ردیف از stream (فایل بزرگ هرگز کامل در حافظه نمی‌آید).
 *  - xlsx: exceljs WorkbookReader؛ فقط شیت اول. sharedStrings و styles باید cache شوند وگرنه متن و تاریخ خوانده نمی‌شود.
 *  - csv: تجزیه‌گر داخلی.
 * شماره‌ی ردیف همان شماره‌ی ردیف در اکسل است.
 */
export async function* readRows(stream: Readable, kind: FileKind): AsyncGenerator<RawRow> {
  try {
    if (kind === 'csv') {
      let n = 0;
      for await (const cells of csvRows(stream)) {
        n += 1;
        yield { rowNo: n, cells };
      }
      return;
    }
    const source = await ensureStreamableXlsx(stream);
    try {
      const reader = new ExcelJS.stream.xlsx.WorkbookReader(source.path, {
        worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', entries: 'emit',
      } as ConstructorParameters<typeof ExcelJS.stream.xlsx.WorkbookReader>[1]);
      for await (const sheet of reader as unknown as AsyncIterable<AsyncIterable<StreamRow>>) {
        for await (const row of sheet) {
          const values = Array.isArray(row.values) ? (Array.from(row.values as unknown[]).slice(1) as unknown[]) : [];
          yield { rowNo: row.number, cells: values };
        }
        return; // فقط اولین شیت
      }
    } finally {
      await source.cleanup();
    }
  } finally {
    stream.destroy();
  }
}

export function isBlankRow(cells: readonly unknown[]): boolean {
  return cells.every((c) => c === null || c === undefined || (typeof c === 'string' && c.trim() === ''));
}

/** هدر ردیف headerRow را می‌خواند و بلافاصله stream را می‌بندد */
export async function readHeaders(stream: Readable, kind: FileKind, headerRow: number): Promise<string[] | null> {
  for await (const row of readRows(stream, kind)) {
    if (row.rowNo === headerRow) return row.cells.map((c) => (c === null || c === undefined ? '' : String(c)).trim());
    if (row.rowNo > headerRow) return null;
  }
  return null;
}
