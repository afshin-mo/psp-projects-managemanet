import { z } from 'zod';
import { idParamSchema } from './common';

export const forecastScopeSchema = z.enum(['office', 'unit', 'supporter']);

export const forecastQuerySchema = z.object({
  scope: forecastScopeSchema.default('office'),
  /** شناسه‌ی ستاد/پشتیبان؛ برای scope=office لازم نیست */
  id: idParamSchema.optional(),
});

export const forecastSummaryQuerySchema = z.object({ scope: z.enum(['unit', 'supporter']).default('supporter') });

export const runForecastSchema = z.object({ horizon: z.number().int().min(1).max(12).default(6) });

export type ForecastQuery = z.infer<typeof forecastQuerySchema>;
export type RunForecastInput = z.infer<typeof runForecastSchema>;
