import { z } from 'zod';
import { idBodySchema, phoneOrNullSchema, textOrNullSchema, textSchema } from './common';

export const createStaffUnitSchema = z.object({ name: textSchema(200), managerName: textOrNullSchema(200) });
export const patchStaffUnitSchema = z.object({
  name: textSchema(200).optional(), managerName: textOrNullSchema(200), isActive: z.boolean().optional(),
});

export const createSupporterSchema = z.object({
  staffUnitId: idBodySchema, fullName: textSchema(200), phone: phoneOrNullSchema,
});
export const patchSupporterSchema = z.object({
  fullName: textSchema(200).optional(), phone: phoneOrNullSchema, isActive: z.boolean().optional(),
});
export const supporterListQuerySchema = z.object({ unitId: z.coerce.number().int().positive().optional() });

export const createBankSchema = z.object({ name: textSchema(200), code: textOrNullSchema(50) });
export const patchBankSchema = z.object({ name: textSchema(200).optional(), code: textOrNullSchema(50) });

export const createRouteGroupSchema = z.object({ name: textSchema(200) });
export const patchRouteGroupSchema = z.object({ name: textSchema(200).optional() });

export type CreateStaffUnitInput = z.infer<typeof createStaffUnitSchema>;
export type PatchStaffUnitInput = z.infer<typeof patchStaffUnitSchema>;
export type CreateSupporterInput = z.infer<typeof createSupporterSchema>;
export type PatchSupporterInput = z.infer<typeof patchSupporterSchema>;
export type CreateBankInput = z.infer<typeof createBankSchema>;
export type PatchBankInput = z.infer<typeof patchBankSchema>;
export type CreateRouteGroupInput = z.infer<typeof createRouteGroupSchema>;
export type PatchRouteGroupInput = z.infer<typeof patchRouteGroupSchema>;

/** ثبت گروهی بانک‌ها (هر مورد: نام و کد اختیاری). موارد تکراری (نرمال‌شده‌ی ی/ک/ارقام) رد می‌شوند. */
export const bulkCreateBanksSchema = z.object({
  items: z.array(z.object({ name: textSchema(200), code: textOrNullSchema(50) })).min(1, 'حداقل یک مورد لازم است').max(500),
});
/** ثبت گروهی مسیرها */
export const bulkCreateRouteGroupsSchema = z.object({ names: z.array(textSchema(200)).min(1, 'حداقل یک مورد لازم است').max(1000) });

export type BulkCreateBanksInput = z.infer<typeof bulkCreateBanksSchema>;
export type BulkCreateRouteGroupsInput = z.infer<typeof bulkCreateRouteGroupsSchema>;
