import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(40),
};

describe('loadEnv', () => {
  it('مقادیر پیش‌فرض را اعمال می‌کند', () => {
    const env = loadEnv(base);
    expect(env.API_PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.READ_DATABASE_URL).toBeUndefined();
    expect(env.SLOW_QUERY_MS).toBe(500);
  });

  it('رشته‌ی خالی برای READ_DATABASE_URL یعنی تنظیم‌نشده', () => {
    expect(loadEnv({ ...base, READ_DATABASE_URL: '' }).READ_DATABASE_URL).toBeUndefined();
  });

  it('عدد را از رشته می‌خواند و محدوده را کنترل می‌کند', () => {
    expect(loadEnv({ ...base, API_PORT: '8080' }).API_PORT).toBe(8080);
    expect(() => loadEnv({ ...base, API_PORT: '70000' })).toThrow(EnvError);
  });

  it('همه‌ی خطاها را یک‌جا گزارش می‌دهد', () => {
    try {
      loadEnv({ JWT_SECRET: 'short' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const issues = (e as EnvError).issues.join('|');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('JWT_SECRET');
    }
  });

  it('در production مقدار نمونه‌ی JWT_SECRET را رد می‌کند', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', JWT_SECRET: 'change_me_to_a_long_random_string_32chars_min' }),
    ).toThrow(EnvError);
  });

  it('شیء برگشتی تغییرناپذیر است', () => {
    expect(Object.isFrozen(loadEnv(base))).toBe(true);
  });
});
