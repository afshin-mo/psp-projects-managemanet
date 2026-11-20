import { describe, expect, it } from 'vitest';
import { buildProgressCurve, curveShareAt, pctChange, projectMonth } from './analytics';
import { isValidPeriodId, shiftPeriod } from './periods/periods';
import { analyticsFilterSchema } from './schemas/analytics';

describe('pctChange', () => {
  it('درصد با دو رقم اعشار؛ مبنای صفر/نامشخص = null', () => {
    expect(pctChange(2700, 2500)).toBe(8);
    expect(pctChange(2436, 2700)).toBe(-9.78);
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange(0, 50)).toBe(-100);
  });
});

describe('shiftPeriod', () => {
  it('عبور از مرز سال', () => {
    expect(shiftPeriod(140402, -3)).toBe(140311);
    expect(shiftPeriod(140411, 3)).toBe(140502);
    expect(shiftPeriod(140405, -11)).toBe(140306);
    expect(isValidPeriodId(140413)).toBe(false);
    expect(isValidPeriodId(140401)).toBe(true);
  });
});

describe('منحنی پیشرفت ماه و projection', () => {
  const p = (daysInMonth: number, pts: Array<[number, number]>) => ({ daysInMonth, points: pts.map(([day, share]) => ({ day, share })) });

  it('بدون ماه معتبر کافی منحنی ساخته نمی‌شود', () => {
    expect(buildProgressCurve([p(31, [[31, 1]]), p(31, [[20, 0.5], [31, 1]])])).toBeNull();
  });

  it('میانه‌ی دو ماه، یکنوا و با سهم ۱ در روز ۳۱', () => {
    const c = buildProgressCurve([p(31, [[20, 0.5], [31, 1]]), p(31, [[19, 0.5], [31, 1]])]);
    expect(c).not.toBeNull();
    expect(c).toHaveLength(31);
    expect(c![30]!.share).toBe(1);
    expect(curveShareAt(c!, 14)).toBeCloseTo((0.5 * 14 / 20 + 0.5 * 14 / 19) / 2, 4);
    for (let i = 1; i < 31; i += 1) expect(c![i]!.share).toBeGreaterThanOrEqual(c![i - 1]!.share);
  });

  it('projection خطی و منحنی‌ای و ماه کامل', () => {
    const linear = projectMonth({ amount: 1100, txCount: 10, daysCovered: 14, daysInMonth: 31, curve: null });
    expect(linear).toMatchObject({ method: 'linear', amount: 2436, txCount: 22 });
    const curve = Array.from({ length: 31 }, (_, i) => ({ day: i + 1, share: i + 1 <= 14 ? (i + 1) / 28 : 0.5 + (i - 13) * 0.5 / 17 }));
    const viaCurve = projectMonth({ amount: 1100, txCount: 10, daysCovered: 14, daysInMonth: 31, curve });
    expect(viaCurve).toMatchObject({ method: 'curve', amount: 2200 });
    expect(projectMonth({ amount: 5, txCount: 1, daysCovered: 31, daysInMonth: 31, curve: null })).toMatchObject({ method: 'none', amount: 5 });
    // سهم خیلی کم (<۵٪) ← برگشت به خطی
    const tiny = Array.from({ length: 31 }, (_, i) => ({ day: i + 1, share: i < 5 ? 0.01 : (i + 1) / 31 }));
    expect(projectMonth({ amount: 10, txCount: 1, daysCovered: 3, daysInMonth: 31, curve: tiny }).method).toBe('linear');
  });
});

describe('فیلتر تحلیلی', () => {
  it('لیست جداشده با کاما و اعتبارسنجی', () => {
    expect(analyticsFilterSchema.parse({ unitId: '1,2', routeGroupId: '0,5', from: '140401' })).toMatchObject({
      unitId: [1, 2], routeGroupId: [0, 5], from: 140401,
    });
    expect(analyticsFilterSchema.parse({}).unitId).toBeUndefined();
    expect(() => analyticsFilterSchema.parse({ unitId: '0' })).toThrow();
    expect(() => analyticsFilterSchema.parse({ to: '140413' })).toThrow();
  });
});
