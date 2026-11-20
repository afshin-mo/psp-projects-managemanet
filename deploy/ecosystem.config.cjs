// PM2 (لینوکس/ویندوز). اجرا از ریشه‌ی پروژه:   pm2 start deploy/ecosystem.config.cjs && pm2 save
// پیش‌نیاز: npm ci && npm run db:migrate && npm run db:seed-periods && npm run build:web
// متغیرهای محیطی از فایل .env خوانده می‌شود (--env-file).
const common = {
  cwd: __dirname + '/..',
  interpreter: 'node',
  autorestart: true,
  max_restarts: 20,
  min_uptime: '10s',
  restart_delay: 3000,
  kill_timeout: 15000, // فرصت خاموش شدن مرتب (تمام شدن درخواست/job)
  time: true,
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'pos-api',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: '--env-file=.env apps/api/src/server.ts',
      // API بی‌وضعیت است؛ برای scale افقی instances را زیاد کنید (cluster mode با tsx پشتیبانی نمی‌شود، چند پروسه روی پورت‌های جدا + upstream در Nginx):
      instances: 1,
      max_memory_restart: '1G',
    },
    {
      ...common,
      name: 'pos-worker',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: '--env-file=.env apps/worker/src/main.ts',
      instances: 1, // فقط یک Worker زمان‌بندی‌ها (cron) را اجرا می‌کند؛ pg-boss تکراری‌ها را حذف می‌کند ولی یکی کافی است
      max_memory_restart: '3G', // ایمپورت/تجمیع سنگین
    },
  ],
};
