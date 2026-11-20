import { BatchError, type CommitMode } from './types';
import { buildCtx, failBatch, handlerFor, loadBatch, type ImportDeps } from './batches';

/**
 * مرحله‌ی ۲ ایمپورت: merge در «یک transaction». اگر هر چیز خطا بدهد rollback کامل و وضعیت failed.
 * سریال‌سازی: برای هر دفتر در هر لحظه فقط یک merge (advisory lock).
 */
export async function runCommit(deps: ImportDeps, batchId: number): Promise<void> {
  const { pool, logger } = deps;
  const batch = await loadBatch(pool, batchId);
  if (!batch || batch.status !== 'committing') return; // job کهنه/تکراری (مثلاً بعد از موفقیت)

  const handler = handlerFor(batch.type);
  const ctx = buildCtx(batch, deps, { supporters: new Map(), banks: new Map(), routes: new Map() });
  const mode: CommitMode = batch.rawOptions.commitMode === 'skip_invalid' ? 'skip_invalid' : 'strict';

  const exists = await pool.query<{ r: string | null }>('SELECT to_regclass($1)::text AS r', [ctx.table]);
  if (!exists.rows[0]?.r) {
    await failBatch(pool, batchId, 'STAGING_MISSING', 'داده‌ی موقت اعتبارسنجی پاک شده است؛ دسته را دوباره اعتبارسنجی کنید', 'commit');
    return;
  }

  await pool.query(`UPDATE import_batches SET stage = 'merging', progress = 10 WHERE id = $1`, [batchId]);
  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`import-merge:${batch.officeId}`]);

    const before = Number(((await client.query(`SELECT count(*)::int AS n FROM ${ctx.table} WHERE err_code IS NOT NULL`)).rows[0] as { n: number }).n);
    await handler.recheck(client, ctx);
    const after = Number(((await client.query(`SELECT count(*)::int AS n FROM ${ctx.table} WHERE err_code IS NOT NULL`)).rows[0] as { n: number }).n);
    if (mode === 'strict' && after > before) {
      throw new BatchError('STALE_VALIDATION', 'از زمان اعتبارسنجی، داده‌ی دیتابیس تغییر کرده و ناسازگاری ایجاد شده است؛ دوباره اعتبارسنجی کنید');
    }

    const stats = await handler.merge(client, ctx);
    await client.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [batch.officeId]); // بی‌اعتبارکردن کش
    // با تجمیع فعال (Worker) دسته در وضعیت aggregating می‌ماند تا job تجمیع آن را کامل کند
    const finalStatus = deps.onMerged ? 'aggregating' : 'completed';
    await client.query(
      `UPDATE import_batches SET status = $5::text,
              stage = CASE WHEN $5::text = 'completed' THEN 'merged' ELSE 'aggregating' END,
              progress = CASE WHEN $5::text = 'completed' THEN 100 ELSE 90 END,
              inserted_rows = $2, updated_rows = $3, unchanged_rows = $4, merge_summary = $6::jsonb,
              error_rows = (SELECT count(*)::int FROM ${ctx.table} WHERE err_code IS NOT NULL),
              finished_at = CASE WHEN $5::text = 'completed' THEN now() ELSE NULL END
        WHERE id = $1`, [batchId, stats.inserted, stats.updated, stats.unchanged, finalStatus, stats.extra ? JSON.stringify(stats.extra) : null]);
    await client.query('COMMIT');
    logger.info({ batchId, ...stats }, 'import merged');
    if (deps.onMerged) {
      try {
        await deps.onMerged({ officeId: batch.officeId, batchId });
      } catch (err) {
        logger.warn({ err, batchId }, 'could not enqueue aggregation (the sweep job will retry)');
      }
    }

    await client.query(`DROP TABLE IF EXISTS ${ctx.table}`).catch(() => undefined);
    if (stats.inserted + stats.updated >= deps.vacuumThreshold) {
      const target = batch.type === 'terminals' ? 'terminals' : 'transactions_snapshot';
      await pool.query(`VACUUM (ANALYZE) ${target}`).catch((err: unknown) => logger.warn({ err }, 'post-import vacuum failed'));
    }
  } catch (err) {
    failure = err;
    await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof BatchError) {
      await failBatch(pool, batchId, err.code, err.message, 'commit');
      failure = undefined;
    } else {
      await failBatch(pool, batchId, 'MERGE_FAILED', err instanceof Error ? err.message : String(err), 'commit');
      throw err;
    }
  } finally {
    client.release(failure !== undefined);
  }
}
