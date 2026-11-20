import { z } from 'zod';

export const loginSchema = z.object({
  /** اختیاری؛ فقط اگر یک نام کاربری در چند دفتر وجود داشته باشد لازم می‌شود (پاسخ 409 OFFICE_REQUIRED) */
  officeCode: z.string().trim().min(1).max(50).optional(),
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(200),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8, 'حداقل ۸ کاراکتر').max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;
