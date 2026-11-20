import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createTemplateFieldsSchema, idParamsSchema, importOptionsSchema, importTypeSchema, patchTemplateSchema,
} from '@pos/shared';
import {
  HttpError, createOfficialTemplateDraft, listOfficialTemplates, patchOfficialTemplate, readHeaders,
} from '@pos/core';
import { requireRoles } from '../plugins/auth';
import type { RouteDeps } from './deps';
import { receiveUpload } from './upload';

/** مدیریت قالب رسمی توسط ستاد مرکزی. این نقش به داده‌ی هیچ دفتری دسترسی ندارد. */
export async function systemRoutes(app: FastifyInstance, { pools, storage }: RouteDeps): Promise<void> {
  const sysOnly = { preHandler: [requireRoles('system_admin')] };

  app.get('/system/templates', sysOnly, async (req) =>
    listOfficialTemplates(pools.read, z.object({ type: importTypeSchema.optional() }).parse(req.query).type));

  // فایل نمونه‌ی مرکزی را آپلود کنید؛ پیش‌نویس (غیرفعال) با نگاشت پیشنهادی ساخته می‌شود و بعد از بازبینی با PATCH فعال می‌شود
  app.post('/system/templates', sysOnly, async (req, reply) => {
    const up = await receiveUpload(req, storage, 'templates');
    try {
      const fields = createTemplateFieldsSchema.parse(up.fields);
      const options = importOptionsSchema.parse(fields.options ? JSON.parse(fields.options) : {});
      const headers = await readHeaders(await storage.get(up.file.key), up.file.kind, options.headerRow).catch(() => null);
      if (!headers || headers.every((h) => h === '')) throw new HttpError(422, 'INVALID_FILE', 'سرستون فایل خوانده نشد');
      const draft = await createOfficialTemplateDraft(pools.write, { userId: Number(req.user.sub) }, {
        type: fields.type, headers, options: { headerRow: options.headerRow, calendar: options.calendar },
        fileName: up.file.name, storageKey: up.file.key, ...(fields.note ? { note: fields.note } : {}),
      });
      return reply.status(201).send(draft);
    } catch (err) {
      await storage.delete(up.file.key).catch(() => undefined);
      throw err;
    }
  });

  app.patch('/system/templates/:id', sysOnly, async (req) =>
    patchOfficialTemplate(pools.write, idParamsSchema.parse(req.params).id, patchTemplateSchema.parse(req.body)));
}
