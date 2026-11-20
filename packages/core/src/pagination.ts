import type { z } from 'zod';
import { HttpError } from './errors';

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'INVALID_CURSOR', 'مقدار cursor نامعتبر است');
  }
}
