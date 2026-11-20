import type { Pool } from 'pg';
import type { Logger } from 'pino';

export interface SlowQueryEntry {
  queryName: string;
  durationMs: number;
  officeId?: number | undefined;
  route?: string | undefined;
}

export interface SlowQuerySink {
  record(entry: SlowQueryEntry): Promise<void>;
}

/** ثبت در جدول slow_query_log. خطای ثبت هرگز نباید درخواست اصلی را خراب کند. */
export class PgSlowQuerySink implements SlowQuerySink {
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly logger: Logger) {}

  async record(e: SlowQueryEntry): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO slow_query_log (route, query_name, duration_ms, office_id) VALUES ($1, $2, $3, $4)',
        [e.route ?? null, e.queryName, Math.round(e.durationMs), e.officeId ?? null],
      );
    } catch (err) {
      this.logger.warn({ err }, 'failed to persist slow query metric');
    }
  }
}

export type TimedRunner = <T>(
  queryName: string,
  fn: () => Promise<T>,
  ctx?: { officeId?: number; route?: string },
) => Promise<T>;

/** اجرای یک کوئری با اندازه‌گیری زمان؛ اگر از آستانه کندتر بود لاگ و (اختیاری) ثبت می‌شود. */
export function createQueryTimer(opts: {
  logger: Logger;
  thresholdMs: number;
  sink?: SlowQuerySink;
  now?: () => number;
}): TimedRunner {
  const now = opts.now ?? ((): number => performance.now());
  return async (queryName, fn, ctx) => {
    const t0 = now();
    try {
      return await fn();
    } finally {
      const durationMs = now() - t0;
      if (durationMs >= opts.thresholdMs) {
        opts.logger.warn({ queryName, durationMs: Math.round(durationMs), ...ctx }, 'slow query');
        void opts.sink?.record({ queryName, durationMs, officeId: ctx?.officeId, route: ctx?.route });
      }
    }
  };
}
