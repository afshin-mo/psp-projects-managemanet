import type { Readable } from 'node:stream';
import { normalizeSearchText, parseProjectTerminalStatus, type ProjectTerminalStatus } from '@pos/shared';
import { isBlankRow, readRows, type FileKind } from '../imports/reader';
import type { ProjectTerminalRowInput } from '../repos/projects';

const TERMINAL_HEADERS = ['شماره ترمینال', 'ترمینال', 'شماره پایانه', 'terminal_no', 'terminalno', 'terminal no', 'terminal', 'terminal number'];
const STATUS_HEADERS = ['وضعیت', 'وضعیت پروژه', 'status'];
const NOTE_HEADERS = ['توضیح', 'توضیحات', 'یادداشت', 'note', 'notes', 'description'];

export interface ParsedProjectFile {
  rows: ProjectTerminalRowInput[];
  invalid: Array<{ rowNo: number; message: string }>;
  totalRows: number;
}

/** مقدار سلول (متن، عدد، rich text، فرمول) به رشته */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return '';
  if (typeof v === 'object') {
    const o = v as { text?: unknown; result?: unknown; richText?: Array<{ text?: unknown }> };
    if (Array.isArray(o.richText)) return o.richText.map((r) => String(r.text ?? '')).join('').trim();
    if (o.text !== undefined) return cellText(o.text);
    if (o.result !== undefined) return cellText(o.result);
  }
  return '';
}

const findCol = (headers: readonly string[], names: readonly string[]): number => {
  const wanted = new Set(names.map((n) => normalizeSearchText(n)));
  return headers.findIndex((h) => wanted.has(normalizeSearchText(h)));
};

/**
 * خواندن فایل اکسل/CSV ترمینال‌های پروژه. ردیف اول هدر است؛ ستون «شماره ترمینال» الزامی و «وضعیت» و «توضیح» اختیاری‌اند.
 * خطای هدر یا بیش از maxRows ردیف، استثنا می‌دهد؛ ردیف‌های معیوب در invalid گزارش می‌شوند.
 */
export async function parseProjectTerminalFile(stream: Readable, kind: FileKind, maxRows = 50_000): Promise<ParsedProjectFile> {
  let headers: string[] | null = null;
  let cTerminal = -1;
  let cStatus = -1;
  let cNote = -1;
  const rows: ProjectTerminalRowInput[] = [];
  const invalid: ParsedProjectFile['invalid'] = [];
  let total = 0;

  for await (const row of readRows(stream, kind)) {
    if (!headers) {
      if (isBlankRow(row.cells)) continue;
      headers = row.cells.map(cellText);
      cTerminal = findCol(headers, TERMINAL_HEADERS);
      if (cTerminal < 0) throw new Error('ستون «شماره ترمینال» در ردیف اول فایل پیدا نشد');
      cStatus = findCol(headers, STATUS_HEADERS);
      cNote = findCol(headers, NOTE_HEADERS);
      continue;
    }
    if (isBlankRow(row.cells)) continue;
    total += 1;
    if (total > maxRows) throw new Error(`تعداد ردیف‌ها از سقف ${maxRows} بیشتر است`);

    const terminalNo = cellText(row.cells[cTerminal]);
    if (!terminalNo) {
      invalid.push({ rowNo: row.rowNo, message: 'شماره ترمینال خالی است' });
      continue;
    }
    let status: ProjectTerminalStatus | undefined;
    if (cStatus >= 0) {
      const raw = cellText(row.cells[cStatus]);
      if (raw) {
        const parsed = parseProjectTerminalStatus(raw);
        if (!parsed) {
          invalid.push({ rowNo: row.rowNo, message: `وضعیت «${raw}» شناخته‌شده نیست` });
          continue;
        }
        status = parsed;
      }
    }
    const note = cNote >= 0 ? cellText(row.cells[cNote]) : '';
    rows.push({ terminalNo, ...(status ? { status } : {}), ...(note ? { note } : {}) });
  }
  if (!headers) throw new Error('فایل خالی است');
  return { rows, invalid, totalRows: total };
}
