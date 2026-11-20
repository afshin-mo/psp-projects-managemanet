import { z } from 'zod';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const intFromString = (def: number, min: number, max: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  READ_DATABASE_URL: optionalUrl,
  DB_WRITE_POOL_MAX: intFromString(10, 1, 200),
  DB_READ_POOL_MAX: intFromString(10, 1, 200),
  DB_READ_STATEMENT_TIMEOUT_MS: intFromString(15_000, 100, 600_000),
  SLOW_QUERY_MS: intFromString(500, 1, 600_000),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: intFromString(3000, 1, 65_535),
  RATE_LIMIT_MAX: intFromString(300, 1, 100_000),
  RATE_LIMIT_WINDOW_MS: intFromString(60_000, 1000, 3_600_000),
  LOGIN_RATE_LIMIT_MAX: intFromString(10, 1, 100_000), // تلاش ورود در دقیقه برای هر IP

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().regex(/^\d+[smhd]$/, 'e.g. 15m').default('15m'),
  REFRESH_TOKEN_TTL_DAYS: intFromString(7, 1, 90),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_PATH: z.string().min(1).default('./storage'),
  UPLOAD_MAX_MB: intFromString(100, 1, 2048),

  IMPORT_MAX_ROWS: intFromString(1_100_000, 1, 5_000_000),
  /** بعد از ایمپورتی با این تعداد ردیف (یا بیشتر) VACUUM ANALYZE اجرا می‌شود */
  IMPORT_VACUUM_THRESHOLD: intFromString(200_000, 1, 100_000_000),
  PGBOSS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('pgboss'),
  WORKER_CONCURRENCY: intFromString(1, 1, 16),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'EnvError';
  }
}

/** اعتبارسنجی متغیرهای محیطی؛ هنگام شروع هر پروسه فراخوانی می‌شود و در صورت خطا پروسه بالا نمی‌آید. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && /change_me/i.test(env.JWT_SECRET)) {
    throw new EnvError(['JWT_SECRET: placeholder value is not allowed in production']);
  }
  return Object.freeze(env);
}
