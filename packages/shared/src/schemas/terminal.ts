import { z } from 'zod';
import { normalizeTerminalNo } from '../normalize/text';
import {
  idBodySchema, isoDateSchema, limitSchema, phoneOrNullSchema, textOrNullSchema,
} from './common';

export const terminalNoSchema = z
  .string()
  .transform(normalizeTerminalNo)
  .refine((v) => v.length >= 1 && v.length <= 32, 'شماره ترمینال نامعتبر است');

const nullableId = idBodySchema.nullable().optional();

export const createTerminalSchema = z.object({
  terminalNo: terminalNoSchema,
  ownerName: textOrNullSchema(200),
  phone: phoneOrNullSchema,
  address: textOrNullSchema(500),
  shopName: textOrNullSchema(200),
  routeGroupId: nullableId,
  bankId: nullableId,
  supporterId: idBodySchema,
  installedAt: isoDateSchema.nullable().optional(),
  /** شروع اعتبار پشتیبان اولیه؛ پیش‌فرض: تاریخ نصب، وگرنه ۲۰۰۰-۰۱-۰۱ (تا ماه‌های قدیمی هم پشتیبان داشته باشند) */
  assignedFrom: isoDateSchema.optional(),
});

export const patchTerminalSchema = z.object({
  ownerName: textOrNullSchema(200),
  phone: phoneOrNullSchema,
  address: textOrNullSchema(500),
  shopName: textOrNullSchema(200),
  installedAt: isoDateSchema.nullable().optional(),
});

export const assignmentSchema = z
  .object({
    supporterId: idBodySchema.optional(),
    routeGroupId: nullableId,
    bankId: nullableId,
    /** پیش‌فرض: امروز (به وقت تهران). UI تاریخ را از کاربر می‌پرسد. */
    effectiveDate: isoDateSchema.optional(),
  })
  .refine(
    (v) => v.supporterId !== undefined || v.routeGroupId !== undefined || v.bankId !== undefined,
    'حداقل یک تغییر لازم است',
  );

export const terminalListQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: limitSchema,
  q: z.string().trim().max(100).optional(),
  supporterId: z.coerce.number().int().positive().optional(),
  unitId: z.coerce.number().int().positive().optional(),
  routeGroupId: z.coerce.number().int().positive().optional(),
  bankId: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'returned']).optional(),
});

export const pageQuerySchema = z.object({ cursor: z.string().max(500).optional(), limit: limitSchema });

export type CreateTerminalInput = z.infer<typeof createTerminalSchema>;
export type PatchTerminalInput = z.infer<typeof patchTerminalSchema>;
export type AssignmentInput = z.infer<typeof assignmentSchema>;
export type TerminalListQuery = z.infer<typeof terminalListQuerySchema>;
export type PageQuery = z.infer<typeof pageQuerySchema>;

// ---------------------------------------------------------------- فاز ۵: انصراف، ویرایش گروهی، انتقال

/** ثبت انصراف/برگشت ترمینال. returnedAt پیش‌فرض: امروز (تهران) */
export const returnTerminalSchema = z.object({
  returnedAt: isoDateSchema.optional(),
  reason: textOrNullSchema(300),
});

/** لغو انصراف (ثبت اشتباه) */
export const reactivateTerminalSchema = z.object({ reason: textOrNullSchema(300) });

/** تعویض گروهی پشتیبان/مسیر/بانک؛ «همه یا هیچ» (یک خطا کل عملیات را برمی‌گرداند) */
export const bulkAssignSchema = z
  .object({
    terminalIds: z.array(idBodySchema).min(1).max(1000),
    supporterId: idBodySchema.optional(),
    routeGroupId: nullableId,
    bankId: nullableId,
    effectiveDate: isoDateSchema.optional(),
  })
  .refine(
    (v) => v.supporterId !== undefined || v.routeGroupId !== undefined || v.bankId !== undefined,
    'حداقل یک تغییر لازم است',
  );

/** انتقال یک پشتیبان به ستاد دیگر (همراه همه‌ی ترمینال‌های فعلی‌اش) */
export const transferSupporterUnitSchema = z.object({
  toUnitId: idBodySchema,
  effectiveDate: isoDateSchema.optional(),
});

/** انتقال ترمینال‌های یک پشتیبان (همه یا انتخابی) به پشتیبان دیگر (ممکن است در ستاد دیگری باشد) */
export const transferTerminalsSchema = z.object({
  toSupporterId: idBodySchema,
  terminalIds: z.array(idBodySchema).min(1).max(20_000).optional(),
  effectiveDate: isoDateSchema.optional(),
});

export type ReturnTerminalInput = z.infer<typeof returnTerminalSchema>;
export type ReactivateTerminalInput = z.infer<typeof reactivateTerminalSchema>;
export type BulkAssignInput = z.infer<typeof bulkAssignSchema>;
export type TransferSupporterUnitInput = z.infer<typeof transferSupporterUnitSchema>;
export type TransferTerminalsInput = z.infer<typeof transferTerminalsSchema>;

/** جستجوی هم‌زمان چند شماره ترمینال (چسباندن از اکسل/فهرست). شماره‌ها نرمال و تکراری‌ها حذف می‌شوند. */
export const lookupTerminalsSchema = z.object({
  terminalNos: z.array(z.string().max(64)).min(1, 'حداقل یک شماره لازم است').max(5000)
    .transform((a) => [...new Set(a.map(normalizeTerminalNo).filter((v) => v.length >= 1 && v.length <= 32))]),
}).refine((v) => v.terminalNos.length > 0, 'شماره‌ی معتبری پیدا نشد');
export type LookupTerminalsInput = z.infer<typeof lookupTerminalsSchema>;
