import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createLogger, createPools, getBankShare, getCoverage, getDailyDeltas, getDrilldownTerminals, getGrowth, getHeatmap, getKpi,
  getTerminalMonthly, getTrend, listDroppedTerminals, listPreliminaryAlerts, loadEnv, resolveFilter, type Queryable, type TenantContext,
} from '@pos/core';
import { addDaysIso, todayInTehran, type AnalyticsFilterInput } from '@pos/shared';
import { stringArg } from './_args';

/**
 * گزارش عملکرد کوئری‌های داشبورد روی داده‌ی seed:
 *   npm run perf:explain -- --office=seed-large
 * برای هر endpoint: ۱ اجرای گرم‌کردن + ۵ اجرای زمان‌دار (میانه و بیشینه) و سپس یک اجرای EXPLAIN (ANALYZE, BUFFERS)
 * برای همه‌ی SQLهای آن. خروجی: docs/perf-report.md
 */
const code = stringArg('office') ?? 'seed-large';
const env = loadEnv();
const logger = createLogger(env, 'perf');
const pools = createPools(env, logger, 'pos-perf');
const db = pools.read;
const today = todayInTehran();

interface Plan { sql: string; plan: string; execMs: number }

/** Queryable که هر SELECT را قبل از اجرای واقعی با EXPLAIN ANALYZE هم می‌زند */
function explaining(sink: Plan[]): Queryable {
  return {
    async query(text, values) {
      if (/^\s*(SELECT|WITH)/i.test(text)) {
        const r = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${text}`, values);
        const lines = (r.rows as Array<{ 'QUERY PLAN': string }>).map((x) => x['QUERY PLAN']);
        const exec = Number(/Execution Time: ([\d.]+) ms/.exec(lines.join('\n'))?.[1] ?? 0);
        sink.push({ sql: text.replace(/\s+/g, ' ').trim().slice(0, 240), plan: lines.join('\n'), execMs: exec });
      }
      return db.query(text, values);
    },
  };
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

try {
  const office = (await db.query<{ id: number }>('SELECT id FROM offices WHERE code = $1', [code])).rows[0];
  if (!office) throw new Error(`office "${code}" not found; run npm run seed first`);
  const admin: TenantContext = { userId: 0, officeId: office.id, role: 'office_manager', unitId: null, supporterId: null };
  const unit = (await db.query<{ id: number }>('SELECT min(id) AS id FROM staff_units WHERE office_id = $1', [office.id])).rows[0]!.id;
  const head: TenantContext = { ...admin, role: 'unit_head', unitId: unit };
  const sup = (await db.query<{ id: number; unit: number }>('SELECT id, staff_unit_id AS unit FROM supporters WHERE office_id = $1 ORDER BY id LIMIT 1', [office.id])).rows[0]!;
  const term = (await db.query<{ id: number }>('SELECT id FROM terminals WHERE office_id = $1 AND current_supporter_id = $2 ORDER BY id LIMIT 1', [office.id, sup.id])).rows[0]!;

  type Run = (d: Queryable, ctx: TenantContext) => Promise<unknown>;
  const f = (ctx: TenantContext, extra: Partial<AnalyticsFilterInput> = {}) => resolveFilter(ctx, db, extra);
  const cases: Array<{ name: string; targetMs: number; ctx: TenantContext; run: Run }> = [
    { name: 'KPI (دفتر)', targetMs: 1000, ctx: admin, run: async (d, c) => getKpi(c, d, await f(c), today) },
    { name: 'KPI (مسئول ستاد)', targetMs: 1000, ctx: head, run: async (d, c) => getKpi(c, d, await f(c), today) },
    { name: 'روند ۱۲ ماهه', targetMs: 1000, ctx: admin, run: async (d, c) => getTrend(c, d, await f(c)) },
    { name: 'سهم بانک‌ها', targetMs: 1000, ctx: admin, run: async (d, c) => getBankShare(c, d, await f(c)) },
    { name: 'رشد/افت پشتیبان‌ها', targetMs: 1000, ctx: admin, run: async (d, c) => getGrowth(c, d, await f(c), 'supporter') },
    { name: 'رشد/افت مسیرها', targetMs: 1000, ctx: admin, run: async (d, c) => getGrowth(c, d, await f(c), 'route') },
    { name: 'Heatmap پشتیبان×ماه', targetMs: 1000, ctx: admin, run: async (d, c) => getHeatmap(c, d, await f(c), 'amount') },
    { name: 'هشدارهای قطعی افت', targetMs: 1000, ctx: admin, run: async (d, c) => listDroppedTerminals(c, d, await f(c), { limit: 50 }) },
    { name: 'هشدارهای مقدماتی', targetMs: 1000, ctx: admin, run: async (d, c) => listPreliminaryAlerts(c, d, await f(c), today, { limit: 50 }) },
    { name: 'پوشش فایل‌ها', targetMs: 1000, ctx: admin, run: async (d, c) => getCoverage(c, d) },
    { name: 'drill-down: ستاد', targetMs: 2000, ctx: admin, run: async (d, c) => getGrowth(c, d, await f(c), 'unit') },
    { name: 'drill-down: پشتیبان‌های یک ستاد', targetMs: 2000, ctx: admin, run: async (d, c) => getGrowth(c, d, await f(c, { unitId: [sup.unit] }), 'supporter') },
    { name: 'drill-down: مسیرهای یک پشتیبان', targetMs: 2000, ctx: admin, run: async (d, c) => getGrowth(c, d, await f(c, { supporterId: [sup.id] }), 'route') },
    { name: 'drill-down: ترمینال‌های یک پشتیبان', targetMs: 2000, ctx: admin, run: async (d, c) => getDrilldownTerminals(c, d, await f(c, { supporterId: [sup.id] }), 'amount_desc', { limit: 50 }) },
    { name: 'drill-down: ترمینال‌های یک ستاد', targetMs: 2000, ctx: admin, run: async (d, c) => getDrilldownTerminals(c, d, await f(c, { unitId: [sup.unit] }), 'amount_desc', { limit: 50 }) },
    { name: 'سری ماهانه‌ی یک ترمینال', targetMs: 2000, ctx: admin, run: async (d, c) => getTerminalMonthly(c, d, term.id) },
    { name: 'تفاضل روزانه‌ی یک ترمینال (۶۰ روز از جدول خام)', targetMs: 2000, ctx: admin, run: (d, c) => getDailyDeltas(c, d, term.id, addDaysIso(today, -60), today) },
  ];

  const rows: string[] = [];
  const appendix: string[] = [];
  let failed = 0;
  for (const c of cases) {
    const run = async () => { const t = performance.now(); await c.run(db, c.ctx).catch((e: unknown) => { throw new Error(`${c.name}: ${e instanceof Error ? e.message : String(e)}`); }); return performance.now() - t; };
    await run(); // گرم‌کردن کش PostgreSQL
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) times.push(await run());
    const plans: Plan[] = [];
    await c.run(explaining(plans), c.ctx);
    const med = median(times);
    const ok = med <= c.targetMs;
    if (!ok) failed += 1;
    rows.push(`| ${c.name} | ${med.toFixed(0)} | ${Math.max(...times).toFixed(0)} | ${c.targetMs} | ${ok ? '✅' : '❌'} | ${plans.length} |`);
    appendix.push(`### ${c.name}\n\n${plans.map((p, i) => `**SQL ${i + 1}** (${p.execMs.toFixed(1)} ms): \`${p.sql}\`\n\n\`\`\`\n${p.plan}\n\`\`\``).join('\n\n')}\n`);
    console.log(`${ok ? 'OK  ' : 'SLOW'} ${c.name}: median ${med.toFixed(0)} ms`);
  }

  const sizes = (await db.query<{ t: string; size: string; rows: number }>(
    `SELECT c.relname AS t, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, c.reltuples::bigint AS rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
        AND c.relname IN ('terminals', 'transactions_snapshot', 'fact_terminal_month', 'agg_supporter_month', 'agg_unit_month', 'agg_office_month', 'terminal_alerts')
      ORDER BY pg_total_relation_size(c.oid) DESC`)).rows;
  const counts = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM terminals WHERE office_id = $1', [office.id])).rows[0]!.n;

  const md = `# گزارش عملکرد کوئری‌های داشبورد

- دفتر: \`${code}\` (${counts} ترمینال) · تاریخ اجرا: ${today}
- روش: هر endpoint یک بار گرم‌کردن + ۵ اجرا؛ میانه و بیشینه‌ی زمان کل (شامل تمام کوئری‌های آن endpoint، بدون کش آماری).
- اهداف: داشبورد/KPI زیر ۱٬۰۰۰ms، drill-down زیر ۲٬۰۰۰ms.

| Endpoint | میانه (ms) | بیشینه (ms) | هدف (ms) | نتیجه | تعداد SQL |
|---|---:|---:|---:|:---:|---:|
${rows.join('\n')}

## اندازه‌ی جدول‌ها

| جدول | حجم کل | ردیف (تخمینی) |
|---|---:|---:|
${sizes.map((s) => `| ${s.t} | ${s.size} | ${s.rows} |`).join('\n')}

## پیوست: EXPLAIN (ANALYZE, BUFFERS)

${appendix.join('\n')}`;
  await mkdir('docs', { recursive: true });
  await writeFile(path.join('docs', 'perf-report.md'), md, 'utf8');
  console.log(`\nگزارش: docs/perf-report.md  (${failed === 0 ? 'همه‌ی اهداف برآورده شد' : `${failed} مورد کندتر از هدف`})`);
  process.exitCode = failed === 0 ? 0 : 2;
} catch (err) {
  logger.error({ err }, 'perf report failed');
  process.exitCode = 1;
} finally {
  await pools.close();
}
