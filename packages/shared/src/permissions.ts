/**
 * سطح دسترسی کاربران.
 *  - «نقش» دامنه‌ی داده را تعیین می‌کند (کل دفتر / یک ستاد / یک پشتیبان).
 *  - «مجوز» تعیین می‌کند کاربر چه کارهایی می‌تواند بکند.
 * مجوزهای پیش‌فرض هر نقش همان رفتار قبلی سامانه است و سقف مجاز آن نقش هم هست؛ مدیر دفتر می‌تواند برای هر کاربر
 * مجوزها را کم کند (مثلاً «فقط مشاهده»)، ولی بیشتر از سقف نقش نمی‌تواند بدهد. مدیر دفتر همیشه همه‌ی مجوزها را دارد.
 */
export const PERMISSION_GROUPS = ['گزارش‌ها', 'ترمینال‌ها و داده‌ها', 'پروژه‌ها', 'مدیریت'] as const;

export interface PermissionMeta { key: string; label: string; group: (typeof PERMISSION_GROUPS)[number]; hint?: string }

export const PERMISSIONS = [
  { key: 'analytics.view', label: 'داشبورد و گزارش‌ها', group: 'گزارش‌ها', hint: 'KPI، روند، هشدارها، نقشه‌ی حرارتی' },
  { key: 'scores.view', label: 'امتیاز پشتیبان‌ها', group: 'گزارش‌ها' },
  { key: 'forecast.view', label: 'مشاهده‌ی پیش‌بینی فروش', group: 'گزارش‌ها' },
  { key: 'export.run', label: 'خروجی اکسل گزارش‌ها', group: 'گزارش‌ها' },
  { key: 'terminals.edit', label: 'ایجاد/ویرایش ترمینال و تعویض پشتیبان، مسیر و بانک (تکی و گروهی)', group: 'ترمینال‌ها و داده‌ها' },
  { key: 'terminals.audit', label: 'مشاهده‌ی تاریخچه‌ی تغییرات ترمینال', group: 'ترمینال‌ها و داده‌ها' },
  { key: 'pending.manage', label: 'تعریف‌نشده‌ها: تعیین پشتیبان ترمینال‌های فایل', group: 'ترمینال‌ها و داده‌ها' },
  { key: 'imports.manage', label: 'ایمپورت فایل‌ها', group: 'ترمینال‌ها و داده‌ها' },
  { key: 'masterdata.manage', label: 'مدیریت ستاد، پشتیبان، بانک و مسیر', group: 'ترمینال‌ها و داده‌ها' },
  { key: 'projects.work', label: 'مشاهده‌ی پروژه‌ها و ثبت وضعیت ترمینال‌ها', group: 'پروژه‌ها' },
  { key: 'projects.manage', label: 'ساخت و ویرایش پروژه، افزودن/حذف ترمینال', group: 'پروژه‌ها' },
  { key: 'forecast.manage', label: 'اجرای پیش‌بینی فروش', group: 'پروژه‌ها' },
  { key: 'settings.view', label: 'مشاهده‌ی تنظیمات', group: 'مدیریت' },
  { key: 'settings.manage', label: 'تغییر تنظیمات و قوانین، پروژه‌های خودکار', group: 'مدیریت' },
  { key: 'settings.maintenance', label: 'نگهداری (بازسازی آمار)', group: 'مدیریت' },
  { key: 'users.manage', label: 'مدیریت کاربران و سطح دسترسی', group: 'مدیریت' },
] as const satisfies readonly PermissionMeta[];

export type Permission = (typeof PERMISSIONS)[number]['key'];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as [Permission, ...Permission[]];

export type AccessRole = 'office_manager' | 'data_admin' | 'unit_head' | 'supporter';

export const ROLE_DEFAULT_PERMISSIONS: Record<AccessRole, readonly Permission[]> = {
  office_manager: PERMISSION_KEYS,
  data_admin: [
    'analytics.view', 'scores.view', 'forecast.view', 'export.run', 'terminals.edit', 'pending.manage', 'imports.manage',
    'masterdata.manage', 'projects.work', 'projects.manage', 'forecast.manage', 'settings.view', 'settings.manage',
  ],
  unit_head: ['analytics.view', 'scores.view', 'forecast.view', 'export.run', 'terminals.edit', 'terminals.audit', 'projects.work', 'settings.view'],
  supporter: ['analytics.view', 'scores.view', 'forecast.view', 'export.run', 'projects.work'],
};

const isRole = (r: string): r is AccessRole => r in ROLE_DEFAULT_PERMISSIONS;

/** سقف مجوزهای نقش (برای نقش‌های ناشناخته مثل ستاد مرکزی: هیچ) */
export function permissionCeiling(role: string): readonly Permission[] {
  return isRole(role) ? ROLE_DEFAULT_PERMISSIONS[role] : [];
}

/** مجوزهای مؤثر: null ⇒ پیش‌فرض نقش؛ وگرنه اشتراک با سقف نقش. مدیر دفتر همیشه کامل. */
export function effectivePermissions(role: string, stored: readonly string[] | null | undefined): Permission[] {
  const ceiling = permissionCeiling(role);
  if (role === 'office_manager' || stored === null || stored === undefined) return [...ceiling];
  return ceiling.filter((p) => stored.includes(p));
}

export const hasPermission = (perms: readonly string[] | undefined | null, p: Permission): boolean => !!perms && perms.includes(p);

/** سطح‌های آماده برای انتخاب سریع در رابط کاربری */
export const ACCESS_PRESETS: Array<{ key: string; label: string; permissions: readonly Permission[] | null }> = [
  { key: 'default', label: 'پیش‌فرض نقش', permissions: null },
  { key: 'view_only', label: 'فقط مشاهده', permissions: ['analytics.view', 'scores.view', 'forecast.view', 'projects.work'] },
  { key: 'reports_only', label: 'فقط گزارش‌ها', permissions: ['analytics.view', 'scores.view', 'forecast.view', 'export.run'] },
];
