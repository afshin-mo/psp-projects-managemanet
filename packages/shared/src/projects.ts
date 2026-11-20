import { diffDaysIso } from './dates';
import { normalizeSearchText } from './normalize/text';

export const PROJECT_TERMINAL_STATUSES = ['not_started', 'in_progress', 'done', 'failed'] as const;
export type ProjectTerminalStatus = (typeof PROJECT_TERMINAL_STATUSES)[number];

export const PROJECT_STATUSES = ['active', 'closed', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_TERMINAL_STATUS_FA: Record<ProjectTerminalStatus, string> = {
  not_started: 'شروع نشده',
  in_progress: 'در حال انجام',
  done: 'انجام شده',
  failed: 'ناموفق',
};

// برچسب‌های فارسی/انگلیسی قابل‌قبول در فایل اکسل (نرمال‌شده با normalizeSearchText)
const STATUS_ALIASES: Record<string, ProjectTerminalStatus> = {
  'شروع نشده': 'not_started', 'شروع‌نشده': 'not_started', 'انجام نشده': 'not_started', 'در انتظار': 'not_started',
  'not_started': 'not_started', 'not started': 'not_started', 'pending': 'not_started',
  'در حال انجام': 'in_progress', 'در جریان': 'in_progress', 'در دست اقدام': 'in_progress',
  'in_progress': 'in_progress', 'in progress': 'in_progress',
  'انجام شده': 'done', 'تکمیل': 'done', 'تکمیل شده': 'done', 'پایان یافته': 'done', 'done': 'done', 'completed': 'done',
  'ناموفق': 'failed', 'شکست': 'failed', 'لغو شده': 'failed', 'failed': 'failed',
};

const STATUS_LOOKUP = new Map<string, ProjectTerminalStatus>(
  Object.entries(STATUS_ALIASES).map(([k, v]) => [normalizeSearchText(k), v]),
);

/** وضعیت ترمینال در پروژه از متن آزاد (فارسی/انگلیسی)؛ ناشناخته = null */
export function parseProjectTerminalStatus(input: string): ProjectTerminalStatus | null {
  return STATUS_LOOKUP.get(normalizeSearchText(input)) ?? null;
}

export type LagLevel = 'completed' | 'on_track' | 'at_risk' | 'behind' | 'overdue' | 'not_started_yet';

export interface ProjectLag {
  level: LagLevel;
  /** پیشرفت مورد انتظار بر پایه‌ی گذشت زمان (۰–۱۰۰) */
  expectedPct: number;
  /** پیشرفت واقعی = (انجام‌شده + ناموفق) / کل (۰–۱۰۰) */
  actualPct: number;
  /** expected - actual؛ مثبت یعنی عقب‌تر از برنامه */
  gapPct: number;
  daysLeft: number;
}

export const DEFAULT_LAG_TOLERANCE_PCT = 10;

/**
 * وضعیت عقب‌افتادگی بر اساس خط برنامه‌ی خطی از شروع تا سررسید.
 *  - همه‌ی ترمینال‌ها بسته‌شده (انجام/ناموفق): completed
 *  - امروز بعد از سررسید و کار باقی است: overdue
 *  - شکاف > ۲×tolerance: behind ؛ > tolerance: at_risk ؛ وگرنه on_track
 *  - امروز قبل از شروع: not_started_yet
 */
export function projectLag(i: {
  startDate: string; dueDate: string; today: string; total: number; done: number; failed: number; tolerancePct?: number;
}): ProjectLag {
  const tol = i.tolerancePct ?? DEFAULT_LAG_TOLERANCE_PCT;
  const resolved = i.done + i.failed;
  const actualPct = i.total === 0 ? 0 : Math.round((resolved / i.total) * 10_000) / 100;
  const totalDays = diffDaysIso(i.startDate, i.dueDate) + 1;
  const elapsed = Math.min(totalDays, Math.max(0, diffDaysIso(i.startDate, i.today) + 1));
  const expectedPct = Math.round((elapsed / totalDays) * 10_000) / 100;
  const daysLeft = diffDaysIso(i.today, i.dueDate);
  const gapPct = Math.round((expectedPct - actualPct) * 100) / 100;
  const base = { expectedPct, actualPct, gapPct, daysLeft };

  if (i.total > 0 && resolved >= i.total) return { level: 'completed', ...base };
  if (i.today < i.startDate) return { level: 'not_started_yet', ...base };
  if (i.total === 0) return { level: 'on_track', ...base };
  if (i.today > i.dueDate) return { level: 'overdue', ...base };
  if (gapPct > 2 * tol) return { level: 'behind', ...base };
  if (gapPct > tol) return { level: 'at_risk', ...base };
  return { level: 'on_track', ...base };
}

/** ترتیب شدت برای مرتب‌سازی هشدارها (بزرگ‌تر = شدیدتر) */
export const LAG_SEVERITY: Record<LagLevel, number> = {
  overdue: 4, behind: 3, at_risk: 2, on_track: 1, not_started_yet: 0, completed: 0,
};
