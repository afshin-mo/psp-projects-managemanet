# راهنمای استقرار (Windows و Linux، بدون Docker)

معماری: **Nginx** (استاتیک فرانت‌اند + پروکسی `/api`) ← **API** (Fastify، بی‌وضعیت) و **Worker** (ایمپورت/تجمیع/پیش‌بینی/خروجی؛ pg-boss) ← **PostgreSQL 16+**.
فایل‌های آپلود و خروجی‌ها در `STORAGE_LOCAL_PATH` (دیسک محلی) نگهداری می‌شود.

## ۱. پیش‌نیازها
| مورد | نسخه | یادداشت |
|---|---|---|
| Node.js | LTS ≥ 20.11 (پیشنهاد 22) | |
| PostgreSQL | 16+ | `pg_dump`/`pg_restore` باید در PATH (یا مسیر کامل) باشد |
| Nginx | 1.24+ | ویندوز: zip رسمی nginx.org |
| PM2 یا NSSM | | PM2: `npm i -g pm2` ؛ NSSM: nssm.cc (فقط ویندوز) |

## ۲. دیتابیس
```sql
CREATE ROLE pos_app LOGIN PASSWORD '<رمز قوی>';
CREATE DATABASE pos_support OWNER pos_app;
```
تنظیمات `postgresql.conf` پیشنهادی برای سرور اختصاصی با ۳۲ گیگ RAM (متناسب با RAM خود تغییر دهید):
```
shared_buffers = 8GB
effective_cache_size = 24GB
work_mem = 64MB                  # کوئری‌های تجمیع؛ بیشتر از این به ازای هر اتصال نگذارید
maintenance_work_mem = 1GB
max_wal_size = 8GB
checkpoint_completion_target = 0.9
random_page_cost = 1.1           # SSD
```
ایمپورت میلیونی WAL زیادی می‌سازد؛ دیسک WAL را با فضای کافی در نظر بگیرید.

## ۳. نصب برنامه
```bash
git clone <repo> /opt/pos && cd /opt/pos          # ویندوز: C:\pos
npm ci
cp .env.example .env                               # مقادیر زیر را تنظیم کنید
npm run db:migrate
npm run db:seed-periods
npm run build:web                                  # خروجی: apps/web/dist
npm run create-office -- --code=tehran1 --name="دفتر تهران" --manager=admin1
```
مهم‌ترین متغیرهای `.env` در production:
```
NODE_ENV=production
DATABASE_URL=postgres://pos_app:<رمز>@127.0.0.1:5432/pos_support
JWT_SECRET=<حداقل ۳۲ نویسه‌ی تصادفی>            # مثلاً: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
STORAGE_LOCAL_PATH=/opt/pos/storage                # مسیر مطلق، روی دیسک با فضای کافی
UPLOAD_MAX_MB=100                                  # باید ≤ client_max_body_size در Nginx باشد
API_HOST=127.0.0.1                                 # API فقط از Nginx در دسترس باشد
```
`JWT_SECRET` با مقدار `change_me` در production پروسه را بالا نمی‌آورد.

## ۴. اجرای سرویس‌ها

### گزینه‌ی الف: PM2 (لینوکس یا ویندوز)
```bash
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup                 # لینوکس: دستور چاپ‌شده را اجرا کنید؛ ویندوز: از pm2-installer یا Task Scheduler استفاده کنید
pm2 logs pos-api
```
به‌روزرسانی: `git pull && npm ci && npm run db:migrate && npm run build:web && pm2 reload all`.

