import { gregorianToJalali, jalaliToGregorian, toIsoDate } from './jalali';

/** ردیف جدول periods. بازه [startDate, endDate) میلادی است (endDate شامل نیست). */
export interface Period {
  periodId: number; // jy*100+jm  →  140404 = تیر ۱۴۰۴
  year: number;
  month: number;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD، اولین روز ماه بعد
}

export function toPeriodId(jy: number, jm: number): number {
  return jy * 100 + jm;
}

export function fromPeriodId(periodId: number): { year: number; month: number } {
  const month = periodId % 100;
  const year = Math.trunc(periodId / 100);
  if (month < 1 || month > 12) throw new RangeError(`Invalid period id ${periodId}`);
  return { year, month };
}

export function nextPeriodId(periodId: number): number {
  const { year, month } = fromPeriodId(periodId);
  return month === 12 ? toPeriodId(year + 1, 1) : toPeriodId(year, month + 1);
}

export function prevPeriodId(periodId: number): number {
  const { year, month } = fromPeriodId(periodId);
  return month === 1 ? toPeriodId(year - 1, 12) : toPeriodId(year, month - 1);
}

/** سال قبل همان ماه (برای YoY) */
export function sameMonthLastYear(periodId: number): number {
  return periodId - 100;
}

export function buildPeriod(jy: number, jm: number): Period {
  const start = jalaliToGregorian(jy, jm, 1);
  const nextYear = jm === 12 ? jy + 1 : jy;
  const nextMonth = jm === 12 ? 1 : jm + 1;
  const end = jalaliToGregorian(nextYear, nextMonth, 1);
  return {
    periodId: toPeriodId(jy, jm),
    year: jy,
    month: jm,
    startDate: toIsoDate(start),
    endDate: toIsoDate(end),
  };
}

/** همه‌ی ماه‌های شمسی از سال fromYear تا toYear (هر دو شامل) */
export function generatePeriods(fromYear: number, toYear: number): Period[] {
  if (fromYear > toYear) throw new RangeError('fromYear must be <= toYear');
  const out: Period[] = [];
  for (let y = fromYear; y <= toYear; y += 1) {
    for (let m = 1; m <= 12; m += 1) out.push(buildPeriod(y, m));
  }
  return out;
}

/** دوره‌ای که تاریخ میلادی ISO در آن می‌افتد */
export function periodIdOfDate(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new RangeError(`Invalid date ${iso}`);
  const j = gregorianToJalali(y, m, d);
  return toPeriodId(j.jy, j.jm);
}

export function isValidPeriodId(id: number): boolean {
  if (!Number.isInteger(id)) return false;
  const m = id % 100;
  const y = Math.trunc(id / 100);
  return m >= 1 && m <= 12 && y >= 1300 && y <= 1700;
}

/** جابه‌جایی چند ماه شمسی (delta می‌تواند منفی باشد) */
export function shiftPeriod(periodId: number, delta: number): number {
  let id = periodId;
  for (let i = 0; i < Math.abs(delta); i += 1) id = delta < 0 ? prevPeriodId(id) : nextPeriodId(id);
  return id;
}
