-- 0008_automation_scoring:
--  ۱) دو نوع مبلغ (خرید / کل) در snapshot، fact و تجمیع‌ها
--  ۲) پروژه‌های خودکار «فاقد درآمد» + تنظیمات آن‌ها + گزارش اجرا
--  ۳) همگام‌سازی اطلاعات ترمینال از فایل تراکنش (آخرین تاریخ فایل) و صندوق «ترمینال‌های تعریف‌نشده»
--  ۴) وزن‌های امتیازدهی پشتیبان
-- بعد از اعمال این مهاجرت یک‌بار «بازسازی آمار تجمیعی» (POST /admin/aggregates/rebuild) بزنید تا ستون‌های مبلغ کل
-- برای ماه‌های قبل از snapshotها پر شوند (تا قبل از آن مقدار آن‌ها ۰ است و رفتار قبلی تغییری نمی‌کند).

-- ---------------------------------------------------------------- ۱) دو نوع مبلغ
-- مبلغ خرید = cum_amount (همان که باعث واریز به حساب پذیرنده می‌شود؛ مبنای فعال/کم‌تراکنش)
-- مبلغ کل   = cum_total_amount (خرید + شارژ + قبض + ...)؛ NULL یعنی فایل این ستون را نداشته است
ALTER TABLE transactions_snapshot
  ADD COLUMN cum_total_amount bigint  CHECK (cum_total_amount IS NULL OR cum_total_amount >= 0),
  ADD COLUMN cum_total_count  integer CHECK (cum_total_count  IS NULL OR cum_total_count  >= 0);

ALTER TABLE fact_terminal_month
  ADD COLUMN total_amount   bigint  NOT NULL DEFAULT 0,
  ADD COLUMN total_tx_count integer NOT NULL DEFAULT 0;

ALTER TABLE agg_supporter_month
  ADD COLUMN total_amount bigint NOT NULL DEFAULT 0, ADD COLUMN total_tx_count bigint NOT NULL DEFAULT 0;
ALTER TABLE agg_unit_month
  ADD COLUMN total_amount bigint NOT NULL DEFAULT 0, ADD COLUMN total_tx_count bigint NOT NULL DEFAULT 0;
ALTER TABLE agg_office_month
  ADD COLUMN total_amount bigint NOT NULL DEFAULT 0, ADD COLUMN total_tx_count bigint NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------- تنظیمات دفتر
ALTER TABLE office_settings
  -- مبنای «فاقد درآمد/کم‌تراکنش»: purchase = مبلغ خرید (پیش‌فرض)، total = مبلغ کل
  ADD COLUMN income_basis text NOT NULL DEFAULT 'purchase' CHECK (income_basis IN ('purchase','total')),
  -- پروژه‌ی خودکار «فاقد درآمد ماه قبل»: مهلت تا این روز ماه جاری
  ADD COLUMN auto_no_income_prev boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_prev_deadline_day smallint NOT NULL DEFAULT 20 CHECK (auto_prev_deadline_day BETWEEN 1 AND 29),
  -- پروژه‌ی خودکار «فاقد درآمد ماه جاری»: ارزیابی از این روز ماه به بعد؛ مهلت = پایان همان ماه
  ADD COLUMN auto_no_income_curr boolean NOT NULL DEFAULT true,
  ADD COLUMN auto_curr_check_day smallint NOT NULL DEFAULT 20 CHECK (auto_curr_check_day BETWEEN 1 AND 29),
  -- همگام‌سازی اطلاعات ترمینال (نام فروشگاه، موبایل، بانک، ...) از فایل تراکنش
  ADD COLUMN sync_terminal_info boolean NOT NULL DEFAULT true,
  ADD COLUMN sync_create_banks boolean NOT NULL DEFAULT true,
  -- وزن مؤلفه‌های امتیاز پشتیبان (جمع آن‌ها هنگام محاسبه نرمال می‌شود)
  ADD COLUMN score_weights jsonb NOT NULL DEFAULT '{"amount":30,"count":15,"devices":20,"projects":35}'::jsonb;

-- ---------------------------------------------------------------- ۲) پروژه‌های خودکار
ALTER TABLE projects
  ADD COLUMN auto_kind   text CHECK (auto_kind IN ('no_income_prev','no_income_curr')),
  ADD COLUMN auto_period integer;
-- برای هر دفتر و هر ماه حداکثر یک پروژه‌ی خودکار از هر نوع
CREATE UNIQUE INDEX projects_auto_uq ON projects (office_id, auto_kind, auto_period) WHERE auto_kind IS NOT NULL;

