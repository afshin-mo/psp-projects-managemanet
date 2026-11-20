import { describe, expect, it } from 'vitest';
import {
  gregorianToJalali,
  isJalaliLeapYear,
  jalaliMonthLength,
  jalaliToGregorian,
  toIsoDate,
} from './jalali';
import { buildPeriod, generatePeriods, nextPeriodId, periodIdOfDate, prevPeriodId } from './periods';

describe('jalali ⇄ gregorian', () => {
  it('تاریخ‌های مرجع', () => {
    expect(toIsoDate(jalaliToGregorian(1404, 1, 1))).toBe('2025-03-21');
    expect(toIsoDate(jalaliToGregorian(1403, 1, 1))).toBe('2024-03-20');
    expect(toIsoDate(jalaliToGregorian(1403, 12, 30))).toBe('2025-03-20'); // ۱۴۰۳ کبیسه است
    expect(gregorianToJalali(2025, 3, 21)).toEqual({ jy: 1404, jm: 1, jd: 1 });
  });

  it('سال کبیسه و طول ماه‌ها', () => {
    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(isJalaliLeapYear(1404)).toBe(false);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliMonthLength(1404, 6)).toBe(31);
    expect(jalaliMonthLength(1404, 7)).toBe(30);
  });

  it('تاریخ نامعتبر خطا می‌دهد', () => {
    expect(() => jalaliToGregorian(1404, 12, 30)).toThrow(RangeError);
    expect(() => jalaliToGregorian(1404, 13, 1)).toThrow(RangeError);
  });

  it('رفت‌وبرگشت برای هر روز ۱۳۵۰ تا ۱۴۵۰ پایدار است و با ICU برابر است', () => {
    const fmt = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
      timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
    });
    const start = Date.UTC(1971, 0, 1);
    const end = Date.UTC(2072, 0, 1);
    for (let t = start; t < end; t += 86_400_000) {
      const d = new Date(t);
      const gy = d.getUTCFullYear(), gm = d.getUTCMonth() + 1, gd = d.getUTCDate();
      const j = gregorianToJalali(gy, gm, gd);
      const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
      expect([j.jy, j.jm, j.jd]).toEqual([Number(parts.year), Number(parts.month), Number(parts.day)]);
      expect(jalaliToGregorian(j.jy, j.jm, j.jd)).toEqual({ gy, gm, gd });
    }
  });
});

describe('periods', () => {
  it('شناسه‌ی دوره', () => {
    const p = buildPeriod(1404, 4);
    expect(p.periodId).toBe(140404);
    expect(p.startDate).toBe('2025-06-22');
    expect(p.endDate).toBe('2025-07-23');
    expect(nextPeriodId(140412)).toBe(140501);
    expect(prevPeriodId(140501)).toBe(140412);
  });

  it('دوره‌ها پیوسته‌اند و همپوشانی ندارند', () => {
    const ps = generatePeriods(1398, 1420);
    expect(ps).toHaveLength(23 * 12);
    for (let i = 1; i < ps.length; i += 1) {
      expect(ps[i]!.startDate).toBe(ps[i - 1]!.endDate);
      expect(ps[i]!.startDate > ps[i]!.endDate).toBe(false);
    }
  });

  it('periodIdOfDate مرز ماه را درست تشخیص می‌دهد', () => {
    expect(periodIdOfDate('2025-06-21')).toBe(140403);
    expect(periodIdOfDate('2025-06-22')).toBe(140404);
    expect(periodIdOfDate('2025-07-22')).toBe(140404);
    expect(periodIdOfDate('2025-07-23')).toBe(140405);
  });
});
