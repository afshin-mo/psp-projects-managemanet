import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  commitSchema, idParamsSchema, importOptionsSchema, importTypeSchema, isImportType, pageQuerySchema,
  profileListQuerySchema, resolveColumnMap, setMappingSchema, todayInTehran, type ImportOptions,
} from '@pos/shared';
import {
  HttpError, QUEUES, buildDefaultTemplate, cancelImportBatch, createErrorReportStream, createImportBatch,
  getImportBatch, latestActiveTemplateFile, listImportBatches, listImportErrors, listImportProfiles,
  listUnknownTerminals, loadBatch, previewImport, readHeaders, requestImportCommit, resolveMapping,
  retryImportBatch, saveImportProfile, setImportMapping,
} from '@pos/core';
import { requirePermission, requireRoles, tenantCtx } from '../plugins/auth';
import type { RouteDeps } from './deps';
import { receiveUpload } from './upload';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const uploadFieldsSchema = z.object({ type: importTypeSchema, options: z.string().max(5000).optional() });

function parseOptions(json: string | undefined): ImportOptions {
  try {
    return importOptionsSchema.parse(json ? JSON.parse(json) : {});
  } catch (err) {
    if (err instanceof z.ZodError) throw err;
    throw new HttpError(400, 'INVALID_OPTIONS', 'گزینه‌ها (options) JSON معتبر نیست');
  }
}

