import { resolveColumnMap } from '@pos/shared';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { csvLine } from './csv';
import { isBlankRow, readHeaders, readRows } from './reader';
import { BatchError } from './types';
import { buildCtx, failBatch, handlerFor, loadBatch, loadLookups, type ImportDeps } from './batches';

const MAX_STORED_ERRORS = 50_000;

function counted(src: Readable, onBytes: (n: number) => void): Readable {
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
  pipeline(src, t).catch(() => undefined);
  return t;
}

/**
 * مرحله‌ی ۱ ایمپورت (در Worker): فایل → staging (COPY) → اعتبارسنجی set-based → گزارش خطا.
 * ایدمپوتنت است: اجرای دوباره (retry) staging و خطاها را از نو می‌سازد.
 */
export async function runValidate(deps: ImportDeps, batchId: number): Promise<void> {
  const { pool, storage, logger } = deps;
  const batch = await loadBatch(pool, batchId);
  if (!batch || !['uploaded', 'validating', 'failed'].includes(batch.status)) return; // job کهنه/تکراری

  const handler = handlerFor(batch.type);
  await pool.query(
    `UPDATE import_batches SET status = 'validating', stage = 'reading', progress = 0, started_at = now(), finished_at = NULL,
            error_summary = NULL, attempts = attempts + 1, total_rows = NULL, valid_rows = NULL, error_rows = NULL, skipped_rows = NULL
      WHERE id = $1`, [batchId]);
  await pool.query('DELETE FROM import_batch_errors WHERE batch_id = $1', [batchId]);
  await pool.query('DELETE FROM import_unknown_terminals WHERE batch_id = $1', [batchId]);

  const lookups = batch.type === 'terminals'
    ? await loadLookups(pool, batch.officeId)
    : { supporters: new Map(), banks: new Map(), routes: new Map() };
  const ctx = buildCtx(batch, deps, lookups);
  const table = ctx.table;
  const headerRow = ctx.options.headerRow;

  const client = await pool.connect();
  let failure: unknown;
  try {
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    await client.query(handler.createTableSql(table));

    const headers = await readHeaders(await storage.get(batch.storageKey), batch.fileKind, headerRow);
    if (!headers) throw new BatchError('HEADER_NOT_FOUND', `ردیف سرستون (${headerRow}) در فایل پیدا نشد`);
    const resolved = resolveColumnMap(batch.type, ctx.columnMap, headers);
    if (resolved.missingRequired.length > 0) {
      throw new BatchError('MAPPING_INVALID', `ستون‌های الزامی در فایل پیدا نشد: ${resolved.missingRequired.join(', ')}`);
    }
    await handler.prepare(client, ctx, resolved.indexes);

    // ---- فایل → COPY
    let bytes = 0;
    let rows = 0;
    let lastProgress = Date.now();
    const source = counted(await storage.get(batch.storageKey), (n) => { bytes += n; });
    const fieldKeys = Object.keys(resolved.indexes);

    async function* lines(): AsyncGenerator<string> {
      for await (const row of readRows(source, batch!.fileKind)) {
        if (row.rowNo <= headerRow) continue;
        if (isBlankRow(row.cells)) continue;
        rows += 1;
        if (rows > deps.maxRows) throw new BatchError('TOO_MANY_ROWS', `تعداد ردیف‌ها از سقف مجاز (${deps.maxRows}) بیشتر است`);
        const raw: Record<string, unknown> = {};
        for (const key of fieldKeys) raw[key] = row.cells[resolved.indexes[key] as number];
        yield csvLine(handler.toRow(row.rowNo, raw, ctx));
        if (Date.now() - lastProgress > 2000) {
          lastProgress = Date.now();
          const pct = Math.min(80, Math.floor((bytes / Math.max(1, batch!.fileSize)) * 80));
          void pool.query('UPDATE import_batches SET progress = $2, stage = $3 WHERE id = $1', [batchId, pct, `reading ${rows}`]).catch(() => undefined);
        }
      }
    }
    const copy = client.query(copyFrom(`COPY ${table} (${handler.copyColumns.join(', ')}) FROM STDIN WITH (FORMAT csv)`));
    await pipeline(Readable.from(lines()), copy);
    if (rows === 0) throw new BatchError('EMPTY_FILE', 'فایل هیچ ردیف داده‌ای ندارد');

    await pool.query('UPDATE import_batches SET progress = 82, stage = $2 WHERE id = $1', [batchId, 'indexing']);
    for (const sql of handler.indexSql(table)) await client.query(sql);
    await client.query(`ANALYZE ${table}`); // بدون آمار، planner روی staging تازه‌ساخته‌شده بد برنامه می‌ریزد

    await pool.query('UPDATE import_batches SET progress = 88, stage = $2 WHERE id = $1', [batchId, 'validating']);
    const outcome = await handler.validate(client, ctx);

    // ---- گزارش
    await client.query(
      `INSERT INTO import_batch_errors (batch_id, row_no, column_name, code, message)
       SELECT $1, row_no, err_col, err_code, err_msg FROM ${table} WHERE err_code IS NOT NULL ORDER BY row_no LIMIT ${MAX_STORED_ERRORS}`,
      [batchId]);
    const counts = (await client.query<{ total: number; errors: number; skipped: number }>(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE err_code IS NOT NULL))::int AS errors,
              (count(*) FILTER (WHERE skipped AND err_code IS NULL))::int AS skipped FROM ${table}`)).rows[0];
    const byCode = (await client.query<{ code: string; n: number }>(
      `SELECT err_code AS code, count(*)::int AS n FROM ${table} WHERE err_code IS NOT NULL GROUP BY 1 ORDER BY n DESC`)).rows;
    const total = counts?.total ?? 0;
    const errors = counts?.errors ?? 0;
    const skipped = counts?.skipped ?? 0;

    await pool.query(
      `UPDATE import_batches SET status = 'validated', stage = 'validated', progress = 100, total_rows = $2, error_rows = $3,
              skipped_rows = $4, valid_rows = $5, error_summary = $6::jsonb WHERE id = $1`,
      [batchId, total, errors, skipped, total - errors - skipped, JSON.stringify({
        byCode: Object.fromEntries(byCode.map((r) => [r.code, r.n])),
        warnings: outcome.warnings, errorsTruncated: errors > MAX_STORED_ERRORS,
      })]);
    logger.info({ batchId, total, errors, skipped }, 'import validated');
  } catch (err) {
    failure = err;
    if (err instanceof BatchError) {
      await failBatch(pool, batchId, err.code, err.message, 'validate');
      failure = undefined; // خطای قطعی؛ retry خودکار لازم نیست
    } else {
      await failBatch(pool, batchId, 'INTERNAL', err instanceof Error ? err.message : String(err), 'validate');
      throw err;
    }
  } finally {
    client.release(failure !== undefined);
  }
}

