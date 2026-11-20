import type { ColumnMap, ImportType, PatchTemplateInput } from '@pos/shared';
import { suggestColumnMap } from '@pos/shared';
import { queryOne, queryRows, type Queryable } from '../db/types';
import { notFound } from '../errors';
import { headerFingerprint } from '../imports/fingerprint';

/** هویت کاربر ستاد مرکزی (بدون دفتر). این توابع عمداً در repos/ نیستند: tenant ندارند. */
export interface SystemContext { userId: number }

export interface OfficialTemplateDto {
  id: number; type: string; version: number; columnMap: ColumnMap; options: Record<string, unknown>;
  fileName: string | null; effectiveFrom: string; isActive: boolean; note: string | null; createdAt: string;
  missingRequired?: string[];
}

const COLS = `id, type, version, column_map AS "columnMap", options, file_name AS "fileName",
  effective_from AS "effectiveFrom", is_active AS "isActive", note, created_at AS "createdAt"`;

export function listOfficialTemplates(db: Queryable, type?: ImportType): Promise<OfficialTemplateDto[]> {
  return queryRows<OfficialTemplateDto>(db,
    `SELECT ${COLS} FROM official_templates WHERE ($1::text IS NULL OR type = $1) ORDER BY type, version DESC`, [type ?? null]);
}

/** از روی فایل نمونه‌ی مرکزی یک پیش‌نویس (غیرفعال) می‌سازد؛ column_map از مترادف‌ها پیشنهاد می‌شود */
export async function createOfficialTemplateDraft(
  db: Queryable, sys: SystemContext,
  input: { type: ImportType; headers: string[]; options: Record<string, unknown>; fileName: string; storageKey: string; note?: string },
): Promise<OfficialTemplateDto> {
  const s = suggestColumnMap(input.type, input.headers);
  const row = await queryOne<OfficialTemplateDto>(db,
    `INSERT INTO official_templates (type, version, header_fingerprint, column_map, options, file_name, storage_key, note, created_by)
     VALUES ($1, COALESCE((SELECT max(version) FROM official_templates WHERE type = $1), 0) + 1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8)
     RETURNING ${COLS}`,
    [input.type, headerFingerprint(input.headers), JSON.stringify(s.columnMap), JSON.stringify(input.options),
     input.fileName, input.storageKey, input.note ?? null, sys.userId]);
  return { ...(row as OfficialTemplateDto), missingRequired: s.missingRequired };
}

export async function patchOfficialTemplate(db: Queryable, id: number, input: PatchTemplateInput): Promise<OfficialTemplateDto> {
  const row = await queryOne<OfficialTemplateDto>(db,
    `UPDATE official_templates SET
        is_active = COALESCE($2, is_active), column_map = COALESCE($3::jsonb, column_map),
        effective_from = COALESCE($4::date, effective_from), note = COALESCE($5, note)
      WHERE id = $1 RETURNING ${COLS}`,
    [id, input.isActive ?? null, input.columnMap ? JSON.stringify(input.columnMap) : null,
     input.effectiveFrom ?? null, input.note ?? null]);
  if (!row) throw notFound('قالب');
  return row;
}

/** آخرین قالب رسمی فعال که فایل نمونه دارد (برای دانلود توسط دفترها) */
export function latestActiveTemplateFile(db: Queryable, type: ImportType, today: string): Promise<{ fileName: string; storageKey: string } | undefined> {
  return queryOne(db,
    `SELECT file_name AS "fileName", storage_key AS "storageKey" FROM official_templates
      WHERE type = $1 AND is_active AND effective_from <= $2::date AND storage_key IS NOT NULL
      ORDER BY version DESC LIMIT 1`, [type, today]);
}
