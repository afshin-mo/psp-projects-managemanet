import { addDaysIso } from './dates';

/** طبقه‌بندی ماهانه‌ی هر ترمینال: ۱ فعال، ۲ کم‌تراکنش، ۳ برگشتی (انصراف)، ۴ نوپا */
export type ActivityClass = 1 | 2 | 3 | 4;

export interface ClassifyInput {
  /** مبلغ خرید ماه (آخرین مانده‌ی تجمعی ماه) */
  amount: number;
  /** حداقل مبلغ ماهانه‌ی بسته‌ی بانکی ترمینال (۰ اگر قانونی نباشد) */
  threshold: number;
  installedAt: string | null;
  returnedAt: string | null;
  /** بازه‌ی ماه شمسی [periodStart, periodEnd) به میلادی */
  periodStart: string;
  periodEnd: string;
  /** نصب از این روز ماه شمسی به بعد «نوپا» است (پیش‌فرض ۲۰) */
  cutoffDay: number;
}

/**
 * قاعده‌ی طبقه‌بندی. منطق SQL در packages/core/src/aggregation/pipeline.ts همین را بازتولید می‌کند
 * و تست هم‌ارزی دارد:
 *  - برگشتی: انصراف تا پایان این ماه ثبت شده
 *  - نوپا: نصب در همین ماه و در روز cutoffDay یا بعد از آن
 *  - در غیر این صورت: فعال اگر amount ≥ threshold، وگرنه کم‌تراکنش
 */
export function classifyActivity(i: ClassifyInput): ActivityClass {
  if (i.returnedAt !== null && i.returnedAt < i.periodEnd) return 3;
  if (i.installedAt !== null && i.installedAt >= addDaysIso(i.periodStart, i.cutoffDay - 1) && i.installedAt < i.periodEnd) return 4;
  return i.amount >= i.threshold ? 1 : 2;
}

export interface ActivityRule { bankId: number; validFromPeriod: number; minMonthlyAmount: number }

/**
 * آستانه‌ی مؤثر برای یک بانک در یک دوره:
 * آخرین قانونِ مخصوص همان بانک (validFromPeriod ≤ دوره)؛ اگر نبود آخرین قانون پیش‌فرض دفتر (bankId=0)؛ اگر آن هم نبود ۰.
 */
export function pickThreshold(rules: readonly ActivityRule[], bankId: number, periodId: number): number {
  const latest = (id: number): ActivityRule | undefined =>
    rules
      .filter((r) => r.bankId === id && r.validFromPeriod <= periodId)
      .sort((a, b) => b.validFromPeriod - a.validFromPeriod)[0];
  const specific = bankId !== 0 ? latest(bankId) : undefined;
  return (specific ?? latest(0))?.minMonthlyAmount ?? 0;
}
