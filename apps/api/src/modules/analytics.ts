import type { FastifyInstance } from 'fastify';
import {
  alertsQuerySchema, analyticsFilterSchema, dailyDeltasQuerySchema, drilldownQuerySchema, exportQuerySchema,
  growthQuerySchema, heatmapQuerySchema, idParamsSchema, periodQuerySchema, todayInTehran,
} from '@pos/shared';
import {
  cached, getBankShare, getCoverage, getDailyDeltas, getDrilldownTerminals, getGrowth, getHeatmap, getKpi, getTerminalMonthly,
  getTrend, listDroppedTerminals, listPreliminaryAlerts, resolveFilter, xlsxFromRows,
} from '@pos/core';
import { requirePermission, tenantCtx } from '../plugins/auth';
import type { RouteDeps } from './deps';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * API داشبورد: همه‌ی مسیرها روی جدول‌های تجمیع‌شده؛ نتیجه با کلید (فیلتر + نقش + data_version) کش می‌شود.
 * دامنه‌ی نقش در Repository (scopeWhere) اعمال می‌شود و ورودی کاربر آن را گسترش نمی‌دهد.
 */
export async function analyticsRoutes(app: FastifyInstance, { pools, cache }: RouteDeps): Promise<void> {
  const db = pools.read;
  const view = { preHandler: [requirePermission(db, 'analytics.view')] };
  const exporter = { preHandler: [requirePermission(db, 'export.run')] };

  app.get('/analytics/kpi', view, async (req) => {
    const ctx = tenantCtx(req);
    const f = await resolveFilter(ctx, db, analyticsFilterSchema.parse(req.query));
    const today = todayInTehran();
    return cached(cache, db, ctx, 'kpi', { f, today }, () => getKpi(ctx, db, f, today));
  });

  app.get('/analytics/trend', view, async (req) => {
    const ctx = tenantCtx(req);
    const f = await resolveFilter(ctx, db, analyticsFilterSchema.parse(req.query));
    return cached(cache, db, ctx, 'trend', f, () => getTrend(ctx, db, f));
  });

  app.get('/analytics/bank-share', view, async (req) => {
    const ctx = tenantCtx(req);
    const f = await resolveFilter(ctx, db, periodQuerySchema.parse(req.query));
    return cached(cache, db, ctx, 'bank-share', f, () => getBankShare(ctx, db, f));
  });

  app.get('/analytics/growth', view, async (req) => {
    const ctx = tenantCtx(req);
    const q = growthQuerySchema.parse(req.query);
    const f = await resolveFilter(ctx, db, q);
    return cached(cache, db, ctx, 'growth', { f, by: q.by, sort: q.sort }, () => getGrowth(ctx, db, f, q.by, q.sort));
  });

  app.get('/analytics/heatmap', view, async (req) => {
    const ctx = tenantCtx(req);
    const q = heatmapQuerySchema.parse(req.query);
    const f = await resolveFilter(ctx, db, q);
    return cached(cache, db, ctx, 'heatmap', { f, metric: q.metric }, () => getHeatmap(ctx, db, f, q.metric));
  });

  // دفتر ← ستاد ← پشتیبان ← مسیر ← ترمینال: هر سطح با فیلتر والد (unitId / supporterId / routeGroupId)
  app.get('/analytics/drilldown', view, async (req) => {
    const ctx = tenantCtx(req);
    const q = drilldownQuerySchema.parse(req.query);
    const f = await resolveFilter(ctx, db, q);
    if (q.level === 'terminal') {
      return cached(cache, db, ctx, 'drill-terminals', { f, order: q.order, cursor: q.cursor, limit: q.limit },
        () => getDrilldownTerminals(ctx, db, f, q.order, { cursor: q.cursor, limit: q.limit }));
    }
    const by = q.level === 'unit' ? 'unit' : q.level === 'supporter' ? 'supporter' : 'route';
    return cached(cache, db, ctx, 'drill', { f, by }, async () => ({ level: q.level, items: await getGrowth(ctx, db, f, by) }));
  });

  app.get('/analytics/alerts/dropped-terminals', view, async (req) => {
    const ctx = tenantCtx(req);
    const q = alertsQuerySchema.parse(req.query);
    const f = await resolveFilter(ctx, db, q);
    return cached(cache, db, ctx, 'alerts', { f, cursor: q.cursor, limit: q.limit },
      () => listDroppedTerminals(ctx, db, f, { cursor: q.cursor, limit: q.limit }));
  });

  app.get('/analytics/alerts/preliminary', view, async (req) => {
    const ctx = tenantCtx(req);
    const q = alertsQuerySchema.parse(req.query);
    const f = await resolveFilter(ctx, db, q);
    const today = todayInTehran();
    return cached(cache, db, ctx, 'alerts-prelim', { f, today, cursor: q.cursor, limit: q.limit },
      () => listPreliminaryAlerts(ctx, db, f, today, { cursor: q.cursor, limit: q.limit }));
  });

  app.get('/analytics/coverage', view, async (req) => {
    const ctx = tenantCtx(req);
    return cached(cache, db, ctx, 'coverage', {}, () => getCoverage(ctx, db));
  });

  app.get('/terminals/:id/monthly', view, async (req) =>
    getTerminalMonthly(tenantCtx(req), db, idParamsSchema.parse(req.params).id));

  app.get('/terminals/:id/daily-deltas', view, async (req) => {
    const q = dailyDeltasQuerySchema.parse(req.query);
    return getDailyDeltas(tenantCtx(req), db, idParamsSchema.parse(req.params).id, q.from, q.to);
  });

  // خروجی اکسل گزارش‌های کوچک (مستقیم، stream). ترمینال‌ها (بزرگ) از POST /exports می‌آید.
  app.get('/analytics/export', exporter, async (req, reply) => {
    const ctx = tenantCtx(req);
    const q = exportQuerySchema.parse(req.query);
    const f = await resolveFilter(ctx, db, q);
    let sheet: string;
    let header: string[];
    let rows: unknown[][];
    if (q.report === 'trend') {
      sheet = 'Trend';
      header = ['دوره', 'مبلغ', 'تعداد تراکنش', 'فعال', 'کم‌تراکنش', 'برگشتی', 'نوپا', 'ترمینال ناقص'];
      rows = (await getTrend(ctx, db, f)).map((m) => [m.periodId, m.amount, m.txCount, m.activeTerminals, m.lowTerminals, m.returnedTerminals, m.newTerminals, m.incompleteTerminals]);
    } else if (q.report === 'bank-share') {
      sheet = 'BankShare';
      header = ['بانک', 'مبلغ', 'تعداد تراکنش', 'ترمینال', 'سهم (٪)'];
      rows = (await getBankShare(ctx, db, f)).map((b) => [b.name, b.amount, b.txCount, b.terminals, b.sharePct]);
    } else if (q.report === 'growth') {
      sheet = 'Growth';
      header = ['نام', 'مبلغ', 'ماه قبل', 'تغییر ماهانه (٪)', 'سال قبل', 'تغییر سالانه (٪)', 'سهم (٪)', 'ترمینال فعال'];
      rows = (await getGrowth(ctx, db, f, q.by, q.sort)).map((g) => [g.name, g.amount, g.previous, g.momPct ?? '', g.yearAgo, g.yoyPct ?? '', g.sharePct, g.activeTerminals]);
    } else {
      sheet = 'Heatmap';
      const h = await getHeatmap(ctx, db, f, q.metric);
      header = ['پشتیبان', ...h.periods.map(String)];
      rows = h.rows.map((r) => [r.name, ...r.values]);
    }
    return reply
      .header('content-type', XLSX_MIME)
      .header('content-disposition', `attachment; filename="${q.report}.xlsx"`)
      .send(xlsxFromRows(sheet, header, rows));
  });
}
