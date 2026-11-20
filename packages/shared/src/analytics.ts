/** درصد تغییر با دو رقم اعشار؛ اگر مبنا صفر/نامشخص باشد null (نه بی‌نهایت) */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 10_000) / 100;
}

export interface CurvePoint { day: number; share: number }

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** مقدار منحنی‌ی تکه‌خطی period از (۰،۰) تا نقاط فایل تا (روزهای ماه، ۱) در روز k */
function pieceLinear(points: readonly CurvePoint[], daysInMonth: number, k: number): number {
  const pts: CurvePoint[] = [{ day: 0, share: 0 }, ...[...points].sort((a, b) => a.day - b.day)];
  const last = pts[pts.length - 1] as CurvePoint;
  if (last.day < daysInMonth) pts.push({ day: daysInMonth, share: 1 });
  const x = Math.min(k, daysInMonth);
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1] as CurvePoint;
    const b = pts[i] as CurvePoint;
    if (x <= b.day) return b.day === a.day ? b.share : a.share + ((b.share - a.share) * (x - a.day)) / (b.day - a.day);
  }
  return 1;
}

/**
 * منحنی «سهم تجمعی مبلغ تا روز k ماه» (k=1..31) به‌صورت میانه‌ی چند ماه کامل اخیر.
 * هر ماه با نقاط (روز، سهم از مجموع پایان ماه) توصیف می‌شود؛ ماه‌هایی که کمتر از ۲ نقطه دارند کنار گذاشته می‌شوند.
 * اگر کمتر از minPeriods ماه معتبر باشد null (فراخواننده به projection خطی برمی‌گردد).
 */
export function buildProgressCurve(
  periods: ReadonlyArray<{ daysInMonth: number; points: readonly CurvePoint[] }>, minPeriods = 2,
): CurvePoint[] | null {
  const usable = periods.filter((p) => p.points.length >= 2);
  if (usable.length < minPeriods) return null;
  const out: CurvePoint[] = [];
  let running = 0;
  for (let k = 1; k <= 31; k += 1) {
    const v = median(usable.map((p) => pieceLinear(p.points, p.daysInMonth, k)));
    running = Math.max(running, v); // یکنوا
    out.push({ day: k, share: Math.min(1, running) });
  }
  out[30] = { day: 31, share: 1 };
  return out;
}

export function curveShareAt(curve: readonly CurvePoint[], day: number): number {
  const d = Math.min(31, Math.max(1, Math.round(day)));
  return curve.find((p) => p.day === d)?.share ?? 1;
}

export type ProjectionMethod = 'curve' | 'linear' | 'none';

export interface ProjectionResult { method: ProjectionMethod; factor: number; amount: number; txCount: number }

/**
 * پیش‌بینی پایان ماه از روی مقدار تا روز daysCovered.
 *  - اگر منحنی تاریخی موجود و سهم تا آن روز ≥ ۵٪ باشد: amount / share
 *  - وگرنه خطی: amount × (روزهای ماه / روز پوشش‌داده‌شده)
 *  - ماه کامل (یا بدون پوشش): none
 */
export function projectMonth(i: {
  amount: number; txCount: number; daysCovered: number; daysInMonth: number; curve: readonly CurvePoint[] | null;
}): ProjectionResult {
  if (i.daysCovered <= 0 || i.daysCovered >= i.daysInMonth) {
    return { method: 'none', factor: 1, amount: i.amount, txCount: i.txCount };
  }
  let factor = i.daysInMonth / i.daysCovered;
  let method: ProjectionMethod = 'linear';
  if (i.curve) {
    const share = curveShareAt(i.curve, i.daysCovered);
    if (share >= 0.05) {
      factor = 1 / share;
      method = 'curve';
    }
  }
  factor = Math.min(31, Math.max(1, factor));
  return { method, factor, amount: Math.round(i.amount * factor), txCount: Math.round(i.txCount * factor) };
}
