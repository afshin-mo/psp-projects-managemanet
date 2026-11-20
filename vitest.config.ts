import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'apps/web/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // تست‌های دیتابیس هر کدام schema جداگانه می‌سازند، ولی برای سادگی فایل‌ها پشت‌سرهم اجرا می‌شوند
    fileParallelism: false,
  },
});
