import { createHash } from 'node:crypto';
import { headerFingerprintSource } from '@pos/shared';

/** اثرانگشت هدر فایل (sha256 از عنوان‌های نرمال‌شده) برای تطبیق با قالب رسمی/پروفایل */
export function headerFingerprint(headers: readonly string[]): string {
  return createHash('sha256').update(headerFingerprintSource(headers)).digest('hex');
}
