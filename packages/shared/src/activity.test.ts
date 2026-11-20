import { describe, expect, it } from 'vitest';
import { classifyActivity, pickThreshold, type ClassifyInput } from './activity';
import { addDaysIso } from './dates';

// تیر ۱۴۰۴: ۲۰۲۵-۰۶-۲۲ تا ۲۰۲۵-۰۷-۲۳
const base: ClassifyInput = {
  amount: 1000, threshold: 500, installedAt: '2024-01-01', returnedAt: null,
  periodStart: '2025-06-22', periodEnd: '2025-07-23', cutoffDay: 20,
};
const c = (over: Partial<ClassifyInput>) => classifyActivity({ ...base, ...over });

describe('classifyActivity', () => {
  it('فعال و کم‌تراکنش با آستانه (مساوی = فعال)', () => {
    expect(c({ amount: 500 })).toBe(1);
    expect(c({ amount: 499 })).toBe(2);
    expect(c({ amount: 0, threshold: 0 })).toBe(1);
  });

  it('نوپا: نصب روز ۱۹ عادی، ۲۰ و ۲۱ نوپا', () => {
    // روز n ماه = periodStart + (n-1)
    const day = (n: number) => addDaysIso('2025-06-22', n - 1);
    expect(c({ installedAt: day(19), amount: 0 })).toBe(2);
    expect(c({ installedAt: day(20), amount: 0 })).toBe(4);
    expect(c({ installedAt: day(21), amount: 0 })).toBe(4);
  });

  it('نصب در ماه قبل نوپا نیست و نصب بعد از پایان ماه هم نوپا نیست', () => {
    expect(c({ installedAt: '2025-06-21', amount: 0 })).toBe(2);
    expect(c({ installedAt: '2025-07-23', amount: 0 })).toBe(2); // (در عمل ردیفی برای این ماه ساخته نمی‌شود)
  });

  it('cutoffDay قابل تغییر است', () => {
    const inst = addDaysIso('2025-06-22', 24); // روز ۲۵ ماه
    expect(c({ installedAt: inst, cutoffDay: 20, amount: 0 })).toBe(4);
    expect(c({ installedAt: inst, cutoffDay: 26, amount: 0 })).toBe(2);
  });

  it('برگشتی اولویت دارد، حتی روی نوپا', () => {
    expect(c({ returnedAt: '2025-06-30' })).toBe(3);
    expect(c({ returnedAt: '2025-07-22' })).toBe(3);
    expect(c({ returnedAt: '2025-07-23' })).toBe(1); // بعد از پایان ماه: هنوز برگشتی نیست
    expect(c({ installedAt: '2025-07-20', returnedAt: '2025-07-21', amount: 0 })).toBe(3);
  });
});

describe('pickThreshold', () => {
  const rules = [
    { bankId: 0, validFromPeriod: 140401, minMonthlyAmount: 100 },
    { bankId: 0, validFromPeriod: 140404, minMonthlyAmount: 200 },
    { bankId: 7, validFromPeriod: 140402, minMonthlyAmount: 900 },
  ];
  it('قانون مخصوص بانک اولویت دارد و آخرین valid_from ≤ دوره انتخاب می‌شود', () => {
    expect(pickThreshold(rules, 7, 140403)).toBe(900);
    expect(pickThreshold(rules, 7, 140401)).toBe(100); // قانون بانک هنوز شروع نشده → پیش‌فرض
    expect(pickThreshold(rules, 0, 140404)).toBe(200);
    expect(pickThreshold(rules, 0, 140403)).toBe(100);
  });
  it('بانک بدون قانون از پیش‌فرض می‌گیرد؛ بدون هیچ قانونی ۰', () => {
    expect(pickThreshold(rules, 9, 140404)).toBe(200);
    expect(pickThreshold([], 9, 140404)).toBe(0);
    expect(pickThreshold(rules, 0, 140312)).toBe(0);
  });
});