### گزینه‌ی ب: سرویس ویندوز با NSSM
```powershell
# PowerShell به‌عنوان Administrator
.\deploy\windows\install-services.ps1 -NssmPath "C:\tools\nssm\win64\nssm.exe"
nssm status pos-api ; nssm status pos-worker
```
لاگ‌ها در `logs\` (چرخش خودکار ۲۰ مگابایتی). به‌روزرسانی: `nssm restart pos-api ; nssm restart pos-worker` پس از `npm ci` و `db:migrate`.

> ترتیب به‌روزرسانی همیشه: **migrate ← build:web ← restart**. مهاجرت‌ها سازگار با نسخه‌ی قبل کد نوشته می‌شوند؛ اگر ناسازگار بود در یادداشت نسخه ذکر می‌شود.

## ۵. Nginx
فایل `deploy/nginx/pos-support.conf` را include کنید و `server_name`، `root` و (برای HTTPS) گواهی را تنظیم کنید.
```bash
nginx -t && nginx -s reload
```
- `/api/` به API پروکسی می‌شود؛ `trustProxy` در API فعال است و IP واقعی از `X-Forwarded-For` خوانده می‌شود.
- مسیر ورود محدودیت نرخ جداگانه دارد (علاوه بر محدودیت برنامه).
- `/health` عمومی و `/health/ready` فقط از localhost (بررسی اتصال دیتابیس و صف).
- **HTTPS اجباری است** (توکن‌ها در هدر Authorization می‌روند). پشت شبکه‌ی داخلی هم گواهی داخلی بگذارید.

## ۶. بکاپ و بازیابی
| چه چیزی | چگونه | اسکریپت |
|---|---|---|
| دیتابیس | `pg_dump --format=custom` روزانه | `deploy/linux/backup.sh` · `deploy\windows\backup.ps1` |
| فایل‌های آپلود/خروجی | tar/zip از `STORAGE_LOCAL_PATH` | همان اسکریپت‌ها |
| `.env` | کپی جدا و امن (شامل `JWT_SECRET`) | دستی |

زمان‌بندی: Task Scheduler (ویندوز) یا cron (لینوکس)؛ دستور نمونه در ابتدای هر اسکریپت است. پیشنهاد: نگهداری ۱۴ روز محلی + کپی هفتگی روی دیسک/سرور دیگر.
برای RPO کمتر از یک روز، آرشیو WAL (`archive_command`) و PITR را فعال کنید.

**بازیابی:**
```bash
# ۱) سرویس‌ها را متوقف کنید (pm2 stop all  /  nssm stop pos-api; nssm stop pos-worker)
createdb -O pos_app pos_support_restore
pg_restore -h localhost -U pos_app -d pos_support_restore --no-owner --jobs=4 pos-YYYYMMDD-HHMM.dump
# ۲) پس از اطمینان، DATABASE_URL را به دیتابیس بازیابی‌شده بگذارید (یا دیتابیس قدیمی را rename کنید)
# ۳) storage را از آرشیو برگردانید
# ۴) سرویس‌ها را بالا بیاورید؛ npm run db:migrate را یک‌بار اجرا کنید (بی‌خطر است)
```
**هر سه‌ماه یک‌بار بازیابی را روی ماشین تست امتحان کنید**؛ بکاپ آزمایش‌نشده، بکاپ نیست.
جدول‌های `stats_cache` (UNLOGGED) و صف pg-boss بعد از crash خالی می‌شوند؛ این مشکلی نیست (کش دوباره ساخته می‌شود و jobهای ناتمام با retry/زمان‌بندی تکرار می‌شوند). بعد از بازیابی بکاپ در صورت شک: «بازسازی آمار تجمیعی» از صفحه‌ی مدیریت.

## ۷. آرشیو پارتیشن‌های قدیمی
جدول‌های `transactions_snapshot` (ماهانه شمسی) و `audit_log` (ماهانه) بزرگ‌ترین مصرف‌کننده‌ی دیسک‌اند.
```bash
npm run db:archive                       # پیش‌نمایش؛ پارتیشن‌های قدیمی‌تر از ۳۶ ماه (snapshot) و ۲۴ ماه (audit)
npm run db:archive -- --execute          # pg_dump به ./archive  ←  DETACH
npm run db:archive -- --execute --drop   # بعد از dump موفق، جدول جداشده حذف می‌شود (فضا آزاد می‌شود)
```
- fact/agg (آمار ماهانه) دست‌نخورده می‌ماند؛ داشبورد و پیش‌بینی به آرشیو وابسته نیستند.
- بعد از آرشیو، **بازسازی کامل آمار** برای آن ماه‌ها ممکن نیست. dumpها را جای امن نگه دارید (بازگرداندن: `pg_restore` در جدول مستقل و سپس `ATTACH PARTITION`).
- `DETACH` قفل کوتاهی روی جدول والد می‌گیرد؛ خارج از ساعت کاری اجرا کنید. پیشنهاد: فصلی یک‌بار.
- پارتیشن‌های آینده را `db:seed-periods` و job روزانه‌ی Worker می‌سازد؛ نگران ساخت آن‌ها نباشید.

## ۸. مانیتورینگ و عیب‌یابی
- `GET /health/ready` برای مانیتور (200 = دیتابیس و صف سالم).
- کوئری‌های کندتر از `SLOW_QUERY_MS` (پیش‌فرض ۵۰۰ms) در لاگ با برچسب `slow query` ثبت می‌شود.
- ایمپورت گیر کرده: صفحه‌ی ایمپورت ← جزئیات ← «تلاش مجدد»؛ لاگ Worker را ببینید.
- پیش‌بینی خالی: حداقل ۴ ماه کامل لازم است؛ وضعیت آخرین اجرا در صفحه‌ی «پیش‌بینی» (مدیر دفتر) دیده می‌شود.
- رمز فراموش‌شده‌ی مدیر دفتر: `npm run create-office` دفتر جدید می‌سازد؛ برای دفتر موجود از ادمین‌داده/مدیر دیگر یا مستقیماً SQL (`UPDATE users SET password_hash=...` با هش argon2) استفاده کنید.
