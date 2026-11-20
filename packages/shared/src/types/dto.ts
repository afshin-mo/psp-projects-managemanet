export type UserRole = 'system_admin' | 'office_manager' | 'unit_head' | 'supporter' | 'data_admin';

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface StaffUnitDto { id: number; name: string; managerName: string | null; isActive: boolean }
export interface SupporterDto { id: number; staffUnitId: number; fullName: string; phone: string | null; isActive: boolean }
export interface BankDto { id: number; name: string; code: string | null }
export interface RouteGroupDto { id: number; name: string }

export interface UserDto {
  id: number; username: string; fullName: string; role: UserRole;
  staffUnitId: number | null; supporterId: number | null; isActive: boolean; createdAt: string;
  /** null = پیش‌فرض نقش */
  permissions: string[] | null;
  /** مجوزهای مؤثر (با احتساب سقف نقش) */
  effectivePermissions: string[];
}

export interface TerminalDto {
  id: number;
  terminalNo: string;
  ownerName: string | null;
  phone: string | null;
  address: string | null;
  shopName: string | null;
  routeGroupId: number | null;
  bankId: number | null;
  status: 'active' | 'returned';
  installedAt: string | null;
  returnedAt: string | null;
  returnReason: string | null;
  supporterId: number;
  unitId: number;
  attributes: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalHistoryDto {
  id: number; supporterId: number; unitId: number; routeGroupId: number; bankId: number;
  startDate: string; endDate: string | null;
  /** چه کسی این تغییر را ثبت کرد (null = سیستم/نامشخص) و کِی */
  changedBy: number | null; changedByName: string | null; createdAt: string;
}

export interface AuditDto {
  id: number; userId: number | null; action: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; createdAt: string;
  /** نام کاربر انجام‌دهنده (null = سیستم) */
  userName: string | null;
  /** اگر تغییر از ایمپورت فایل بوده: شناسه و نام فایل */
  batchId: number | null; batchFileName: string | null;
}

export type ImportStatus =
  | 'uploaded' | 'needs_mapping' | 'validating' | 'validated' | 'committing' | 'merged'
  | 'aggregating' | 'completed' | 'failed' | 'cancelled';

export interface ImportBatchDto {
  id: number;
  type: string;
  status: ImportStatus;
  fileName: string;
  fileSize: number;
  fileKind: 'xlsx' | 'csv';
  options: Record<string, unknown>;
  totalRows: number | null;
  validRows: number | null;
  errorRows: number | null;
  skippedRows: number | null;
  insertedRows: number | null;
  updatedRows: number | null;
  unchangedRows: number | null;
  stage: string | null;
  progress: number;
  errorSummary: Record<string, unknown> | null;
  createdBy: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** آمار ثبت: مثلاً { infoUpdated, banksCreated, pendingTerminals } */
  mergeSummary: Record<string, number> | null;
}

export interface ImportErrorDto { rowNo: number; columnName: string | null; code: string; message: string }
export interface UnknownTerminalDto {
  terminalNo: string; rowsCount: number;
  /** آخرین مانده‌ی تجمعی مبلغ خرید در فایل */
  totalAmount: number;
  /** آخرین مانده‌ی تجمعی مبلغ کل در فایل (۰ اگر فایل ستون نداشت) */
  totalAllAmount: number;
  firstRow: number;
  shopName: string | null; ownerName: string | null; phone: string | null; bankName: string | null;
  hasActivity: boolean;
}

export interface MappingInfoDto {
  source: 'official' | 'profile' | 'suggested' | 'none';
  headers: string[];
  columnMap: Record<string, string>;
  missingRequired: string[];
  unmatchedHeaders: string[];
}

export interface OfficeSettingsDto {
  newTerminalCutoffDay: number;
  preliminaryAlertMinDay: number;
  dropAlertThresholdPct: number;
  incomeBasis: 'purchase' | 'total';
  autoNoIncomePrev: boolean;
  autoPrevDeadlineDay: number;
  autoNoIncomeCurr: boolean;
  autoCurrCheckDay: number;
  syncTerminalInfo: boolean;
  syncCreateBanks: boolean;
  scoreWeights: { amount: number; count: number; devices: number; projects: number };
  updatedAt: string;
}

export interface ActivityRuleDto {
  bankId: number;
  validFromPeriod: number;
  minMonthlyAmount: number;
  createdAt: string;
}
