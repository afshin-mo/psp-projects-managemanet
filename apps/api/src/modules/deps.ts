import type pg from 'pg';
import { QUEUES, type CacheProvider, type Env, type JobQueue, type Logger, type StorageProvider } from '@pos/core';

export interface RouteDeps {
  env: Env;
  logger: Logger;
  pools: { write: pg.Pool; read: pg.Pool; hasReplica: boolean };
  storage: StorageProvider;
  queue: JobQueue;
  cache: CacheProvider;
  /** schema جدول‌های staging ایمپورت (پیش‌فرض: staging) */
  stagingSchema: string;
}

/** درخواست تجمیع دفتر؛ شکست صف نباید عملیات اصلی را خراب کند (job پشتیبان sweep کار معوق را برمی‌دارد) */
export function kickAggregation(queue: JobQueue, officeId: number): void {
  queue.enqueue(QUEUES.aggregateOffice, { officeId }, { singletonKey: `agg:${officeId}` }).catch(() => undefined);
}
