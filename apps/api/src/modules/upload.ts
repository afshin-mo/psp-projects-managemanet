import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { HttpError, type StorageProvider } from '@pos/core';

export interface StoredUpload {
  key: string;
  size: number;
  hash: string;
  kind: 'xlsx' | 'csv';
  name: string;
}

export interface ReceivedUpload { fields: Record<string, string>; file: StoredUpload }

const ZIP_MAGIC = 0x504b0304;

/**
 * دریافت multipart به‌صورت stream: فایل هم‌زمان با محاسبه‌ی sha256 و شمارش حجم در Storage نوشته می‌شود
 * (هرگز کامل در حافظه نمی‌آید). فیلدهای متنی باید «قبل از فایل» ارسال شوند.
 * کنترل نوع: پسوند xlsx/csv + magic bytes (xlsx باید zip باشد؛ csv نباید بایت NUL داشته باشد).
 */
export async function receiveUpload(req: FastifyRequest, storage: StorageProvider, keyPrefix: string): Promise<ReceivedUpload> {
  if (!req.isMultipart()) throw new HttpError(415, 'MULTIPART_REQUIRED', 'درخواست باید multipart/form-data باشد');
  const fields: Record<string, string> = {};
  let file: StoredUpload | undefined;

  for await (const part of req.parts()) {
    if (part.type === 'field') {
      if (typeof part.value === 'string') fields[part.fieldname] = part.value;
      continue;
    }
    if (file) {
      part.file.resume();
      throw new HttpError(400, 'ONE_FILE_ONLY', 'فقط یک فایل مجاز است');
    }
    if (fields.type === undefined) {
      part.file.resume();
      throw new HttpError(400, 'FIELDS_FIRST', 'فیلدهای فرم (type, options) باید قبل از فایل ارسال شوند');
    }
    const name = path.basename(part.filename || 'upload').slice(0, 200);
    const ext = path.extname(name).toLowerCase();
    const kind = ext === '.xlsx' ? 'xlsx' : ext === '.csv' ? 'csv' : null;
    if (!kind) {
      part.file.resume();
      throw new HttpError(400, 'UNSUPPORTED_FILE_TYPE', 'فقط فایل xlsx یا csv مجاز است');
    }

    const key = `${keyPrefix}/${randomUUID()}.${kind}`;
    const hash = createHash('sha256');
    let size = 0;
    let checked = false;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (!checked) {
          checked = true;
          const ok = kind === 'xlsx' ? chunk.length >= 4 && chunk.readUInt32BE(0) === ZIP_MAGIC : !chunk.includes(0);
          if (!ok) return cb(new HttpError(400, 'INVALID_FILE_CONTENT', 'محتوای فایل با پسوند آن سازگار نیست'));
        }
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await Promise.all([pipeline(part.file, tap), storage.put(key, tap)]);
    } catch (err) {
      await storage.delete(key).catch(() => undefined);
      throw err;
    }
    if (part.file.truncated) {
      await storage.delete(key).catch(() => undefined);
      throw new HttpError(413, 'FILE_TOO_LARGE', 'حجم فایل از سقف مجاز بیشتر است');
    }
    if (size === 0) {
      await storage.delete(key).catch(() => undefined);
      throw new HttpError(400, 'EMPTY_FILE', 'فایل خالی است');
    }
    file = { key, size, hash: hash.digest('hex'), kind, name };
  }
  if (!file) throw new HttpError(400, 'NO_FILE', 'فایلی ارسال نشده است');
  return { fields, file };
}
