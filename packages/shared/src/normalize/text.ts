const PERSIAN_DIGIT_0 = 0x06f0;
const ARABIC_DIGIT_0 = 0x0660;

/** تبدیل ارقام فارسی (۰-۹) و عربی (٠-٩) به انگلیسی */
export function toEnglishDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= PERSIAN_DIGIT_0 && c <= PERSIAN_DIGIT_0 + 9) out += String(c - PERSIAN_DIGIT_0);
    else if (c >= ARABIC_DIGIT_0 && c <= ARABIC_DIGIT_0 + 9) out += String(c - ARABIC_DIGIT_0);
    else out += ch;
  }
  return out;
}

/**
 * نرمال‌سازی متن فارسی برای جستجو:
 * ارقام انگلیسی، «ي ى»→«ی»، «ك»→«ک»، حذف اعراب و کشیده، نیم‌فاصله→فاصله، فشرده‌کردن فاصله‌ها، حروف کوچک.
 */
export function normalizeSearchText(input: string): string {
  return toEnglishDigits(input)
    .replace(/[\u064A\u0649]/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/[\u0629]/g, '\u0647')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u200C\u200D\u200E\u200F\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** شماره ترمینال: ارقام انگلیسی، حذف هر فاصله/نیم‌فاصله. صفر اول حفظ می‌شود (همیشه رشته). */
export function normalizeTerminalNo(input: string): string {
  return toEnglishDigits(input).replace(/[\s\u200C\u200D\u200E\u200F\u00A0]/g, '');
}

/** متن جستجوی ذخیره‌شده‌ی یک ترمینال (ستون terminals.search_norm) */
export function buildTerminalSearchNorm(parts: {
  terminalNo: string;
  shopName?: string | null | undefined;
  ownerName?: string | null | undefined;
}): string {
  return normalizeSearchText([parts.terminalNo, parts.shopName, parts.ownerName].filter(Boolean).join(' '));
}

/** escape کاراکترهای ویژه‌ی LIKE (\ % _) */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}
