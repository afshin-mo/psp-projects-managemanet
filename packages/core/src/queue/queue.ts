import PgBoss from 'pg-boss';
import type { Env } from '../config/env';
import type { Logger } from '../logging/pino';

export const QUEUES = {
  importValidate: 'import.validate',
  importCommit: 'import.commit',
  partitionEnsure: 'partition.ensure',
  housekeeping: 'housekeeping',
  aggregateOffice: 'aggregate.office',
  aggregateRebuild: 'aggregate.rebuild',
  activityReclassify: 'activity.reclassify',
  periodRollover: 'period.rollover',
  aggregateSweep: 'aggregate.sweep',
  exportBuild: 'export.build',
  curveRefresh: 'curve.refresh',
  forecastRun: 'forecast.run',
  projectAuto: 'project.auto',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** رابط ارسال کار (قابل جایگزینی با fake در تست). */
export interface JobQueue {
  enqueue(name: QueueName, data: Record<string, unknown>, opts?: { singletonKey?: string }): Promise<void>;
}

/**
 * فقط این فایل به pg-boss وابسته است. صف روی همان PostgreSQL کار می‌کند (schema جدا، بدون Redis).
 * API فقط ارسال می‌کند (supervise/schedule خاموش)؛ Worker پردازش و زمان‌بندی می‌کند.
 */
export function createBoss(env: Env, logger: Logger, role: 'api' | 'worker'): PgBoss {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: env.PGBOSS_SCHEMA,
    max: role === 'api' ? 3 : 5,
    application_name: `pos-${role}-boss`,
    ...(role === 'api' ? { supervise: false, schedule: false } : {}),
  });
  boss.on('error', (err: Error) => logger.error({ err }, 'pg-boss error'));
  return boss;
}

const QUEUE_OPTIONS: Record<QueueName, { retryLimit: number; retryDelay: number; expireInSeconds: number }> = {
  'import.validate': { retryLimit: 2, retryDelay: 30, expireInSeconds: 3 * 3600 },
  'import.commit': { retryLimit: 1, retryDelay: 30, expireInSeconds: 3 * 3600 },
  'partition.ensure': { retryLimit: 3, retryDelay: 60, expireInSeconds: 600 },
  housekeeping: { retryLimit: 1, retryDelay: 60, expireInSeconds: 1800 },
  'aggregate.office': { retryLimit: 3, retryDelay: 30, expireInSeconds: 3 * 3600 },
  'aggregate.rebuild': { retryLimit: 1, retryDelay: 60, expireInSeconds: 6 * 3600 },
  'activity.reclassify': { retryLimit: 2, retryDelay: 60, expireInSeconds: 3 * 3600 },
  'period.rollover': { retryLimit: 3, retryDelay: 60, expireInSeconds: 3600 },
  'aggregate.sweep': { retryLimit: 1, retryDelay: 30, expireInSeconds: 600 },
  'export.build': { retryLimit: 1, retryDelay: 30, expireInSeconds: 3600 },
  'curve.refresh': { retryLimit: 1, retryDelay: 60, expireInSeconds: 3600 },
  'forecast.run': { retryLimit: 1, retryDelay: 60, expireInSeconds: 3600 },
  'project.auto': { retryLimit: 2, retryDelay: 60, expireInSeconds: 1800 },
};

export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    try {
      await boss.createQueue(name, { name, ...QUEUE_OPTIONS[name] });
    } catch (err) {
      if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
}

export class PgBossQueue implements JobQueue {
  constructor(private readonly boss: PgBoss) {}

  async enqueue(name: QueueName, data: Record<string, unknown>, opts?: { singletonKey?: string }): Promise<void> {
    await this.boss.send(name, data, opts?.singletonKey ? { singletonKey: opts.singletonKey } : {});
  }
}
