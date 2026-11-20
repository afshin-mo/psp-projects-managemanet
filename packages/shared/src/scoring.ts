/**
 * امتیازدهی پشتیبان (۰ تا ۱۰۰). منطق خالص و بدون وابستگی؛ SQL فقط داده‌ی خام می‌دهد.
 *
 * مؤلفه‌ها:
 *  - amount   رشد مبلغ خرید نسبت به ماه قبل
 *  - count    رشد تعداد تراکنش نسبت به ماه قبل
 *  - devices  رشد تعداد دستگاه فعال (نصف امتیاز) + سهم دستگاه‌های فعال از دستگاه‌های قابل‌سنجش (نصف دیگر)
 *  - projects عملکرد در همه‌ی پروژه‌های هم‌پوشان با آن ماه نسبت به خط برنامه‌ی هر پروژه
 *
 * نگاشت رشد به امتیاز خطی است: رشد ۰٪ = ۵۰ ، +۲۵٪ یا بیشتر = ۱۰۰ ، −۲۵٪ یا کمتر = ۰.
 * مؤلفه‌ای که داده ندارد (مثلاً ماه قبل صفر بوده یا پروژه‌ای نیست) null است و وزنش بین بقیه پخش می‌شود.
 */

export const SCORE_COMPONENTS = ['amount', 'count', 'devices', 'projects'] as const;
export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];
export type ScoreWeights = Record<ScoreComponent, number>;

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { amount: 30, count: 15, devices: 20, projects: 35 };

export const SCORE_COMPONENT_FA: Record<ScoreComponent, string> = {
  amount: 'رشد مبلغ خرید',
  count: 'رشد تعداد تراکنش',
  devices: 'رشد و سلامت دستگاه‌ها',
  projects: 'عملکرد در پروژه‌ها',
};

/** شیب نگاشت رشد به امتیاز: هر ۱٪ رشد = ۲ امتیاز */
export const GROWTH_SLOPE = 2;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** درصد رشد؛ پایه‌ی صفر/نامعلوم = null */
export function growthPct(cur: number, prev: number | null | undefined): number | null {
  if (prev === null || prev === undefined || prev <= 0) return null;
  return round1(((cur - prev) / prev) * 100);
}

/** رشد (٪) → امتیاز ۰..۱۰۰ */
export function growthToScore(pct: number | null): number | null {
  if (pct === null) return null;
  return round1(clamp(50 + GROWTH_SLOPE * pct, 0, 100));
}

export interface ProjectScoreItem {
  total: number;
  /** انجام‌شده + ناموفق (بسته‌شده) تا پایان ماه */
  resolved: number;
  /** پیشرفت مورد انتظار (٪) بر پایه‌ی خط برنامه‌ی پروژه تا پایان ماه */
  expectedPct: number;
}

/** امتیاز یک پروژه: نسبت پیشرفت واقعی به مورد انتظار (حداکثر ۱۰۰)؛ اگر هنوز چیزی انتظار نمی‌رفت = ۱۰۰ */
export function projectItemScore(item: ProjectScoreItem): number {
  if (item.total <= 0) return 100;
  const actualPct = (item.resolved / item.total) * 100;
  if (item.expectedPct <= 0) return 100;
  return round1(clamp((actualPct / item.expectedPct) * 100, 0, 100));
}

/** میانگین وزنی (وزن = تعداد ترمینال) امتیاز پروژه‌ها؛ بدون پروژه = null */
export function projectsScore(items: readonly ProjectScoreItem[]): number | null {
  const used = items.filter((i) => i.total > 0);
  if (used.length === 0) return null;
  const totalW = used.reduce((a, i) => a + i.total, 0);
  return round1(used.reduce((a, i) => a + projectItemScore(i) * i.total, 0) / totalW);
}

export interface MonthScoreInput {
  amount: number; prevAmount: number | null;
  txCount: number; prevTxCount: number | null;
  activeTerminals: number; prevActiveTerminals: number | null;
  /** ترمینال‌های قابل‌سنجش: فعال + کم‌تراکنش (نوپا و برگشتی خارج‌اند) */
  measurableTerminals: number;
  projects: readonly ProjectScoreItem[];
}

export interface MonthScore {
  total: number | null;
  components: Record<ScoreComponent, number | null>;
  amountGrowthPct: number | null;
  countGrowthPct: number | null;
  deviceGrowthPct: number | null;
  /** سهم دستگاه‌های فعال از قابل‌سنجش (٪) */
  activeRatioPct: number | null;
}

export function normalizeWeights(w: ScoreWeights): ScoreWeights {
  const sum = SCORE_COMPONENTS.reduce((a, k) => a + Math.max(0, w[k]), 0);
  if (sum <= 0) return { ...DEFAULT_SCORE_WEIGHTS };
  return Object.fromEntries(SCORE_COMPONENTS.map((k) => [k, Math.max(0, w[k]) / sum])) as ScoreWeights;
}

export function scoreMonth(i: MonthScoreInput, weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS): MonthScore {
  const amountGrowthPct = growthPct(i.amount, i.prevAmount);
  const countGrowthPct = growthPct(i.txCount, i.prevTxCount);
  const deviceGrowthPct = growthPct(i.activeTerminals, i.prevActiveTerminals);
  const activeRatioPct = i.measurableTerminals > 0 ? round1((i.activeTerminals / i.measurableTerminals) * 100) : null;

  const deviceParts = [growthToScore(deviceGrowthPct), activeRatioPct].filter((v): v is number => v !== null);
  const components: Record<ScoreComponent, number | null> = {
    amount: growthToScore(amountGrowthPct),
    count: growthToScore(countGrowthPct),
    devices: deviceParts.length === 0 ? null : round1(deviceParts.reduce((a, b) => a + b, 0) / deviceParts.length),
    projects: projectsScore(i.projects),
  };

  const w = normalizeWeights(weights);
  let num = 0;
  let den = 0;
  for (const k of SCORE_COMPONENTS) {
    const v = components[k];
    if (v === null) continue;
    num += v * w[k];
    den += w[k];
  }
  return { total: den > 0 ? round1(num / den) : null, components, amountGrowthPct, countGrowthPct, deviceGrowthPct, activeRatioPct };
}

