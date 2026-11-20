import { normalizeSearchText } from '../normalize/text';

export const IMPORT_TYPES = ['terminals', 'transactions_cumulative'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export type FieldKind = 'terminal_no' | 'text' | 'phone' | 'money' | 'count' | 'date';

export interface FieldDef {
  key: string;
  label: string;
  required: boolean;
  kind: FieldKind;
  /** عنوان‌های ممکن ستون در فایل‌ها (قبل از نرمال‌سازی) */
  synonyms: string[];
}

export interface ImportTypeDef {
  title: string;
  fields: FieldDef[];
}

const f = (key: string, label: string, required: boolean, kind: FieldKind, synonyms: string[]): FieldDef => ({
  key, label, required, kind, synonyms,
});

/** رجیستری فیلدهای کانونی. قالب فایل مرکزی عوض می‌شود، ولی این کلیدها ثابت می‌مانند. */
export const IMPORT_REGISTRY: Record<ImportType, ImportTypeDef> = {
  terminals: {
    title: 'ترمینال‌ها (ایجاد و ویرایش)',
    fields: [
      f('terminal_no', 'شماره ترمینال', true, 'terminal_no',
        ['شماره ترمینال', 'شماره پایانه', 'ترمینال', 'پایانه', 'شماره پوز', 'terminal no', 'terminal_no', 'terminal']),
      f('shop_name', 'نام فروشگاه', false, 'text',
        ['نام فروشگاه', 'نام پذیرنده', 'فروشگاه', 'پذیرنده', 'نام مغازه', 'shop name', 'shop']),
      f('owner_name', 'نام مالک', false, 'text',
        ['نام مالک', 'مالک', 'نام صاحب', 'صاحب', 'نام و نام خانوادگی', 'owner name', 'owner']),
      f('phone', 'تلفن', false, 'phone',
        ['تلفن', 'شماره تلفن', 'موبایل', 'شماره همراه', 'همراه', 'phone', 'mobile']),
      f('address', 'آدرس', false, 'text', ['آدرس', 'نشانی', 'address']),
      f('supporter_name', 'پشتیبان', false, 'text', ['پشتیبان', 'نام پشتیبان', 'supporter']),
      f('route_name', 'مسیر', false, 'text', ['مسیر', 'گروه مسیر', 'نام مسیر', 'route']),
      f('bank_name', 'بانک', false, 'text', ['بانک', 'نام بانک', 'بسته بانکی', 'بسته', 'bank']),
      f('installed_at', 'تاریخ نصب', false, 'date', ['تاریخ نصب', 'نصب', 'install date', 'installed']),
      f('returned_at', 'تاریخ انصراف', false, 'date',
        ['تاریخ انصراف', 'انصراف', 'تاریخ برگشت', 'برگشت', 'returned']),
    ],
  },
  transactions_cumulative: {
    title: 'تراکنش (مانده‌ی تجمعی از ابتدای ماه شمسی)',
    fields: [
      f('terminal_no', 'شماره ترمینال', true, 'terminal_no',
        ['شماره ترمینال', 'شماره پایانه', 'ترمینال', 'پایانه', 'شماره پوز', 'terminal no', 'terminal_no', 'terminal']),
      f('amount', 'مبلغ خرید (ریال)', true, 'money',
        ['مبلغ', 'مبلغ خرید', 'جمع مبلغ', 'جمع خرید', 'مبلغ تراکنش', 'مبلغ ریال', 'amount']),
      f('tx_count', 'تعداد تراکنش', true, 'count',
        ['تعداد', 'تعداد تراکنش', 'تعداد خرید', 'جمع تعداد', 'tx count', 'count']),
      f('as_of_date', 'تاریخ فایل', false, 'date', ['تاریخ', 'تاریخ فایل', 'تا تاریخ', 'as of date', 'date']),
      // --- مبلغ کل (خرید + شارژ + قبض + ...)؛ اختیاری. مبلغ خرید همان «amount» است و مبنای فعال/فاقد درآمد.
      f('total_amount', 'مبلغ کل (ریال)', false, 'money',
        ['مبلغ کل', 'جمع کل', 'جمع کل مبلغ', 'کل مبلغ', 'مبلغ کل تراکنش', 'مبلغ کل تراکنش ها', 'جمع مبلغ کل', 'total amount', 'total']),
      f('total_tx_count', 'تعداد کل تراکنش', false, 'count',
        ['تعداد کل', 'تعداد کل تراکنش', 'تعداد کل تراکنش ها', 'جمع تعداد کل', 'total count', 'total tx count']),
      // --- اطلاعات ترمینال در فایل تراکنش (اختیاری؛ در صورت مغایرت با دیتابیس، دیتابیس به‌روز می‌شود)
      f('shop_name', 'نام فروشگاه', false, 'text',
        ['نام فروشگاه', 'نام پذیرنده', 'فروشگاه', 'پذیرنده', 'نام مغازه', 'shop name', 'shop']),
      f('owner_name', 'نام مالک', false, 'text',
        ['نام مالک', 'مالک', 'نام صاحب', 'صاحب', 'نام و نام خانوادگی', 'owner name', 'owner']),
      f('phone', 'شماره موبایل', false, 'phone',
        ['شماره موبایل', 'موبایل', 'تلفن همراه', 'شماره همراه', 'همراه', 'تلفن', 'شماره تلفن', 'phone', 'mobile']),
      f('address', 'آدرس', false, 'text', ['آدرس', 'نشانی', 'address']),
      f('bank_name', 'نام بانک', false, 'text', ['نام بانک', 'بانک', 'بسته بانکی', 'بسته', 'bank']),
    ],
  },
};

export function isImportType(v: string): v is ImportType {
  return (IMPORT_TYPES as readonly string[]).includes(v);
}

/** نرمال‌سازی عنوان ستون برای مقایسه: ی/ک، ارقام، حروف کوچک، حذف فاصله و علائم */
export function normalizeHeader(s: string): string {
  return normalizeSearchText(s).replace(/[\s_\-().:/\\،,؛;]+/g, '');
}

/** متن پایه‌ی اثرانگشت (هش در core محاسبه می‌شود): عنوان‌های نرمال‌شده‌ی غیرخالی به ترتیب ستون */
export function headerFingerprintSource(headers: readonly string[]): string {
  return headers.map(normalizeHeader).filter((h) => h !== '').join('|');
}

export type ColumnMap = Record<string, string>; // کلید کانونی ← عنوان ستون در فایل

export interface MappingSuggestion {
  columnMap: ColumnMap;
  missingRequired: string[];
  unmatchedHeaders: string[];
}

/** پیشنهاد خودکار نگاشت از روی مترادف‌ها. هر ستون فایل حداکثر برای یک فیلد استفاده می‌شود. */
export function suggestColumnMap(type: ImportType, headers: readonly string[]): MappingSuggestion {
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const columnMap: ColumnMap = {};
  const missingRequired: string[] = [];

  for (const field of IMPORT_REGISTRY[type].fields) {
    const candidates = [field.label, ...field.synonyms].map(normalizeHeader);
    let found = -1;
    for (const c of candidates) {
      found = normalized.findIndex((h, i) => h === c && !used.has(i));
      if (found >= 0) break;
    }
    if (found >= 0) {
      used.add(found);
      columnMap[field.key] = headers[found] ?? '';
    } else if (field.required) {
      missingRequired.push(field.key);
    }
  }
  const unmatchedHeaders = headers.filter((h, i) => !used.has(i) && normalizeHeader(h) !== '');
  return { columnMap, missingRequired, unmatchedHeaders };
}

export interface ResolvedColumns {
  /** کلید کانونی ← اندیس ستون (از صفر) */
  indexes: Record<string, number>;
  /** فیلدهای الزامی که عنوانشان در فایل پیدا نشد */
  missingRequired: string[];
}

/** نگاشت ذخیره‌شده (کلید ← عنوان) را روی هدر واقعی فایل بنشاند */
export function resolveColumnMap(type: ImportType, columnMap: ColumnMap, headers: readonly string[]): ResolvedColumns {
  const normalized = headers.map(normalizeHeader);
  const indexes: Record<string, number> = {};
  const missingRequired: string[] = [];
  for (const field of IMPORT_REGISTRY[type].fields) {
    const title = columnMap[field.key];
    const idx = title === undefined ? -1 : normalized.indexOf(normalizeHeader(title));
    if (idx >= 0) indexes[field.key] = idx;
    else if (field.required) missingRequired.push(field.key);
  }
  return { indexes, missingRequired };
}
