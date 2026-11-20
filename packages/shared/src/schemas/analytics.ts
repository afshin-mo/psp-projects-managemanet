import { z } from 'zod';
import { isValidPeriodId } from '../periods/periods';
import { idParamSchema, isoDateSchema, limitSchema } from './common';

export const periodIdSchema = z.coerce.number().int().refine(isValidPeriodId, 'شناسه‌ی دوره نامعتبر است');

/** لیست شناسه‌ها در کوئری: «1,2,3» */
const idList = (min: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.split(',').map((x) => Number(x.trim()))) : v),
    z.array(z.number().int().min(min)).min(1).max(200).optional(),
  );

export const analyticsFilterSchema = z.object({
  from: periodIdSchema.optional(),
  to: periodIdSchema.optional(),
  unitId: idList(1),
  supporterId: idList(1),
  routeGroupId: idList(0), // ۰ = مسیر نامشخص
  bankId: idList(0),
});

export const periodQuerySchema = analyticsFilterSchema.extend({ period: periodIdSchema.optional() });

export const growthQuerySchema = periodQuerySchema.extend({
  by: z.enum(['supporter', 'route', 'unit']).default('supporter'),
  sort: z.enum(['amount_desc', 'pct_desc', 'pct_asc']).default('amount_desc'),
});

export const heatmapQuerySchema = analyticsFilterSchema.extend({
  metric: z.enum(['amount', 'txCount', 'active']).default('amount'),
});

export const drilldownQuerySchema = periodQuerySchema.extend({
  level: z.enum(['unit', 'supporter', 'route', 'terminal']),
  order: z.enum(['id', 'amount_desc']).default('id'),
  cursor: z.string().max(500).optional(),
  limit: limitSchema,
});

export const alertsQuerySchema = periodQuerySchema.extend({ cursor: z.string().max(500).optional(), limit: limitSchema });

export const exportQuerySchema = growthQuerySchema.extend({
  report: z.enum(['trend', 'bank-share', 'growth', 'heatmap']),
  metric: z.enum(['amount', 'txCount', 'active']).default('amount'),
});

export const dailyDeltasQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema });

const idArray = z.array(z.number().int().min(0)).max(200).optional();
export const createExportSchema = z.object({
  kind: z.literal('terminals_month'),
  period: periodIdSchema.optional(),
  unitIds: idArray,
  supporterIds: idArray,
  routeGroupIds: idArray,
  bankIds: idArray,
});

export const exportIdSchema = z.object({ id: idParamSchema });

export type AnalyticsFilterInput = z.infer<typeof analyticsFilterSchema>;
export type GrowthQuery = z.infer<typeof growthQuerySchema>;
export type DrilldownQuery = z.infer<typeof drilldownQuerySchema>;
export type CreateExportInput = z.infer<typeof createExportSchema>;