export type ScoreBand = 'excellent' | 'good' | 'average' | 'weak' | 'poor';

export const SCORE_BAND_FA: Record<ScoreBand, { text: string; color: string }> = {
  excellent: { text: 'عالی', color: 'green' },
  good: { text: 'خوب', color: 'cyan' },
  average: { text: 'متوسط', color: 'gold' },
  weak: { text: 'ضعیف', color: 'orange' },
  poor: { text: 'بسیار ضعیف', color: 'red' },
};

export function scoreBand(total: number | null): ScoreBand | null {
  if (total === null) return null;
  if (total >= 80) return 'excellent';
  if (total >= 65) return 'good';
  if (total >= 50) return 'average';
  if (total >= 35) return 'weak';
  return 'poor';
}

/** امتیاز کلی = میانگین امتیاز ماه‌های دارای امتیاز */
export function overallScore(monthly: ReadonlyArray<number | null>): number | null {
  const v = monthly.filter((x): x is number => x !== null);
  return v.length === 0 ? null : round1(v.reduce((a, b) => a + b, 0) / v.length);
}

export type ScoreTrend = 'up' | 'down' | 'flat';

/** روند: میانگین ۳ ماه اخیر در برابر ۳ ماه قبل‌تر (اختلاف ≥ ۳ امتیاز = صعودی/نزولی) */
export function scoreTrend(monthly: ReadonlyArray<number | null>): ScoreTrend | null {
  const v = monthly.filter((x): x is number => x !== null);
  if (v.length < 2) return null;
  const recent = v.slice(-3);
  const before = v.slice(-6, -3);
  const base = before.length > 0 ? before : v.slice(0, Math.max(1, v.length - recent.length));
  if (base.length === 0) return null;
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  const d = avg(recent) - avg(base);
  return d >= 3 ? 'up' : d <= -3 ? 'down' : 'flat';
}

const faNum = (n: number): string => new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(n);
const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${faNum(Math.abs(n))}٪`;

export interface CommentInput {
  score: MonthScore;
  projects: ReadonlyArray<ProjectScoreItem & { name: string }>;
}

/** توضیحات فارسی قابل‌خواندن برای کاربر: هر مؤلفه با عدد واقعی + نقطه‌ی قوت و ضعف */
export function buildScoreComments({ score, projects }: CommentInput): string[] {
  const out: string[] = [];
  const g = (label: string, pct: number | null, sc: number | null): void => {
    if (pct === null || sc === null) { out.push(`${label}: ماه قبل پایه‌ی مقایسه نداشت، پس در امتیاز لحاظ نشد.`); return; }
    out.push(`${label}: ${signed(pct)} نسبت به ماه قبل (امتیاز ${faNum(sc)}).`);
  };
  g('مبلغ خرید', score.amountGrowthPct, score.components.amount);
  g('تعداد تراکنش', score.countGrowthPct, score.components.count);
  if (score.components.devices !== null) {
    const parts: string[] = [];
    if (score.deviceGrowthPct !== null) parts.push(`دستگاه فعال ${signed(score.deviceGrowthPct)} نسبت به ماه قبل`);
    if (score.activeRatioPct !== null) parts.push(`${faNum(score.activeRatioPct)}٪ دستگاه‌ها فعال‌اند`);
    out.push(`دستگاه‌ها: ${parts.join('، ')} (امتیاز ${faNum(score.components.devices)}).`);
  }
  if (score.components.projects !== null && projects.length > 0) {
    const worst = [...projects].sort((a, b) => projectItemScore(a) - projectItemScore(b))[0];
    out.push(`پروژه‌ها: میانگین وزنی ${faNum(score.components.projects)} از ۱۰۰ در ${faNum(projects.length)} پروژه`
      + (worst && projectItemScore(worst) < 70 ? `؛ ضعیف‌ترین «${worst.name}» با امتیاز ${faNum(projectItemScore(worst))}.` : '.'));
  } else if (projects.length === 0) {
    out.push('پروژه‌ای در این ماه برای این پشتیبان فعال نبود؛ وزن پروژه بین بقیه‌ی مؤلفه‌ها پخش شد.');
  }
  const ranked = (Object.entries(score.components) as Array<[ScoreComponent, number | null]>)
    .filter((e): e is [ScoreComponent, number] => e[1] !== null)
    .sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  const worstC = ranked[ranked.length - 1];
  if (best && worstC && ranked.length > 1 && best[0] !== worstC[0]) {
    out.push(`نقطه‌ی قوت: ${SCORE_COMPONENT_FA[best[0]]}. نیازمند توجه بیشتر: ${SCORE_COMPONENT_FA[worstC[0]]}.`);
  }
  return out;
}

/** ماه جاری شمسی با نام ماه فارسی (برای نام پروژه‌های خودکار و گزارش‌ها) */
export const JALALI_MONTH_NAMES = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'] as const;

export function periodNameFa(periodId: number): string {
  const year = Math.floor(periodId / 100);
  const month = periodId % 100;
  return `${JALALI_MONTH_NAMES[month - 1] ?? month} ${year}`;
}
