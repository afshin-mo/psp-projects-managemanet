import { z } from 'zod';
import { isValidIsoDate } from '../dates';
import { toEnglishDigits as normalizeDigits } from '../normalize/text';

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'تاریخ باید به شکل YYYY-MM-DD باشد')
  .refine(isValidIsoDate, 'تاریخ نامعتبر است');

/** شناسه در مسیر/کوئری (رشته→عدد) */
export const idParamSchema = z.coerce.number().int().positive();
export const idParamsSchema = z.object({ id: idParamSchema });

/** شناسه در بدنه‌ی JSON */
export const idBodySchema = z.number().int().positive();

export const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

export const textSchema = (max: number) => z.string().trim().min(1, 'الزامی است').max(max);

/** رشته‌ی اختیاری؛ رشته‌ی خالی = null */
export const textOrNullSchema = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

export const phoneOrNullSchema = z
  .string()
  .trim()
  .max(30)
  .transform((v) => (v === '' ? null : normalizeDigits(v).replace(/[\s-]/g, '')))
  .nullable()
  .optional();
