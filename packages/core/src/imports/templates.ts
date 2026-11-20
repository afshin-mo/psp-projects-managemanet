import {
  normalizeHeader, resolveColumnMap, suggestColumnMap, type ImportType, type MappingInfoDto,
} from '@pos/shared';
import { queryOne, type Queryable } from '../db/types';
import { headerFingerprint } from './fingerprint';

export interface ResolvedMapping {
  mapping: MappingInfoDto;
  /** true اگر قالب رسمی/پروفایل منطبق و کامل بود و نیازی به تأیید کاربر نیست */
  auto: boolean;
}

interface StoredMap { id: number; columnMap: Record<string, string> }

/**
 * پروفایل/قالب رسمی قدیمی ممکن است ستون‌های اختیاریِ جدید (مبلغ کل، نام فروشگاه، بانک، موبایل، ...) را نداشته باشد.
 * اگر عنوان چنین ستونی در فایل هست و هنوز به فیلد دیگری نگاشت نشده، به نگاشت اضافه می‌شود.
 */
function withOptionalSuggestions(type: ImportType, stored: Record<string, string>, headers: string[]): Record<string, string> {
  const suggested = suggestColumnMap(type, headers).columnMap;
  const used = new Set(Object.values(stored).map(normalizeHeader));
  const out = { ...stored };
  for (const [key, title] of Object.entries(suggested)) {
    if (out[key] !== undefined || used.has(normalizeHeader(title))) continue;
    out[key] = title;
    used.add(normalizeHeader(title));
  }
  return out;
}

/**
 * ترتیب تطبیق: پروفایل دفتر ← قالب رسمی مرکزی ← پیشنهاد خودکار (نیازمند تأیید کاربر).
 * هر دو مورد اول فقط وقتی «خودکار» حساب می‌شوند که همه‌ی ستون‌های الزامی روی هدر واقعی بنشینند.
 */
export async function resolveMapping(
  db: Queryable, officeId: number, type: ImportType, headers: string[], today: string,
): Promise<ResolvedMapping> {
  const fp = headerFingerprint(headers);
  const base = { headers, unmatchedHeaders: [] as string[] };

  const profile = await queryOne<StoredMap>(db,
    `SELECT id, column_map AS "columnMap" FROM import_profiles
      WHERE office_id = $1 AND type = $2 AND header_fingerprint = $3 ORDER BY version DESC LIMIT 1`, [officeId, type, fp]);
  if (profile) {
    const r = resolveColumnMap(type, profile.columnMap, headers);
    if (r.missingRequired.length === 0) {
      return { auto: true, mapping: { ...base, source: 'profile', columnMap: withOptionalSuggestions(type, profile.columnMap, headers), missingRequired: [] } };
    }
  }

  const official = await queryOne<StoredMap>(db,
    `SELECT id, column_map AS "columnMap" FROM official_templates
      WHERE type = $1 AND header_fingerprint = $2 AND is_active AND effective_from <= $3::date
      ORDER BY version DESC LIMIT 1`, [type, fp, today]);
  if (official) {
    const r = resolveColumnMap(type, official.columnMap, headers);
    if (r.missingRequired.length === 0) {
      return { auto: true, mapping: { ...base, source: 'official', columnMap: withOptionalSuggestions(type, official.columnMap, headers), missingRequired: [] } };
    }
  }

  const s = suggestColumnMap(type, headers);
  return {
    auto: false,
    mapping: {
      headers, source: Object.keys(s.columnMap).length > 0 ? 'suggested' : 'none',
      columnMap: s.columnMap, missingRequired: s.missingRequired, unmatchedHeaders: s.unmatchedHeaders,
    },
  };
}
