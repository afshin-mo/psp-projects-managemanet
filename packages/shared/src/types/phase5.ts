import type { LagLevel, ProjectLag, ProjectStatus, ProjectTerminalStatus } from '../projects';
import type { ForecastModel } from '../forecast';

export interface StatusCounts { notStarted: number; inProgress: number; done: number; failed: number }

export interface ProjectDto extends StatusCounts {
  id: number;
  name: string;
  description: string | null;
  startDate: string;
  dueDate: string;
  status: ProjectStatus;
  createdAt: string;
  /** پروژه‌ی خودکار (فاقد درآمد ماه قبل/جاری)؛ null = پروژه‌ی دستی */
  autoKind: 'no_income_prev' | 'no_income_curr' | null;
  /** تعداد ترمینال‌های پروژه در دامنه‌ی دسترسی کاربر */
  total: number;
  lag: ProjectLag;
}

export interface ProjectTerminalDto {
  terminalId: number;
  terminalNo: string;
  shopName: string | null;
  supporterId: number;
  unitId: number;
  status: ProjectTerminalStatus;
  note: string | null;
  statusChangedAt: string | null;
}

export interface ProjectSupporterProgressDto extends StatusCounts {
  supporterId: number;
  name: string;
  unitId: number;
  total: number;
  lag: ProjectLag;
}

export interface ProjectProgressDto {
  project: ProjectDto;
  /** قیف: کل ← شروع‌شده (در حال انجام + انجام‌شده) ← انجام‌شده */
  funnel: Array<{ key: 'total' | 'started' | 'done'; count: number }>;
  bySupporter: ProjectSupporterProgressDto[];
}

export interface ProjectMatrixDto {
  projects: Array<{ id: number; name: string; dueDate: string; lag: ProjectLag }>;
  rows: Array<{
    supporterId: number; name: string; unitId: number;
    /** هم‌ترتیب با projects؛ null = این پشتیبان در آن پروژه ترمینالی ندارد */
    cells: Array<{ total: number; done: number; failed: number; pct: number; level: LagLevel } | null>;
  }>;
}

export interface ProjectAlertDto {
  projectId: number; projectName: string; dueDate: string;
  supporterId: number; supporterName: string; unitId: number;
  total: number; done: number; failed: number; remaining: number;
  expectedPct: number; actualPct: number; gapPct: number; daysLeft: number;
  level: LagLevel;
}

export interface ProjectImportResultDto {
  added: number;
  alreadyInProject: number;
  statusUpdated: number;
  /** شماره ترمینال‌های ناشناخته (حداکثر ۱۰۰ مورد) */
  unknown: string[];
  unknownCount: number;
  /** ردیف‌های نامعتبر فایل (حداکثر ۱۰۰ مورد) */
  invalid: Array<{ rowNo: number; message: string }>;
  invalidCount: number;
}

export interface BulkResultDto { updated: number; unchanged: number }

export interface RemoveResultDto { removed: number }

export interface TransferUnitResultDto { terminals: number; clamped: number; fromUnitId: number; toUnitId: number }

export interface ForecastHistoryPoint { periodId: number; amount: number; isComplete: boolean }
export interface ForecastTargetPoint { periodId: number; value: number; lower: number; upper: number }

export interface ForecastDto {
  scope: 'office' | 'unit' | 'supporter';
  id: number;
  name: string;
  basePeriod: number | null;
  model: ForecastModel | null;
  /** درصد خطای holdout؛ null یعنی سری برای ارزیابی کوتاه بود */
  mape: number | null;
  generatedAt: string | null;
  history: ForecastHistoryPoint[];
  forecast: ForecastTargetPoint[];
}

export interface ForecastSummaryDto {
  scopeId: number;
  name: string;
  unitId: number | null;
  basePeriod: number;
  targetPeriod: number;
  lastActual: number;
  value: number;
  lower: number;
  upper: number;
  changePct: number | null;
  model: ForecastModel;
  mape: number | null;
}

export interface ForecastRunDto {
  id: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  horizon: number;
  basePeriod: number | null;
  seriesCount: number | null;
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** روند پیشرفت پشتیبان‌ها در یک پروژه: درصد «بسته‌شده» (انجام + ناموفق) در گذر زمان */
export interface ProjectTrendDto {
  /** نقطه‌های زمانی (ISO میلادی)؛ آخرین نقطه امروز (یا سررسید برای پروژه‌ی بسته) */
  dates: string[];
  /** خط برنامه‌ی خطی از شروع تا سررسید (درصد) هم‌ترتیب با dates */
  expectedPct: number[];
  supporters: Array<{ supporterId: number; name: string; unitId: number; total: number; values: number[] }>;
}
