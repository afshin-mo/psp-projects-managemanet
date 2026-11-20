/**
 * پیش‌بینی سری‌های ماهانه (Holt و Holt-Winters جمع‌شونده). توابع خالص و بدون وابستگی؛ اجرا در Worker.
 *
 * انتخاب مدل: روی چند ماه آخر (holdout) هر مدل مجاز امتحان می‌شود و مدل با کمترین MAPE انتخاب می‌شود؛
 * سپس مدل برنده روی کل سری دوباره برازش می‌شود. «میانگین» مدل پایه‌ی امن برای سری‌های کوتاه یا پرنوسان است.
 */

export type ForecastModel = 'holt_winters' | 'holt' | 'mean';

export interface ForecastPoint { step: number; value: number; lower: number; upper: number }

export interface ForecastResult {
  model: ForecastModel;
  params: { alpha?: number; beta?: number; gamma?: number };
  /** خطای میانگین مطلق درصدی روی holdout؛ null اگر سری برای holdout کوتاه است */
  mape: number | null;
  points: ForecastPoint[];
}

interface Fit {
  /** پیش‌بینی h گام بعد (h≥1) */
  forecast(h: number): number;
  /** انحراف معیار خطاهای یک‌گام‌جلو (درون‌نمونه‌ای) */
  sigma: number;
  params: ForecastResult['params'];
}

const Z95 = 1.96;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);
const rmse = (errs: readonly number[]): number => Math.sqrt(mean(errs.map((e) => e * e)));

// ---------------------------------------------------------------- میانگین

function fitMean(y: readonly number[]): Fit {
  const tail = y.slice(-Math.min(6, y.length));
  const level = mean(tail);
  const sd = Math.sqrt(mean(tail.map((v) => (v - level) ** 2)));
  return { forecast: () => level, sigma: sd, params: {} };
}

// ---------------------------------------------------------------- Holt

const HOLT_ALPHAS = [0.1, 0.2, 0.3, 0.5, 0.7, 0.9];
const HOLT_BETAS = [0.05, 0.1, 0.2, 0.3, 0.5];

