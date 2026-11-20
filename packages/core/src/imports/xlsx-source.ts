import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/*
 * خواننده‌ی stream در exceljs ورودی‌های zip را «به ترتیب فایل» پردازش می‌کند و انتظار دارد
 * workbook.xml، rels، sharedStrings و styles قبل از شیت‌ها بیایند. نویسنده‌ی خود exceljs (و بعضی ابزارهای
 * دیگر) این ترتیب را رعایت نمی‌کنند. این ماژول فایل را روی دیسک می‌گذارد، ترتیب را از central directory
 * بررسی می‌کند و در صورت نیاز zip را (باز هم stream، نه در حافظه) با ترتیب درست دوباره می‌بندد.
 * unzipper و archiver همان کتابخانه‌هایی‌اند که خود exceljs استفاده می‌کند.
 */
interface UzEntry { path: string; type: string; stream(): Readable }
interface UzDirectory { files: UzEntry[] }
interface ArchiveLike extends Readable {
  append(source: Readable, data: { name: string }): void;
  finalize(): Promise<void>;
}

const require_ = createRequire(import.meta.url);
const unzipper = require_('unzipper') as { Open: { file(p: string): Promise<UzDirectory> } };
const archiver = require_('archiver') as (format: 'zip', opts?: Record<string, unknown>) => ArchiveLike;

const REQUIRED = /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml)$/;

/** آیا همه‌ی پیش‌نیازهای خواندن، قبل از اولین شیت آمده‌اند؟ */
export function isStreamableOrder(names: readonly string[]): boolean {
  const firstSheet = names.findIndex((n) => n.startsWith('xl/worksheets/'));
  if (firstSheet < 0) return true;
  return names.every((n, i) => !REQUIRED.test(n) || i < firstSheet);
}

function rank(name: string): number {
  if (name === '[Content_Types].xml') return 0;
  if (name === '_rels/.rels') return 1;
  if (name === 'xl/workbook.xml') return 2;
  if (name === 'xl/_rels/workbook.xml.rels') return 3;
  if (name === 'xl/sharedStrings.xml') return 4;
  if (name === 'xl/styles.xml') return 5;
  if (name.startsWith('xl/worksheets/')) return 9;
  return 6;
}

export interface XlsxSource {
  path: string;
  cleanup(): Promise<void>;
}

const removeFile = (p: string): Promise<void> =>
  rm(p, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined); // ویندوز: دسته‌ی باز نباید خطا بدهد

export async function ensureStreamableXlsx(src: Readable): Promise<XlsxSource> {
  const base = path.join(os.tmpdir(), `pos-xlsx-${randomUUID()}`);
  const original = `${base}.xlsx`;
  await pipeline(src, createWriteStream(original));

  try {
    const dir = await unzipper.Open.file(original);
    const files = dir.files.filter((f) => f.type === 'File');
    if (isStreamableOrder(files.map((f) => f.path))) {
      return { path: original, cleanup: () => removeFile(original) };
    }
    const fixed = `${base}-ordered.xlsx`;
    const zip = archiver('zip', { zlib: { level: 1 } });
    const written = pipeline(zip, createWriteStream(fixed) as Writable);
    for (const f of [...files].sort((a, b) => rank(a.path) - rank(b.path))) {
      zip.append(f.stream(), { name: f.path });
    }
    await zip.finalize();
    await written;
    await removeFile(original);
    return { path: fixed, cleanup: () => removeFile(fixed) };
  } catch (err) {
    await removeFile(original);
    throw err;
  }
}
