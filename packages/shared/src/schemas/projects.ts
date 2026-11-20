import { z } from 'zod';
import { PROJECT_STATUSES, PROJECT_TERMINAL_STATUSES } from '../projects';
import { idBodySchema, idParamSchema, isoDateSchema, limitSchema, textOrNullSchema, textSchema } from './common';

export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export const projectTerminalStatusSchema = z.enum(PROJECT_TERMINAL_STATUSES);

export const createProjectSchema = z
  .object({
    name: textSchema(200),
    description: textOrNullSchema(2000),
    startDate: isoDateSchema,
    dueDate: isoDateSchema,
  })
  .refine((v) => v.dueDate >= v.startDate, { message: 'سررسید نمی‌تواند قبل از شروع باشد', path: ['dueDate'] });

export const patchProjectSchema = z
  .object({
    name: textSchema(200).optional(),
    description: textOrNullSchema(2000),
    startDate: isoDateSchema.optional(),
    dueDate: isoDateSchema.optional(),
    status: projectStatusSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'حداقل یک مقدار لازم است');

export const projectListQuerySchema = z.object({ status: projectStatusSchema.optional() });

export const projectParamsSchema = z.object({ id: idParamSchema });
export const projectTerminalParamsSchema = z.object({ id: idParamSchema, terminalId: idParamSchema });

const idArray = z.array(idBodySchema).min(1).max(5000);

/** افزودن ترمینال به پروژه با شناسه یا شماره ترمینال (حداکثر ۵۰۰۰ مورد در هر درخواست) */
export const addProjectTerminalsSchema = z
  .object({
    terminalIds: idArray.optional(),
    terminalNos: z.array(z.string().trim().min(1).max(40)).min(1).max(5000).optional(),
  })
  .refine((v) => v.terminalIds !== undefined || v.terminalNos !== undefined, 'terminalIds یا terminalNos لازم است');

export const removeProjectTerminalsSchema = z.object({ terminalIds: idArray });

export const setTerminalStatusSchema = z.object({
  status: projectTerminalStatusSchema,
  note: textOrNullSchema(500),
});

export const bulkStatusSchema = z.object({
  terminalIds: idArray,
  status: projectTerminalStatusSchema,
  note: textOrNullSchema(500),
});

export const projectTerminalsQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: limitSchema,
  status: projectTerminalStatusSchema.optional(),
  supporterId: z.coerce.number().int().positive().optional(),
  unitId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(100).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type PatchProjectInput = z.infer<typeof patchProjectSchema>;
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;
export type AddProjectTerminalsInput = z.infer<typeof addProjectTerminalsSchema>;
export type SetTerminalStatusInput = z.infer<typeof setTerminalStatusSchema>;
export type BulkStatusInput = z.infer<typeof bulkStatusSchema>;
export type ProjectTerminalsQuery = z.infer<typeof projectTerminalsQuerySchema>;
