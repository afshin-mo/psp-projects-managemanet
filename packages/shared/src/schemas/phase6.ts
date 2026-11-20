import { z } from 'zod';
import { idBodySchema, limitSchema } from './common';
import { terminalNoSchema } from './terminal';

const boolQuery = z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v), z.boolean());

export const pendingListQuerySchema = z.object({
  status: z.enum(['pending', 'dismissed']).default('pending'),
  /** فقط ترمینال‌هایی که در فایل مبلغ خرید یا کل > ۰ دارند */
  activeOnly: boolQuery.default(true),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(500).optional(),
  limit: limitSchema,
});

/**
 * تعیین پشتیبان برای ترمینال‌های تعریف‌نشده. ترمینال با اطلاعات فایل (نام فروشگاه، مالک، موبایل، آدرس، بانک) ساخته
 * و ردیف‌های تراکنش نگه‌داشته‌شده‌اش وارد آمار می‌شود.
 * bankId خالی = بانک از روی نام بانک فایل (در صورت نبودن، طبق تنظیمات دفتر ساخته می‌شود یا بدون بانک می‌ماند).
 */
export const assignPendingSchema = z.object({
  terminalNos: z.array(terminalNoSchema).min(1).max(2000),
  supporterId: idBodySchema,
  routeGroupId: idBodySchema.nullable().optional(),
  bankId: idBodySchema.nullable().optional(),
});

export const dismissPendingSchema = z.object({
  terminalNos: z.array(terminalNoSchema).min(1).max(2000),
  /** false = بازگرداندن از «نادیده‌گرفته‌شده‌ها» به فهرست */
  dismissed: z.boolean().default(true),
});

export const scoreQuerySchema = z.object({
  /** تعداد ماه کامل اخیر برای امتیاز (پیش‌فرض ۶) */
  months: z.coerce.number().int().min(1).max(24).default(6),
  /** ماه پایان بازه؛ پیش‌فرض آخرین ماه کامل */
  to: z.coerce.number().int().min(100001).max(999912).optional(),
  unitId: z.coerce.number().int().positive().optional(),
  supporterId: z.coerce.number().int().positive().optional(),
});

export type PendingListQuery = z.infer<typeof pendingListQuerySchema>;
export type AssignPendingInput = z.infer<typeof assignPendingSchema>;
export type DismissPendingInput = z.infer<typeof dismissPendingSchema>;
export type ScoreQuery = z.infer<typeof scoreQuerySchema>;
