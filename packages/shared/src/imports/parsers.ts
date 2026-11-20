import { isValidIsoDate } from '../dates';
import { jalaliToGregorian, toIsoDate } from '../periods/jalali';
import { toEnglishDigits } from '../normalize/text';

/** تبدیل مقدار سلول (انواع exceljs) به متن */
export function cellToText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { richText?: Array<{ text?: unknown }>; result?: unknown; text?: unknown; error?: unknown };
    if (o.error !== undefined) return '';
    if (Array.isArray(o.richText)) return o.richText.map((r) => (typeof r.text === 'string' ? r.text : '')).join('').trim();
    if (o.result !== undefined) return cellToText(o.result);
    if (o.text !== undefined) return cellToText(o.text);
  }
  return '';
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: 'EMPTY' | 'BAD_NUMBER' | 'BAD_DATE' };

function parseNonNegativeInt(v: unknown, max: number): ParseResult<number> {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v) || v > max) return { ok: false, code: 'BAD_NUMBER' };
    return { ok: true, value: v };
  }
  const t = toEnglishDigits(cellToText(v)).replace(/[\s,\u066C\u060C]/g, '').replace(/\.0+$/, '');
  if (t === '') return { ok: false, code: 'EMPTY' };
  if (!/^\d+$/.test(t)) return { ok: false, code: 'BAD_NUMBER' };
  const n = Number(t);
  return Number.isSafeInteger(n) && n <= max ? { ok: true, value: n } : { ok: false, code: 'BAD_NUMBER' };
}

/** مبلغ ریال: عدد صحیح ≥ ۰؛ جداکننده‌ی هزارگان (, ٬ ،) و ارقام فارسی/عربی پذیرفته می‌شود */
export const parseAmount = (v: unknown): ParseResult<number> => parseNonNegativeInt(v, Number.MAX_SAFE_INTEGER);
/** تعداد تراکنش: عدد صحیح ≥ ۰ و در محدوده‌ی int32 */
export const parseCount = (v: unknown): ParseResult<number> => parseNonNegativeInt(v, 2_147_483_647);

export type CalendarHint = 'auto' | 'jalali' | 'gregorian';

/**
 * تاریخ شمسی یا میلادی → ISO میلادی. سال‌اول‌بودن الزامی است (۱۴۰۴/۰۵/۱۲ ، 2025-07-03 ، ۱۴۰۴۰۵۱۲).
 * در حالت auto، سال کمتر از ۱۷۰۰ شمسی فرض می‌شود.
 */
export function parseDateCell(v: unknown, calendar: CalendarHint = 'auto'): ParseResult<string> {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return { ok: false, code: 'BAD_DATE' };
    return { ok: true, value: v.toISOString().slice(0, 10) };
  }
  const raw = toEnglishDigits(cellToText(v)).replace(/\s+/g, '');
  if (raw === '') return { ok: false, code: 'EMPTY' };

  let y: number, m: number, d: number;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  const parts = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(raw);
  const hit = compact ?? parts;
  if (!hit) return { ok: false, code: 'BAD_DATE' };
  y = Number(hit[1]); m = Number(hit[2]); d = Number(hit[3]);

  const isJalali = calendar === 'jalali' || (calendar === 'auto' && y < 1700);
  try {
    if (isJalali) return { ok: true, value: toIsoDate(jalaliToGregorian(y, m, d)) };
  } catch {
    return { ok: false, code: 'BAD_DATE' };
  }
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidIsoDate(iso) ? { ok: true, value: iso } : { ok: false, code: 'BAD_DATE' };
}
