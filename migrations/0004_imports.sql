-- 0004_imports: قالب رسمی، پروفایل، دسته‌های ایمپورت، تابع نرمال‌سازی فارسی

-- نسخه‌ی SQL از normalizeSearchText (packages/shared/src/normalize/text.ts)؛ برای merge انبوه set-based.
-- تست هم‌ارزی در core/src/imports/imports.db.test.ts
CREATE FUNCTION fa_normalize(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               translate(t, 'يىكة۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', 'ییکه01234567890123456789'),
               '[\u064B-\u065F\u0670\u0640]', '', 'g'),
             '[\u200C\u200D\u200E\u200F\u00A0]', ' ', 'g'),
           '\s+', ' ', 'g')))
$$;

CREATE SCHEMA IF NOT EXISTS staging;

-- قالب رسمی ستاد مرکزی (سراسری، بدون office_id)
CREATE TABLE official_templates (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type                text NOT NULL,
  version             integer NOT NULL,
  header_fingerprint  char(64) NOT NULL,
  column_map          jsonb NOT NULL,                 -- کلید کانونی ← عنوان ستون
  options             jsonb NOT NULL DEFAULT '{}',    -- headerRow, calendar
  file_name           text,
  storage_key         text,                           -- فایل نمونه‌ی اصلی برای دانلود
  effective_from      date NOT NULL DEFAULT CURRENT_DATE,
  is_active           boolean NOT NULL DEFAULT false, -- پیش‌نویس تا زمان فعال‌سازی
  note                text,
  created_by          integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, version)
);
CREATE INDEX official_templates_lookup_idx ON official_templates (type, header_fingerprint) WHERE is_active;

-- استثنا/override هر دفتر
CREATE TABLE import_profiles (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id           integer NOT NULL REFERENCES offices(id),
  type                text NOT NULL,
  name                text NOT NULL,
  version             integer NOT NULL,
  header_fingerprint  char(64) NOT NULL,
  column_map          jsonb NOT NULL,
  options             jsonb NOT NULL DEFAULT '{}',
  created_by          integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (office_id, type, name, version)
);
CREATE INDEX import_profiles_lookup_idx ON import_profiles (office_id, type, header_fingerprint, version DESC);

CREATE TABLE import_batches (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id      integer NOT NULL REFERENCES offices(id),
  type           text NOT NULL CHECK (type IN ('terminals','transactions_cumulative')),
  status         text NOT NULL DEFAULT 'uploaded' CHECK (status IN
                   ('uploaded','needs_mapping','validating','validated','committing','merged',
                    'aggregating','completed','failed','cancelled')),
  file_name      text NOT NULL,
  file_size      bigint NOT NULL,
  file_hash      char(64) NOT NULL,
  file_kind      text NOT NULL CHECK (file_kind IN ('xlsx','csv')),
  storage_key    text NOT NULL,
  options        jsonb NOT NULL DEFAULT '{}',        -- گزینه‌ها + columnMap نهایی + commitMode (بازتولیدپذیری)
  total_rows     integer, valid_rows integer, error_rows integer, skipped_rows integer,
  inserted_rows  integer, updated_rows integer, unchanged_rows integer,
  stage          text,
  progress       smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_summary  jsonb,
  attempts       smallint NOT NULL DEFAULT 0,
  created_by     integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);
-- جلوگیری از ایمپورت دوباره‌ی همان فایل (مگر شکست‌خورده/لغوشده)
CREATE UNIQUE INDEX import_batches_dedupe ON import_batches (office_id, type, file_hash)
  WHERE status NOT IN ('failed','cancelled');
CREATE INDEX import_batches_office_idx ON import_batches (office_id, id DESC);

CREATE TABLE import_batch_errors (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id     bigint NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_no       integer NOT NULL,
  column_name  text,
  code         text NOT NULL,
  message      text NOT NULL
);
CREATE INDEX import_batch_errors_idx ON import_batch_errors (batch_id, row_no);

-- «ترمینال‌های تعریف‌نشده»: ردیف‌هایی که ترمینالشان در دفتر نیست (از ایمپورت کنار گذاشته می‌شوند، خطا نیستند)
CREATE TABLE import_unknown_terminals (
  batch_id     bigint NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  terminal_no  text NOT NULL,
  rows_count   integer NOT NULL,
  total_amount bigint NOT NULL,
  first_row    integer NOT NULL,
  PRIMARY KEY (batch_id, terminal_no)
);

-- کلیدهای واقعاً تغییرکرده برای تجمیع افزایشی (فاز ۳)
CREATE TABLE import_batch_affected (
  batch_id     bigint NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  terminal_id  bigint NOT NULL,
  period_id    integer NOT NULL,
  PRIMARY KEY (batch_id, terminal_id, period_id)
);
