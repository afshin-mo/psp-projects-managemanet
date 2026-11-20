import { z } from 'zod';
import { idBodySchema, textSchema } from './common';
import { PERMISSION_KEYS } from '../permissions';

/** null = پیش‌فرض نقش؛ آرایه = فقط همین مجوزها (در سقف نقش) */
const permissionsSchema = z.array(z.enum(PERMISSION_KEYS)).max(40).nullable().optional();

const base = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,64}$/, 'نام کاربری: حروف انگلیسی، عدد و . _ - (حداقل ۳ کاراکتر)'),
  password: z.string().min(8, 'حداقل ۸ کاراکتر').max(200),
  fullName: textSchema(200),
  permissions: permissionsSchema,
});

export const createUserSchema = z.discriminatedUnion('role', [
  base.extend({ role: z.literal('office_manager') }),
  base.extend({ role: z.literal('data_admin') }),
  base.extend({ role: z.literal('unit_head'), staffUnitId: idBodySchema }),
  base.extend({ role: z.literal('supporter'), supporterId: idBodySchema }),
]);

export const patchUserSchema = z.object({
  fullName: textSchema(200).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
  permissions: permissionsSchema,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type PatchUserInput = z.infer<typeof patchUserSchema>;
