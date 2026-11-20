export interface PeriodMetrics {
  periodId: number;
  amount: number;
  txCount: number;
  activeTerminals: number;
  lowTerminals: number;
  returnedTerminals: number;
  newTerminals: number;
  /** فعال + کم‌تراکنش + نوپا (برگشتی‌ها جدا هستند) */
  totalTerminals: number;
  incompleteTerminals: number;
  isComplete: boolean;
}

export interface ChangeDto {
  /** actual: واقعی با واقعی؛ projected: پیش‌بینی ماه ناقص با ماه کامل */
  basis: 'actual' | 'projected';
  amountPct: number | null;
  txCountPct: number | null;
  activeTerminalsPct: number | null;
}

export interface ProjectionDto {
  method: 'curve' | 'linear';
  daysCovered: number;
  daysInMonth: number;
  asOfDate: string;
  projectedAmount: number;
  projectedTxCount: number;
}

export interface KpiDto {
  range: { from: number; to: number };
  totals: { amount: number; txCount: number };
  current: PeriodMetrics | null;
  previous: PeriodMetrics | null;
  yearAgo: PeriodMetrics | null;
  projection: ProjectionDto | null;
  mom: ChangeDto;
  yoy: ChangeDto;
}

export interface BankShareDto { bankId: number; name: string; amount: number; txCount: number; terminals: number; sharePct: number }

export interface GrowthItemDto {
  id: number;
  name: string;
  unitId?: number;
  amount: number;
  previous: number;
  yearAgo: number;
  momPct: number | null;
  yoyPct: number | null;
  sharePct: number;
  activeTerminals: number;
  incompleteTerminals: number;
}

export interface HeatmapDto {
  metric: string;
  periods: number[];
  rows: Array<{ supporterId: number; name: string; unitId: number; values: number[] }>;
}

export interface DrillTerminalDto {
  id: number; terminalNo: string; shopName: string | null; amount: number; txCount: number; activityClass: number;
  isComplete: boolean; supporterId: number; routeGroupId: number; bankId: number;
  previousAmount: number | null; changePct: number | null;
}

export interface DroppedTerminalDto {
  id: number; terminalNo: string; shopName: string | null; supporterId: number; unitId: number;
  avg3Amount: number; currentAmount: number; dropPct: number;
}

export interface PreliminaryAlertDto extends DroppedTerminalDto { projectedAmount: number }

export interface CoverageDto {
  periodId: number; lastFileDate: string | null; terminals: number; withoutFile: number; incomplete: number; isComplete: boolean;
}

export interface DailyDeltaDto { asOfDate: string; deltaAmount: number; deltaCount: number; spanDays: number; estimated: boolean }

export interface TerminalMonthDto {
  periodId: number; amount: number; txCount: number; totalAmount: number; totalTxCount: number; activityClass: number; isComplete: boolean; lastAsOfDate: string | null;
  supporterId: number; unitId: number; routeGroupId: number; bankId: number;
}

export interface ExportJobDto {
  id: number; kind: string; status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  rowCount: number | null; error: string | null; createdAt: string; expiresAt: string | null;
}
