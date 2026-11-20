import type { Queryable } from '../db/types';

export interface AuditEntry {
  officeId: number;
  userId: number | null;
  entityType: string;
  entityId: number;
  action: 'create' | 'update' | 'delete' | 'assign' | 'import' | 'setting';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  batchId?: number | null;
}

/** باید داخل همان transaction تغییر اصلی فراخوانی شود. نیازمند وجود پارتیشن ماه جاری (ensure_audit_partition). */
export async function writeAudit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (office_id, user_id, batch_id, entity_type, entity_id, action, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [
      e.officeId, e.userId, e.batchId ?? null, e.entityType, e.entityId, e.action,
      e.before ? JSON.stringify(e.before) : null,
      e.after ? JSON.stringify(e.after) : null,
    ],
  );
}
