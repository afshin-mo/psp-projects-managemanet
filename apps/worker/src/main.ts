import {
  EnvError, PgBossQueue, QUEUES, createBoss, createLogger, createPools, createStorage, ensureQueues, ensurePartitionsJob,
  findOfficesWithPendingWork, housekeepingJob, runForecastAll, runForecastJob, loadEnv, pingPool, refreshProgressCurve, refreshProgressCurveAll, runExportBuild, runAggregateOffice, runCommit, runReclassify, runRebuild,
  runAutoProjectsAll, runRolloverAll, runValidate, type AggDeps, type AutoProjectDeps, type ExportDeps, type ForecastDeps, type ImportDeps,
} from '@pos/core';

interface BatchJob { batchId: number }

/**
 * پروسه‌ی Worker (بدون HTTP): ایمپورت (validate/commit)، پارتیشن و نگهداری.
 * چند نمونه از این پروسه را می‌توان هم‌زمان اجرا کرد؛ pg-boss با SKIP LOCKED کار را بین آن‌ها پخش می‌کند
 * و زمان‌بندی‌ها (schedule) فقط یک‌بار اجرا می‌شوند.
 */
async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const logger = createLogger(env, 'worker');
  const pools = createPools(env, logger, 'pos-worker');
  const db = await pingPool(pools.write, 5000);
  if (!db.ok) {
    logger.fatal({ error: db.error }, 'database unreachable');
    process.exit(1);
  }

  const boss = createBoss(env, logger, 'worker');
  await boss.start();
  await ensureQueues(boss);
  const queue = new PgBossQueue(boss);

  const stagingSchema = 'staging';
  const deps: ImportDeps = {
    pool: pools.write, storage: createStorage(env), logger, stagingSchema,
    maxRows: env.IMPORT_MAX_ROWS, vacuumThreshold: env.IMPORT_VACUUM_THRESHOLD,
    // بعد از merge، تجمیع آماری آن دفتر صف می‌شود (یک job فعال/منتظر برای هر دفتر)
    onMerged: ({ officeId }) => queue.enqueue(QUEUES.aggregateOffice, { officeId }, { singletonKey: `agg:${officeId}` }),
  };
  const agg: AggDeps = { pool: pools.write, logger };
  const exp: ExportDeps = { pool: pools.write, storage: deps.storage, logger };
  const fc: ForecastDeps = { pool: pools.write, logger };
  const ap: AutoProjectDeps = { pool: pools.write, logger };

  // ایمپورت‌ها سنگین‌اند؛ تعداد هم‌زمانی با WORKER_CONCURRENCY تنظیم می‌شود
  for (let i = 0; i < env.WORKER_CONCURRENCY; i += 1) {
    await boss.work<BatchJob>(QUEUES.importValidate, async (jobs) => {
      for (const job of jobs) await runValidate(deps, job.data.batchId);
    });
    await boss.work<BatchJob>(QUEUES.importCommit, async (jobs) => {
      for (const job of jobs) await runCommit(deps, job.data.batchId);
    });
  }
  await boss.work<{ officeId: number }>(QUEUES.aggregateOffice, async (jobs) => {
    for (const job of jobs) await runAggregateOffice(agg, job.data.officeId);
  });
  await boss.work<{ officeId: number; fromPeriod?: number }>(QUEUES.activityReclassify, async (jobs) => {
    for (const job of jobs) await runReclassify(agg, job.data.officeId, job.data.fromPeriod ?? 0);
  });
  await boss.work<{ officeId: number; fromPeriod?: number; toPeriod?: number }>(QUEUES.aggregateRebuild, async (jobs) => {
    for (const job of jobs) {
      const { officeId, ...range } = job.data;
      await runRebuild(agg, officeId, range);
    }
  });
  await boss.work<{ jobId: number }>(QUEUES.exportBuild, async (jobs) => {
    for (const job of jobs) await runExportBuild(exp, job.data.jobId);
  });
  await boss.work<{ officeId?: number }>(QUEUES.curveRefresh, async (jobs) => {
    for (const job of jobs) {
      if (job.data.officeId) await refreshProgressCurve(pools.write, logger, job.data.officeId);
      else await refreshProgressCurveAll(pools.write, logger);
    }
  });
  // پیش‌بینی: با runId (درخواست از API) یا بدون آن (زمان‌بندی هفتگی همه‌ی دفترها)
  await boss.work<{ runId?: number }>(QUEUES.forecastRun, async (jobs) => {
    for (const job of jobs) {
      if (job.data.runId) await runForecastJob(fc, job.data.runId);
      else await runForecastAll(fc);
    }
  });
  // پروژه‌های خودکار «فاقد درآمد» (ایدمپوتنت؛ اجرای مکرر فقط ترمینال‌های جدید را اضافه می‌کند)
  await boss.work(QUEUES.projectAuto, async () => { await runAutoProjectsAll(ap); });
  await boss.work(QUEUES.periodRollover, async () => { await runRolloverAll(agg); });
  // شبکه‌ی ایمنی: اگر صف‌کردن تجمیع جایی از دست رفته باشد، کار معوق هر ۵ دقیقه برداشته می‌شود
  await boss.work(QUEUES.aggregateSweep, async () => {
    for (const officeId of await findOfficesWithPendingWork(pools.write)) {
      await queue.enqueue(QUEUES.aggregateOffice, { officeId }, { singletonKey: `agg:${officeId}` });
    }
  });
  await boss.work(QUEUES.partitionEnsure, async () => { await ensurePartitionsJob(pools.write, logger); });
  await boss.work(QUEUES.housekeeping, async () => { await housekeepingJob(pools.write, logger, stagingSchema, deps.storage); });

  await boss.schedule(QUEUES.partitionEnsure, '0 2 * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule(QUEUES.housekeeping, '30 3 * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule(QUEUES.curveRefresh, '0 4 * * 0', {}, { tz: 'Asia/Tehran' });
  await boss.schedule(QUEUES.forecastRun, '30 4 * * 0', {}, { tz: 'Asia/Tehran' });
  await boss.schedule(QUEUES.periodRollover, '15 0 * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule(QUEUES.aggregateSweep, '*/5 * * * *', {}, { tz: 'Asia/Tehran' });
  await boss.schedule(QUEUES.projectAuto, '45 */4 * * *', {}, { tz: 'Asia/Tehran' });
  await boss.send(QUEUES.partitionEnsure, {}, { singletonKey: 'partition-ensure-boot' });

  logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker ready');

  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      logger.info({ signal }, 'shutting down');
      resolve();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });

  await boss.stop();
  await pools.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
