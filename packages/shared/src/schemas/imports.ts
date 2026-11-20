import { z } from 'zod';
import { IMPORT_TYPES } from '../imports/registry';
import { isoDateSchema, textSchema } from './common';

export const importTypeSchema = z.enum(IMPORT_TYPES);

export const columnMapSchema = z.record(z.string().min(1).max(60), z.string().min(1).max(200));

/** گزینه‌های آپلود (JSON در فیلد multipart با نام options) */
export const importOptionsSchema = z.object({
  headerRow: z.number().int().min(1).max(50).default(1),
  calendar: z.enum(['auto', 'jalali', 'gregorian']).default('auto'),
  /** تاریخ فایل (برای transactions_cumulative وقتی ستون تاریخ در فایل نیست) */
  asOfDate: isoDateSchema.optional(),
  /** تاریخ اعمال تغییر پشتیبان/مسیر/بانک در ایمپورت ترمینال؛ پیش‌فرض: امروز */
  effectiveDate: isoDateSchema.optional(),
  /** monthly: فایل پایان ماه (snapshot آخرین روز ماه، منبع=۲)؛ نیازمند periodId */
  source: z.enum(['daily', 'monthly']).default('daily'),
  periodId: z.number().int().min(100001).max(999912).optional(),
});
export type ImportOptions = z.infer<typeof importOptionsSchema>;

export const setMappingSchema = z.object({
  columnMap: columnMapSchema,
  /** اگر داده شود، نگاشت به‌عنوان پروفایل دفتر ذخیره می‌شود */
  saveProfileName: textSchema(100).optional(),
});

export const commitSchema = z.object({ mode: z.enum(['strict', 'skip_invalid']).default('strict') });

export const profileListQuerySchema = z.object({ type: importTypeSchema.optional() });

export const createTemplateFieldsSchema = z.object({
  type: importTypeSchema,
  options: z.string().optional(),
  note: z.string().max(500).optional(),
});

export const patchTemplateSchema = z.object({
  isActive: z.boolean().optional(),
  columnMap: columnMapSchema.optional(),
  effectiveFrom: isoDateSchema.optional(),
  note: z.string().max(500).optional(),
});

export type ColumnMapInput = z.infer<typeof columnMapSchema>;
export type SetMappingInput = z.infer<typeof setMappingSchema>;
export type CommitInput = z.infer<typeof commitSchema>;
export type PatchTemplateInput = z.infer<typeof patchTemplateSchema>;
