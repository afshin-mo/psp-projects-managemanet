import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';

/** تجزیه‌گر CSV مطابق RFC 4180 (نقل‌قول، "" برای نقل‌قول، خط جدید داخل نقل‌قول، CRLF) */
export class CsvParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  private afterQuote = false;
  private pendingCr = false;

  constructor(private readonly delimiter: string) {}

  push(text: string, out: string[][]): void {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (this.pendingCr) {
        this.pendingCr = false;
        if (ch === '\n') continue;
      }
      if (this.inQuotes) {
        if (ch === '"') {
          this.inQuotes = false;
          this.afterQuote = true;
        } else this.field += ch;
        continue;
      }
      if (this.afterQuote) {
        this.afterQuote = false;
        if (ch === '"') { // "" داخل فیلد = یک نقل‌قول
          this.field += '"';
          this.inQuotes = true;
          continue;
        }
      }
      if (ch === '"' && this.field === '') this.inQuotes = true;
      else if (ch === this.delimiter) {
        this.row.push(this.field);
        this.field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r') this.pendingCr = true;
        this.row.push(this.field);
        out.push(this.row);
        this.row = [];
        this.field = '';
      } else this.field += ch;
    }
  }

  finish(out: string[][]): void {
    if (this.field !== '' || this.row.length > 0 || this.inQuotes) {
      this.row.push(this.field);
      out.push(this.row);
    }
    this.field = '';
    this.row = [];
  }
}

export function detectDelimiter(head: string): string {
  const line = head.split(/\r?\n/, 1)[0] ?? '';
  const counts: Array<[string, number]> = [',', ';', '\t'].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0] && counts[0][1] > 0 ? counts[0][0] : ',';
}

/** خواندن stream به‌صورت ردیف‌به‌ردیف (UTF-8، با حذف BOM، تشخیص جداکننده‌ی , ; TAB) */
export async function* csvRows(stream: Readable): AsyncGenerator<string[]> {
  const decoder = new StringDecoder('utf8');
  const out: string[][] = [];
  let parser: CsvParser | undefined;
  let head = '';
  let started = false;

  for await (const chunk of stream) {
    let text = decoder.write(chunk as Buffer);
    if (!started && text.length > 0) {
      started = true;
      text = text.replace(/^\uFEFF/, '');
    }
    if (!parser) {
      head += text;
      if (!head.includes('\n') && head.length < 8192) continue;
      parser = new CsvParser(detectDelimiter(head));
      text = head;
      head = '';
    }
    parser.push(text, out);
    for (const r of out) yield r;
    out.length = 0;
  }
  if (!parser) parser = new CsvParser(detectDelimiter(head));
  parser.push(head + decoder.end(), out);
  parser.finish(out);
  for (const r of out) yield r;
}

/** یک ردیف خروجی COPY ... FORMAT csv. null/undefined/رشته‌ی خالی = NULL (بدون نقل‌قول). */
export function csvLine(values: readonly unknown[]): string {
  const cells = values.map((v) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
    if (typeof v === 'boolean') return v ? 't' : 'f';
    return `"${String(v).replace(/\u0000/g, '').replace(/"/g, '""')}"`;
  });
  return `${cells.join(',')}\n`;
}
