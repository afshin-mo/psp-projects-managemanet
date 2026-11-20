import type { BankDto, RouteGroupDto, TerminalDto } from './dto';
import type { AutoProjectKind } from '../schemas/settings';
import type { ProjectStatus } from '../projects';
import type { MonthScore, ScoreBand, ScoreComponent, ScoreTrend, ScoreWeights } from '../scoring';

// ---------------------------------------------------------------- ترمینال‌های تعریف‌نشده (موجود در فایل، نبوده در دیتابیس)
export interface PendingTerminalDto {
  terminalNo: string;
  shopName: string | null;
  ownerName: string | null;
  phone: string | null;
  address: string | null;
  bankName: string | null;
  /** بانک تطبیق‌یافته با نام بانک فایل (null = بانکی با این نام تعریف نشده) */
  matchedBankId: number | null;
  status: 'pending' | 'dismissed';
  hasActivity: boolean;
  lastAsOfDate: string;
  /** آخرین مانده‌ی تجمعی مبلغ خرید / کل / تعداد در فایل‌ها */
  lastAmount: number;
  lastTotalAmount: number | null;
  lastTxCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastBatchId: number | null;
}

export interface PendingSummaryDto { pending: number; pendingActive: number; dismissed: number }

export interface AssignPendingResultDto {
  created: number;
  /** تعداد ردیف تراکنشی که وارد آمار شد */
  snapshotsAdopted: number;
  banksCreated: number;
  skipped: Array<{ terminalNo: string; reason: string }>;
}

// ---------------------------------------------------------------- پروژه‌های خودکار
export interface AutoProjectRunDto {
  id: number;
  kind: AutoProjectKind;
  periodId: number;
  projectId: number | null;
  outcome: 'created' | 'updated' | 'unchanged' | 'skipped';
  added: number;
  eligible: number;
  message: string | null;
  trigger: 'schedule' | 'manual';
  createdBy: number | null;
  createdAt: string;
}

export interface AutoProjectRunResultDto {
  kind: AutoProjectKind;
  periodId: number;
  projectId: number | null;
  outcome: AutoProjectRunDto['outcome'];
  added: number;
  eligible: number;
  message: string | null;
}

export interface AutoProjectsStatusDto {
  runs: AutoProjectRunDto[];
  projects: Array<{
    id: number; name: string; kind: AutoProjectKind; periodId: number; status: ProjectStatus;
    startDate: string; dueDate: string; total: number;
  }>;
}

// ---------------------------------------------------------------- امتیاز پشتیبان
export interface ScoreProjectDto {
  projectId: number; name: string; total: number; resolved: number;
  actualPct: number; expectedPct: number; score: number;
}

export interface ScoreMonthDto {
  periodId: number;
  total: number | null;
  components: MonthScore['components'];
  growth: { amount: number | null; count: number | null; devices: number | null };
  metrics: {
    /** مبلغ خرید (مبنای امتیاز) و مبلغ کل (صرفاً نمایشی) */
    amount: number; totalAmount: number; txCount: number;
    activeTerminals: number; measurableTerminals: number; activeRatioPct: number | null;
  };
  projects: ScoreProjectDto[];
}

export interface SupporterScoreDto {
  supporterId: number;
  name: string;
  unitId: number;
  /** میانگین ماه‌های دارای امتیاز در بازه */
  overall: number | null;
  band: ScoreBand | null;
  trend: ScoreTrend | null;
  /** میانگین مؤلفه‌ها در بازه (برای نمودار رادار) */
  componentAverages: Record<ScoreComponent, number | null>;
  rank: number | null;
  months: ScoreMonthDto[];
}

export interface ScoreboardDto {
  /** ماه‌های امتیازدهی‌شده (فقط ماه‌های کامل)، صعودی */
  periods: number[];
  /** ماه ناقص جاری که در امتیاز لحاظ نشد (برای اطلاع کاربر) */
  skippedPartialPeriod: number | null;
  weights: ScoreWeights;
  /** میانگین امتیاز همه‌ی پشتیبان‌ها در هر ماه (هم‌ترتیب با periods) */
  officeAverage: Array<number | null>;
  supporters: SupporterScoreDto[];
}

// ---------------------------------------------------------------- ثبت گروهی و جستجوی چندشماره‌ای
export interface BulkCreateResultDto<T> {
  created: number;
  items: T[];
  skipped: Array<{ name: string; reason: string }>;
}
export type BulkBanksResultDto = BulkCreateResultDto<BankDto>;
export type BulkRoutesResultDto = BulkCreateResultDto<RouteGroupDto>;

export interface TerminalLookupDto {
  /** ترمینال‌های پیداشده (در دامنه‌ی دسترسی کاربر) به ترتیب شماره‌ی ورودی */
  items: TerminalDto[];
  /** شماره‌هایی که در دامنه‌ی کاربر وجود ندارند */
  notFound: string[];
  requested: number;
}
