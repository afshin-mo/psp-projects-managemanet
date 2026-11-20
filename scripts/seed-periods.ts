import { createLogger, createPools, ensureAuditPartitions, ensureSnapshotPartitions, loadEnv, seedPeriods } from '@pos/core';

/**
 * استفاده: npm run db:seed-periods -- --from=1398 --to=1420 --back=6 --ahead=3
 *   from/to : بازه‌ی سال‌های شمسی برای جدول periods
 *   back/ahead : تعداد ماه قبل/بعد از امروز که پارتیشن transactions_snapshot برایشان ساخته شود
 */
function arg(name: string, def: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  const v = a ? Number(a.split('=')[1]) : def;
  if (!Number.isInteger(v) || v < 0) throw new Error(`--${name} must be a non-negative integer`);
  return v;
}

const env = loadEnv();
const logger = createLogger(env, 'seed-periods');
const pools = createPools(env, logger, 'pos-seed');

try {
  const inserted = await seedPeriods(pools.write, arg('from', 1398), arg('to', 1420));
  const parts = await ensureSnapshotPartitions(
    pools.write, new Date().toISOString().slice(0, 10), arg('back', 6), arg('ahead', 3));
  const audit = await ensureAuditPartitions(pools.write, new Date().toISOString().slice(0, 10), 1, 3);
  logger.info({ insertedPeriods: inserted, partitions: parts.length, auditPartitions: audit.length }, 'periods & partitions ready');
} catch (err) {
  logger.error({ err }, 'seed-periods failed');
  process.exitCode = 1;
} finally {
  await pools.close();
}