export async function importRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { pools, storage, queue, stagingSchema } = deps;
  const importers = { preHandler: [requirePermission(pools.read, 'imports.manage')] };
  const enqueueValidate = (batchId: number) =>
    queue.enqueue(QUEUES.importValidate, { batchId }, { singletonKey: `validate:${batchId}` });

  // ---- قالب (قبل از مسیرهای :id)
  app.get('/imports/templates/:type', { preHandler: [requireRoles('office_manager', 'data_admin', 'unit_head')] }, async (req, reply) => {
    const type = importTypeSchema.parse((req.params as { type?: unknown }).type);
    const official = await latestActiveTemplateFile(pools.read, type, todayInTehran());
    if (official) {
      const name = encodeURIComponent(official.fileName);
      return reply
        .header('content-type', official.fileName.toLowerCase().endsWith('.csv') ? 'text/csv; charset=utf-8' : XLSX_MIME)
        .header('content-disposition', `attachment; filename*=UTF-8''${name}`)
        .send(await storage.get(official.storageKey));
    }
    return reply
      .header('content-type', XLSX_MIME)
      .header('content-disposition', `attachment; filename="${type}-template.xlsx"`)
      .send(await buildDefaultTemplate(type));
  });

  app.get('/imports/profiles', importers, async (req) =>
    listImportProfiles(tenantCtx(req), pools.read, profileListQuerySchema.parse(req.query).type));

  // ---- آپلود: ذخیره (stream) + بررسی هدر + تطبیق قالب. اگر نگاشت خودکار بود اعتبارسنجی بلافاصله صف می‌شود.
  app.post('/imports', importers, async (req, reply) => {
    const ctx = tenantCtx(req);
    const up = await receiveUpload(req, storage, `imports/${ctx.officeId}`);
    const cleanup = () => storage.delete(up.file.key).catch(() => undefined);
    try {
      const fields = uploadFieldsSchema.parse(up.fields);
      const options = parseOptions(fields.options);

      const headers = await readHeaders(await storage.get(up.file.key), up.file.kind, options.headerRow).catch(() => null);
      if (!headers || headers.every((h) => h === '')) {
        throw new HttpError(422, 'INVALID_FILE', 'فایل خوانده نشد یا سرستون (هدر) در ردیف مشخص‌شده وجود ندارد');
      }
      const resolved = await resolveMapping(pools.write, ctx.officeId, fields.type, headers, todayInTehran());
      const batch = await createImportBatch(ctx, pools.write, {
        type: fields.type, fileName: up.file.name, fileSize: up.file.size, fileHash: up.file.hash, fileKind: up.file.kind,
        storageKey: up.file.key,
        options: { ...options, ...(resolved.auto ? { columnMap: resolved.mapping.columnMap } : {}) },
        status: resolved.auto ? 'uploaded' : 'needs_mapping',
      });
      if (resolved.auto) await enqueueValidate(batch.id);
      return reply.status(201).send({ batch, mapping: resolved.mapping });
    } catch (err) {
      await cleanup();
      throw err;
    }
  });

  app.post('/imports/:id/mapping', importers, async (req) => {
    const ctx = tenantCtx(req);
    const { id } = idParamsSchema.parse(req.params);
    const body = setMappingSchema.parse(req.body);
    await getImportBatch(ctx, pools.write, id); // دسترسی و وجود
    const row = await loadBatch(pools.write, id);
    if (!row || !isImportType(row.type)) throw new HttpError(404, 'NOT_FOUND', 'دسته‌ی ایمپورت یافت نشد');
    if (row.status !== 'needs_mapping' && row.status !== 'failed') throw new HttpError(409, 'INVALID_STATE', 'در این وضعیت امکان تغییر نگاشت نیست');

    const headerRow = importOptionsSchema.parse(row.rawOptions).headerRow;
    const headers = await readHeaders(await storage.get(row.storageKey), row.fileKind, headerRow).catch(() => null);
    if (!headers) throw new HttpError(422, 'INVALID_FILE', 'سرستون فایل خوانده نشد');
    const check = resolveColumnMap(row.type, body.columnMap, headers);
    if (check.missingRequired.length > 0) {
      throw new HttpError(422, 'MAPPING_INVALID', 'ستون‌های الزامی در فایل پیدا نشد', { missingRequired: check.missingRequired });
    }
    if (body.saveProfileName) {
      await saveImportProfile(ctx, pools.write, { type: row.type, name: body.saveProfileName, columnMap: body.columnMap, headers });
    }
    const batch = await setImportMapping(ctx, pools.write, id, body.columnMap);
    await enqueueValidate(id);
    return batch;
  });

  app.get('/imports', importers, async (req) => listImportBatches(tenantCtx(req), pools.read, pageQuerySchema.parse(req.query)));
  app.get('/imports/:id', importers, async (req) =>
    getImportBatch(tenantCtx(req), pools.read, idParamsSchema.parse(req.params).id));

  app.get('/imports/:id/preview', importers, async (req) => {
    const ctx = tenantCtx(req);
    const { id } = idParamsSchema.parse(req.params);
    return {
      batch: await getImportBatch(ctx, pools.read, id),
      rows: await previewImport(ctx, pools.read, id, stagingSchema),
      errors: (await listImportErrors(ctx, pools.read, id, { limit: 50 })).items,
    };
  });

  app.get('/imports/:id/errors', importers, async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    return listImportErrors(tenantCtx(req), pools.read, id, pageQuerySchema.parse(req.query));
  });

  app.get('/imports/:id/errors.xlsx', importers, async (req, reply) => {
    const ctx = tenantCtx(req);
    const { id } = idParamsSchema.parse(req.params);
    await getImportBatch(ctx, pools.read, id); // 404 قبل از شروع stream
    return reply
      .header('content-type', XLSX_MIME)
      .header('content-disposition', `attachment; filename="import-${id}-errors.xlsx"`)
      .send(createErrorReportStream(ctx, pools.read, id));
  });

  app.get('/imports/:id/unknown-terminals', importers, async (req) =>
    listUnknownTerminals(tenantCtx(req), pools.read, idParamsSchema.parse(req.params).id));

  app.post('/imports/:id/commit', importers, async (req) => {
    const ctx = tenantCtx(req);
    const { id } = idParamsSchema.parse(req.params);
    const body = commitSchema.parse(req.body ?? {});
    const batch = await requestImportCommit(ctx, pools.write, id, body.mode);
    await queue.enqueue(QUEUES.importCommit, { batchId: id }, { singletonKey: `commit:${id}` });
    return batch;
  });

  app.post('/imports/:id/cancel', importers, async (req) =>
    cancelImportBatch(tenantCtx(req), pools.write, idParamsSchema.parse(req.params).id));

  app.post('/imports/:id/retry', importers, async (req) => {
    const { id } = idParamsSchema.parse(req.params);
    const batch = await retryImportBatch(tenantCtx(req), pools.write, id);
    await enqueueValidate(id);
    return batch;
  });
}
