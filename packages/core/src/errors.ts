export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what = 'رکورد'): HttpError => new HttpError(404, 'NOT_FOUND', `${what} یافت نشد`);
export const forbidden = (message = 'دسترسی مجاز نیست'): HttpError => new HttpError(403, 'FORBIDDEN', message);

/** تبدیل خطای PostgreSQL به خطای HTTP مناسب؛ برای خطاهای غیر PG مقدار null برمی‌گرداند. */
export function mapPgError(err: unknown): HttpError | null {
  if (typeof err !== 'object' || err === null || !('severity' in err)) return null;
  const code = (err as { code?: unknown }).code;
  switch (code) {
    case '23505': return new HttpError(409, 'DUPLICATE', 'مقدار تکراری است');
    case '23P01': return new HttpError(409, 'OVERLAP', 'بازه‌ی زمانی با رکورد دیگری هم‌پوشانی دارد');
    case '23503': return new HttpError(422, 'INVALID_REFERENCE', 'ارجاع نامعتبر است یا رکورد وابسته دارد');
    case '23514': return new HttpError(422, 'CONSTRAINT_VIOLATION', 'مقدار با قواعد داده سازگار نیست');
    case '22P02': case '22007': case '22008': case '22003':
      return new HttpError(400, 'INVALID_VALUE', 'مقدار نامعتبر است');
    default: return null;
  }
}