function runHolt(y: readonly number[], alpha: number, beta: number): { level: number; trend: number; errors: number[] } {
  const k = Math.min(3, y.length - 1);
  let level = y[0] as number;
  let trend = ((y[k] as number) - level) / k;
  const errors: number[] = [];
  for (let t = 1; t < y.length; t += 1) {
    const obs = y[t] as number;
    errors.push(obs - (level + trend));
    const prev = level;
    level = alpha * obs + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return { level, trend, errors };
}

/** نیازمند حداقل ۴ نقطه */
function fitHolt(y: readonly number[]): Fit {
  let best: { alpha: number; beta: number; rmse: number } | null = null;
  for (const alpha of HOLT_ALPHAS) {
    for (const beta of HOLT_BETAS) {
      const e = rmse(runHolt(y, alpha, beta).errors);
      if (best === null || e < best.rmse) best = { alpha, beta, rmse: e };
    }
  }
  const b = best as { alpha: number; beta: number; rmse: number };
  const { level, trend, errors } = runHolt(y, b.alpha, b.beta);
  // روند تا ۱۲ گام جلو به‌تدریج میرا می‌شود تا پیش‌بینی بلندمدت از کنترل خارج نشود
  const phi = 0.95;
  return {
    forecast: (h) => {
      let damp = 0;
      for (let i = 1; i <= h; i += 1) damp += phi ** i;
      return level + damp * trend;
    },
    sigma: rmse(errors),
    params: { alpha: b.alpha, beta: b.beta },
  };
}

// ---------------------------------------------------------------- Holt-Winters (جمع‌شونده)

const HW_ALPHAS = [0.1, 0.3, 0.5, 0.7];
const HW_BETAS = [0.01, 0.05, 0.1, 0.2];
const HW_GAMMAS = [0.1, 0.3, 0.5];

function runHW(y: readonly number[], m: number, alpha: number, beta: number, gamma: number) {
  const s1 = y.slice(0, m);
  const s2 = y.slice(m, 2 * m);
  const m1 = mean(s1);
  const m2 = mean(s2);
  let trend = (m2 - m1) / m;
  // سطح بدون فصل در پایان فصل دوم (نقطه‌ی شروع تکرار از t=2m)
  let level = m2 + (trend * (m - 1)) / 2;
  const season: number[] = s1.map((v, i) => (v - m1 + ((s2[i] as number) - m2)) / 2);
  const errors: number[] = [];
  for (let t = 2 * m; t < y.length; t += 1) {
    const obs = y[t] as number;
    const idx = t % m;
    const s = season[idx] as number;
    errors.push(obs - (level + trend + s));
    const prev = level;
    level = alpha * (obs - s) + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
    season[idx] = gamma * (obs - level) + (1 - gamma) * s;
  }
  return { level, trend, season, errors };
}

/** نیازمند حداقل ۲ فصل کامل + ۱ نقطه (برای ماهانه: ۲۵ ماه) */
function fitHoltWinters(y: readonly number[], m: number): Fit {
  let best: { alpha: number; beta: number; gamma: number; rmse: number } | null = null;
  for (const alpha of HW_ALPHAS) {
    for (const beta of HW_BETAS) {
      for (const gamma of HW_GAMMAS) {
        const e = rmse(runHW(y, m, alpha, beta, gamma).errors);
        if (best === null || e < best.rmse) best = { alpha, beta, gamma, rmse: e };
      }
    }
  }
  const b = best as { alpha: number; beta: number; gamma: number; rmse: number };
  const { level, trend, season, errors } = runHW(y, m, b.alpha, b.beta, b.gamma);
  const n = y.length;
  return {
    forecast: (h) => level + h * trend + (season[(n + h - 1) % m] as number),
    sigma: rmse(errors),
    params: { alpha: b.alpha, beta: b.beta, gamma: b.gamma },
  };
}

// ---------------------------------------------------------------- انتخاب مدل

interface Candidate { model: ForecastModel; fit(y: readonly number[]): Fit }

function candidatesFor(n: number, m: number): Candidate[] {
  const out: Candidate[] = [{ model: 'mean', fit: fitMean }];
  if (n >= 4) out.push({ model: 'holt', fit: fitHolt });
  if (n >= 2 * m + 1) out.push({ model: 'holt_winters', fit: (y) => fitHoltWinters(y, m) });
  return out;
}

/** MAPE روی نقاط غیرصفر؛ اگر هیچ نقطه‌ی غیرصفری نبود null */
export function mape(actual: readonly number[], predicted: readonly number[]): number | null {
  let total = 0;
  let n = 0;
  for (let i = 0; i < actual.length; i += 1) {
    const a = actual[i] as number;
    if (a === 0) continue;
    total += Math.abs((a - (predicted[i] as number)) / a);
    n += 1;
  }
  return n === 0 ? null : Math.round((total / n) * 10_000) / 100;
}

/**
 * پیش‌بینی horizon ماه بعد. values باید ماه‌های کامل پیاپی (بدون سوراخ) باشد؛ سوراخ‌ها را با fillSeriesGaps پر کنید.
 * اگر کمتر از ۳ مشاهده باشد null.
 */
export function forecastSeries(values: readonly number[], horizon: number, seasonLength = 12): ForecastResult | null {
  const n = values.length;
  if (n < 3 || horizon < 1) return null;

  // holdout: حداکثر ۳ ماه آخر (حداکثر یک‌چهارم سری)، فقط اگر سری برای ارزیابی کافی باشد
  const hold = n >= 8 ? Math.min(3, Math.floor(n / 4)) : 0;
  let chosen: Candidate = { model: 'mean', fit: fitMean };
  let holdMape: number | null = null;

  if (hold > 0) {
    const train = values.slice(0, n - hold);
    const test = values.slice(n - hold);
    let bestErr = Number.POSITIVE_INFINITY;
    for (const c of candidatesFor(train.length, seasonLength)) {
      const f = c.fit(train);
      const pred = test.map((_, i) => Math.max(0, f.forecast(i + 1)));
      const e = mape(test, pred);
      if (e === null) continue;
      // ترجیح مدل ساده‌تر در تساوی نزدیک (کمتر از ۰٫۵ واحد درصد بهتر نباشد)
      if (e + 0.5 < bestErr) {
        bestErr = e;
        chosen = c;
        holdMape = e;
      }
    }
  } else if (n >= 4) {
    chosen = { model: 'holt', fit: fitHolt };
  }

  // اگر holdout هیچ مدلی را معتبر نکرد (همه‌ی مقادیر صفر)، میانگین باقی می‌ماند
  const fit = chosen.fit(values);
  const points: ForecastPoint[] = [];
  for (let h = 1; h <= horizon; h += 1) {
    const value = Math.max(0, fit.forecast(h));
    const half = Z95 * fit.sigma * Math.sqrt(h);
    points.push({
      step: h,
      value: Math.round(value),
      lower: Math.round(Math.max(0, value - half)),
      upper: Math.round(value + half),
    });
  }
  return { model: chosen.model, params: fit.params, mape: holdMape, points };
}

/**
 * سوراخ‌های داخلی (null) را با درون‌یابی خطی پر می‌کند و null های ابتدا/انتهای سری را حذف می‌کند.
 * اگر هیچ مقداری نبود null.
 */
export function fillSeriesGaps(values: ReadonlyArray<number | null>): number[] | null {
  const first = values.findIndex((v) => v !== null);
  if (first < 0) return null;
  let last = values.length - 1;
  while (last > first && values[last] === null) last -= 1;
  const out: number[] = [];
  for (let i = first; i <= last; i += 1) {
    const v = values[i];
    if (v !== null && v !== undefined) {
      out.push(v);
      continue;
    }
    let lo = i - 1;
    while (values[lo] === null || values[lo] === undefined) lo -= 1;
    let hi = i + 1;
    while (values[hi] === null || values[hi] === undefined) hi += 1;
    const a = values[lo] as number;
    const b = values[hi] as number;
    out.push(a + ((b - a) * (i - lo)) / (hi - lo));
  }
  return out;
}