CREATE TABLE auto_project_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id   integer NOT NULL REFERENCES offices(id),
  kind        text    NOT NULL CHECK (kind IN ('no_income_prev','no_income_curr')),
  period_id   integer NOT NULL,                 -- ماهی که ترمینال‌ها برای آن سنجیده شده‌اند
  project_id  bigint,
  outcome     text    NOT NULL CHECK (outcome IN ('created','updated','unchanged','skipped')),
  added       integer NOT NULL DEFAULT 0,
  eligible    integer NOT NULL DEFAULT 0,       -- تعداد ترمینال‌های واجد شرایط در لحظه‌ی اجرا
  message     text,
  trigger     text    NOT NULL CHECK (trigger IN ('schedule','manual')),
  created_by  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auto_project_runs_idx ON auto_project_runs (office_id, id DESC);

-- ردیابی دقیق‌تر وضعیت ترمینال در هر زمان (برای امتیاز ماهانه‌ی پروژه‌ها)
CREATE INDEX project_events_terminal_idx ON project_terminal_events (office_id, project_id, terminal_id, created_at);

-- ---------------------------------------------------------------- ۳) همگام‌سازی اطلاعات ترمینال
-- تاریخ آخرین فایلی که اطلاعات ترمینال از آن همگام شده؛ فایل قدیمی‌تر هرگز اطلاعات جدیدتر را بازنویسی نمی‌کند
ALTER TABLE terminals ADD COLUMN info_as_of date;

-- گزارش «ترمینال‌های تعریف‌نشده» هر دسته با اطلاعات بیشتر
ALTER TABLE import_unknown_terminals
  ADD COLUMN shop_name text, ADD COLUMN owner_name text, ADD COLUMN phone text, ADD COLUMN bank_name text,
  ADD COLUMN total_all_amount bigint NOT NULL DEFAULT 0,
  ADD COLUMN has_activity boolean NOT NULL DEFAULT false;

-- آمار ثبت (مثلاً تعداد ترمینال‌های به‌روزشده، بانک‌های ساخته‌شده)
ALTER TABLE import_batches ADD COLUMN merge_summary jsonb;

-- صندوق ترمینال‌های موجود در فایل تراکنش ولی بدون سابقه در دیتابیس
CREATE TABLE pending_terminals (
  office_id           integer NOT NULL REFERENCES offices(id),
  terminal_no         text    NOT NULL,
  shop_name           text,
  owner_name          text,
  phone               text,
  address             text,
  bank_name           text,
  status              text    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','dismissed')),
  has_activity        boolean NOT NULL DEFAULT false,   -- در فایل مبلغ خرید یا کل > ۰ داشته است
  last_as_of_date     date    NOT NULL,
  last_amount         bigint  NOT NULL DEFAULT 0,
  last_tx_count       integer NOT NULL DEFAULT 0,
  last_total_amount   bigint,
  first_batch_id      bigint,
  last_batch_id       bigint,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  resolved_terminal_id bigint,
  resolved_by         integer,
  resolved_at         timestamptz,
  PRIMARY KEY (office_id, terminal_no)
);
CREATE INDEX pending_terminals_status_idx ON pending_terminals (office_id, status, has_activity DESC, terminal_no);

-- ردیف‌های تراکنش این ترمینال‌ها تا زمان تعیین پشتیبان نگه داشته می‌شوند و بعد وارد snapshot اصلی می‌شوند
CREATE TABLE pending_terminal_snapshots (
  office_id        integer  NOT NULL,
  terminal_no      text     NOT NULL,
  as_of_date       date     NOT NULL,
  cum_amount       bigint   NOT NULL CHECK (cum_amount >= 0),
  cum_count        integer  NOT NULL CHECK (cum_count >= 0),
  cum_total_amount bigint   CHECK (cum_total_amount IS NULL OR cum_total_amount >= 0),
  cum_total_count  integer  CHECK (cum_total_count  IS NULL OR cum_total_count  >= 0),
  source           smallint NOT NULL CHECK (source IN (1, 2)),
  import_batch_id  bigint   NOT NULL,
  PRIMARY KEY (office_id, terminal_no, as_of_date),
  FOREIGN KEY (office_id, terminal_no) REFERENCES pending_terminals (office_id, terminal_no) ON DELETE CASCADE
);

-- ترمینالی که کاربر دستی از پروژه‌ی خودکار حذف کرده، دوباره به‌طور خودکار اضافه نمی‌شود
CREATE TABLE auto_project_exclusions (
  office_id   integer NOT NULL,
  project_id  bigint  NOT NULL,
  terminal_id bigint  NOT NULL,
  created_by  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, terminal_id),
  FOREIGN KEY (office_id, project_id) REFERENCES projects (office_id, id) ON DELETE CASCADE
);
