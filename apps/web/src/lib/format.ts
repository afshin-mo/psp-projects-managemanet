import { fromPeriodId, gregorianToJalali, isoToJalali, jalaliToGregorian, toIsoDate, type JalaliDate } from '@pos/shared';

export const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

const nf = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 });

export const fmtNum = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : nf.format(n));
export const fmtPct = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${nf2.format(n)}٪`);
/** مبلغ بزرگ به صورت خلاصه (میلیون/میلیارد) */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `${nf2.format(n / 1e12)} هزار میلیارد`;
  if (a >= 1e9) return `${nf2.format(n / 1e9)} میلیارد`;
  if (a >= 1e6) return `${nf2.format(n / 1e6)} میلیون`;
  return nf.format(n);
}

export function periodLabel(periodId: number): string {
  const { year, month } = fromPeriodId(periodId);
  return `${JALALI_MONTHS[month - 1] ?? month} ${new Intl.NumberFormat('fa-IR', { useGrouping: false }).format(year)}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const faDigits = (s: string): string => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d);

/** تاریخ ISO میلادی ← «۱۴۰۴/۰۵/۱۰» */
export function jalaliText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const j = isoToJalali(iso.slice(0, 10));
  return faDigits(`${j.jy}/${pad(j.jm)}/${pad(j.jd)}`);
}

/** «1404/5/10» یا ارقام فارسی ← ISO میلادی؛ نامعتبر = null */
export function parseJalaliInput(text: string): string | null {
  const en = text.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*$/.exec(en);
  if (!m) return null;
  const j: JalaliDate = { jy: Number(m[1]), jm: Number(m[2]), jd: Number(m[3]) };
  if (j.jm < 1 || j.jm > 12 || j.jd < 1 || j.jd > 31) return null;
  const iso = toIsoDate(jalaliToGregorian(j.jy, j.jm, j.jd));
  // رفت‌وبرگشت: روز ناموجود (مثلاً ۳۰ اسفند در سال غیرکبیسه) رد می‌شود
  const back = isoToJalali(iso);
  return back.jy === j.jy && back.jm === j.jm && back.jd === j.jd ? iso : null;
}

export const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const todayJalaliText = (): string => {
  const d = new Date();
  const j = gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return faDigits(`${j.jy}/${pad(j.jm)}/${pad(j.jd)}`);
};

export const ROLE_FA: Record<string, string> = {
  system_admin: 'مدیر سامانه', office_manager: 'مدیر دفتر', data_admin: 'ادمین داده', unit_head: 'مسئول ستاد', supporter: 'پشتیبان',
};

/** تاریخ و ساعت (وقت تهران): «۱۴۰۴/۰۵/۱۰ ۱۴:۳۰» */
export function jalaliDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tehran' }).format(d);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(d); // YYYY-MM-DD
  return `${jalaliText(day)} ${time}`;
}
