import { z } from 'zod';
import { idParamSchema } from './common';

export const patchOfficeSettingsSchema = z
  .object({
    /** نصب از این روز ماه شمسی به بعد در همان ماه «نوپا» حساب می‌شود */
    newTerminalCutoffDay: z.number().int().min(1).max(31).optional(),
    /** هشدار مقدماتی ماه جاری از این روز ماه فعال می‌شود */
    preliminaryAlertMinDay: z.number().int().min(1).max(31).optional(),
    /** افت بیش از این درصد نسبت به میانگین ۳ ماه کامل قبل = هشدار */
    dropAlertThresholdPct: z.number().int().min(1).max(99).optional(),
    /** مبنای فاقد درآمد/کم‌تراکنش: purchase = مبلغ خرید (پیش‌فرض)، total = مبلغ کل (خرید+شارژ+قبض+...) */
    incomeBasis: z.enum(['purchase', 'total']).optional(),
    /** پروژه‌ی خودکار «فاقد درآمد ماه قبل» فعال باشد؟ */
    autoNoIncomePrev: z.boolean().optional(),
    /** مهلت پروژه‌ی ماه قبل: این روز از ماه جاری */
    autoPrevDeadlineDay: z.number().int().min(1).max(29).optional(),
    /** پروژه‌ی خودکار «فاقد درآمد ماه جاری» فعال باشد؟ */
    autoNoIncomeCurr: z.boolean().optional(),
    /** ترمینال‌های ماه جاری از این روز به بعد (بر پایه‌ی مبلغ تا آن روز) ارزیابی می‌شوند؛ مهلت = پایان همان ماه */
    autoCurrCheckDay: z.number().int().min(1).max(29).optional(),
    /** اطلاعات ترمینال (فروشگاه، موبایل، بانک، ...) از فایل تراکنش همگام شود؟ */
    syncTerminalInfo: z.boolean().optional(),
    /** بانکِ ناشناخته‌ی فایل تراکنش به‌طور خودکار تعریف شود؟ */
    syncCreateBanks: z.boolean().optional(),
    /** وزن مؤلفه‌های امتیاز پشتیبان (۰ تا ۱۰۰؛ جمع باید > ۰ باشد) */
    scoreWeights: z
      .object({
        amount: z.number().min(0).max(100),
        count: z.number().min(0).max(100),
        devices: z.number().min(0).max(100),
        projects: z.number().min(0).max(100),
      })
      .refine((w) => w.amount + w.count + w.devices + w.projects > 0, 'جمع وزن‌ها باید بیشتر از صفر باشد')
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'حداقل یک مقدار لازم است');

export const activityRuleSchema = z.object({
  /** ۰ = قانون پیش‌فرض دفتر؛ شناسه‌ی بانک = قانون همان بسته‌ی بانکی */
  bankId: z.number().int().min(0).default(0),
  /** شناسه‌ی دوره (سال*۱۰۰+ماه شمسی)؛ مثلاً ۱۴۰۴۰۱ */
  validFromPeriod: z
    .number().int().min(100_001).max(999_912)
    .refine((v) => v % 100 >= 1 && v % 100 <= 12, 'شناسه‌ی دوره نامعتبر است'),
  minMonthlyAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const rebuildSchema = z.object({
  fromPeriod: idParamSchema.optional(),
  toPeriod: idParamSchema.optional(),
});

export type PatchOfficeSettingsInput = z.infer<typeof patchOfficeSettingsSchema>;
export type ActivityRuleInput = z.infer<typeof activityRuleSchema>;
export type RebuildInput = z.infer<typeof rebuildSchema>;

export const AUTO_PROJECT_KINDS = ['no_income_prev', 'no_income_curr'] as const;
export type AutoProjectKind = (typeof AUTO_PROJECT_KINDS)[number];

/** اجرای دستی پروژه‌ی خودکار؛ kind خالی = هر دو نوع (فقط نوع‌های فعال) */
export const runAutoProjectsSchema = z.object({
  kind: z.enum(AUTO_PROJECT_KINDS).optional(),
  /** true = حتی اگر در تنظیمات غیرفعال باشد ساخته شود (کاربر صریحاً «ایجاد» را زده است) */
  force: z.boolean().default(true),
});
export type RunAutoProjectsInput = z.infer<typeof runAutoProjectsSchema>;
