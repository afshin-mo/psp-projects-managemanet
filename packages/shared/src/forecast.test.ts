import { describe, expect, it } from 'vitest';
import { fillSeriesGaps, forecastSeries, mape } from './forecast';

const linear = (n: number, a = 100, b = 10): number[] => Array.from({ length: n }, (_, i) => a + b * i);

describe('forecastSeries', () => {
  it('سری کوتاه‌تر از ۳ نقطه: null', () => {
    expect(forecastSeries([1, 2], 3)).toBeNull();
    expect(forecastSeries([], 3)).toBeNull();
  });

  it('سری خیلی کوتاه: میانگین، با بازه‌ی اطمینان', () => {
    const r = forecastSeries([100, 100, 100], 2);
    expect(r?.model).toBe('mean');
    expect(r?.points).toHaveLength(2);
    expect(r?.points[0]?.value).toBe(100);
    expect(r?.mape).toBeNull();
  });

  it('روند خطی: Holt ادامه‌ی روند را پیش‌بینی می‌کند', () => {
    const y = linear(14); // 100,110,...,230
    const r = forecastSeries(y, 3);
    expect(r).not.toBeNull();
    expect(r?.model).toBe('holt');
    const next = r?.points[0]?.value ?? 0;
    expect(next).toBeGreaterThan(235);
    expect(next).toBeLessThan(250); // ≈ 240
    expect(r?.points[2]?.value).toBeGreaterThan(next);
  });

  it('فصل‌بندی ۱۲ماهه: Holt-Winters الگو را بازتولید می‌کند', () => {
    const season = [0, -100, -200, -50, 100, 300, 500, 300, 100, -50, -150, -250];
    const y = Array.from({ length: 36 }, (_, i) => 1000 + 5 * i + (season[i % 12] as number));
    const r = forecastSeries(y, 12);
    expect(r?.model).toBe('holt_winters');
    // ماه‌های ۳۶..۴۷؛ مقدار واقعی = 1000 + 5*t + season
    for (const p of r?.points ?? []) {
      const t = 35 + p.step;
      const truth = 1000 + 5 * t + (season[t % 12] as number);
      expect(Math.abs(p.value - truth)).toBeLessThan(80);
    }
    expect(r?.mape ?? 99).toBeLessThan(5);
  });

  it('بازه‌ی اطمینان: lower ≤ value ≤ upper و هرگز منفی نیست', () => {
    const y = [50, 5, 80, 2, 90, 1, 70, 3, 60, 0];
    const r = forecastSeries(y, 4);
    for (const p of r?.points ?? []) {
      expect(p.lower).toBeGreaterThanOrEqual(0);
      expect(p.lower).toBeLessThanOrEqual(p.value);
      expect(p.upper).toBeGreaterThanOrEqual(p.value);
    }
  });

  it('روند نزولی شدید: پیش‌بینی منفی نمی‌شود', () => {
    const r = forecastSeries(linear(10, 100, -12), 6);
    for (const p of r?.points ?? []) expect(p.value).toBeGreaterThanOrEqual(0);
  });

  it('سری ثابت صفر: خطا نمی‌دهد', () => {
    const r = forecastSeries(Array(12).fill(0), 3);
    expect(r?.points.every((p) => p.value === 0)).toBe(true);
  });
});

describe('mape', () => {
  it('نقاط صفر را نادیده می‌گیرد', () => {
    expect(mape([100, 0, 200], [110, 5, 180])).toBe(10);
    expect(mape([0, 0], [1, 1])).toBeNull();
  });
});

describe('fillSeriesGaps', () => {
  it('درون‌یابی خطی و حذف null های ابتدا و انتها', () => {
    expect(fillSeriesGaps([null, 10, null, null, 40, null])).toEqual([10, 20, 30, 40]);
  });
  it('همه null: null', () => expect(fillSeriesGaps([null, null])).toBeNull());
  it('بدون سوراخ: بدون تغییر', () => expect(fillSeriesGaps([1, 2, 3])).toEqual([1, 2, 3]));
});
