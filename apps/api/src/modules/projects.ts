import type { FastifyInstance } from 'fastify';
import {
  addProjectTerminalsSchema, bulkStatusSchema, createProjectSchema, patchProjectSchema, projectListQuerySchema,
  projectParamsSchema, projectTerminalParamsSchema, projectTerminalsQuerySchema, removeProjectTerminalsSchema,
  setTerminalStatusSchema, todayInTehran, PROJECT_TERMINAL_STATUS_FA, type ProjectImportResultDto,
} from '@pos/shared';
import {
  HttpError, addProjectTerminals, bulkSetProjectTerminalStatus, createProject, getProject, getProjectProgress,
  getProjectTrend, getProjectsMatrix, listProjectAlerts, listProjectTerminals, listProjects, parseProjectTerminalFile, patchProject,
  removeProjectTerminals, setProjectTerminalStatus, xlsxFromRows, type ProjectTerminalRowInput,
} from '@pos/core';
import { requirePermission, tenantCtx } from '../plugins/auth';
import type { RouteDeps } from './deps';
import { receiveUpload } from './upload';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * مدیریت پروژه. ساخت/ویرایش پروژه و افزودن ترمینال: مدیر دفتر و ادمین داده.
 * تغییر وضعیت ترمینال‌ها: همه‌ی نقش‌ها، فقط روی ترمینال‌های داخل دامنه‌ی خودشان (مسئول ستاد: ستاد؛ پشتیبان: ترمینال‌های خودش).
 */
export async function projectRoutes(app: FastifyInstance, { pools, storage }: RouteDeps): Promise<void> {
  const managers = { preHandler: [requirePermission(pools.read, 'projects.manage')] };
  const workers = { preHandler: [requirePermission(pools.read, 'projects.work')] };

  app.get('/projects', async (req) =>
    listProjects(tenantCtx(req), pools.read, projectListQuerySchema.parse(req.query), todayInTehran()));

  app.post('/projects', managers, async (req, reply) =>
    reply.status(201).send(await createProject(tenantCtx(req), pools.write, createProjectSchema.parse(req.body), todayInTehran())));

  // مسیرهای ثابت قبل از /projects/:id
  app.get('/projects/matrix', async (req) => getProjectsMatrix(tenantCtx(req), pools.read, todayInTehran()));
  app.get('/projects/alerts', async (req) => listProjectAlerts(tenantCtx(req), pools.read, todayInTehran()));

  app.get('/projects/:id', async (req) =>
    getProject(tenantCtx(req), pools.read, projectParamsSchema.parse(req.params).id, todayInTehran()));

  app.patch('/projects/:id', managers, async (req) =>
    patchProject(tenantCtx(req), pools.write, projectParamsSchema.parse(req.params).id, patchProjectSchema.parse(req.body), todayInTehran()));

  app.get('/projects/:id/progress', async (req) =>
    getProjectProgress(tenantCtx(req), pools.read, projectParamsSchema.parse(req.params).id, todayInTehran()));

  app.get('/projects/:id/trend', async (req) =>
    getProjectTrend(tenantCtx(req), pools.read, projectParamsSchema.parse(req.params).id, todayInTehran()));

  app.get('/projects/:id/terminals', async (req) =>
    listProjectTerminals(tenantCtx(req), pools.read, projectParamsSchema.parse(req.params).id, projectTerminalsQuerySchema.parse(req.query)));

  // افزودن با JSON (شناسه یا شماره ترمینال)
  app.post('/projects/:id/terminals', managers, async (req) => {
    const body = addProjectTerminalsSchema.parse(req.body);
    const rows: ProjectTerminalRowInput[] = [
      ...(body.terminalIds ?? []).map((terminalId) => ({ terminalId })),
      ...(body.terminalNos ?? []).map((terminalNo) => ({ terminalNo })),
    ];
    return addProjectTerminals(tenantCtx(req), pools.write, projectParamsSchema.parse(req.params).id, rows);
  });

  // افزودن/به‌روزرسانی با فایل اکسل یا CSV (multipart؛ فیلد type=project_terminals قبل از فایل)
  app.post('/projects/:id/terminals/import', managers, async (req): Promise<ProjectImportResultDto> => {
    const ctx = tenantCtx(req);
    const projectId = projectParamsSchema.parse(req.params).id;
    const up = await receiveUpload(req, storage, `project-imports/${ctx.officeId}`);
    try {
      let parsed;
      try {
        parsed = await parseProjectTerminalFile(await storage.get(up.file.key), up.file.kind);
      } catch (err) {
        throw new HttpError(422, 'INVALID_PROJECT_FILE', err instanceof Error ? err.message : 'فایل قابل خواندن نیست');
      }
      if (parsed.rows.length === 0) {
        throw new HttpError(422, 'NO_ROWS', 'هیچ ردیف معتبری در فایل نیست', { invalid: parsed.invalid.slice(0, 100) });
      }
      const r = await addProjectTerminals(ctx, pools.write, projectId, parsed.rows);
      return { ...r, invalid: parsed.invalid.slice(0, 100), invalidCount: parsed.invalid.length };
    } finally {
      await storage.delete(up.file.key).catch(() => undefined);
    }
  });

  app.post('/projects/:id/terminals/remove', managers, async (req) =>
    removeProjectTerminals(tenantCtx(req), pools.write, projectParamsSchema.parse(req.params).id, removeProjectTerminalsSchema.parse(req.body).terminalIds));

  // تغییر وضعیت گروهی (مسیر ثابت قبل از :terminalId)
  app.post('/projects/:id/terminals/status', workers, async (req) =>
    bulkSetProjectTerminalStatus(tenantCtx(req), pools.write, projectParamsSchema.parse(req.params).id, bulkStatusSchema.parse(req.body)));

  app.patch('/projects/:id/terminals/:terminalId', workers, async (req) => {
    const p = projectTerminalParamsSchema.parse(req.params);
    return setProjectTerminalStatus(tenantCtx(req), pools.write, p.id, p.terminalId, setTerminalStatusSchema.parse(req.body));
  });

  // خروجی اکسل ترمینال‌های پروژه (در دامنه‌ی کاربر؛ حداکثر ۵۰ هزار ردیف)
  app.get('/projects/:id/export', async (req, reply) => {
    const ctx = tenantCtx(req);
    const id = projectParamsSchema.parse(req.params).id;
    const project = await getProject(ctx, pools.read, id, todayInTehran());
    const rows: Array<Array<string | number>> = [];
    let cursor: string | undefined;
    do {
      const page = await listProjectTerminals(ctx, pools.read, id, projectTerminalsQuerySchema.parse({ limit: '200', ...(cursor ? { cursor } : {}) }));
      for (const t of page.items) {
        rows.push([t.terminalNo, t.shopName ?? '', PROJECT_TERMINAL_STATUS_FA[t.status], t.note ?? '']);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && rows.length < 50_000);
    return reply
      .header('content-type', XLSX_MIME)
      .header('content-disposition', `attachment; filename="project-${project.id}.xlsx"`)
      .send(xlsxFromRows('Project', ['شماره ترمینال', 'فروشگاه', 'وضعیت', 'توضیح'], rows));
  });
}
