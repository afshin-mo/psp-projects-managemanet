-- 0006_analytics: کش نتایج آماری، منحنی پیشرفت ماه، کارهای خروجی

-- پیاده‌سازی پیش‌فرض CacheProvider. کلید شامل data_version است؛ با هر ایمپورت/تغییر، نسخه‌ی قبلی خودبه‌خود بی‌اعتبار می‌شود.
CREATE UNLOGGED TABLE stats_cache (
  office_id     integer NOT NULL,
  cache_key     char(64) NOT NULL,
  data_version  bigint NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (office_id, cache_key, data_version)
);
CREATE INDEX stats_cache_created_idx ON stats_cache (created_at);

-- سهم تجمیعی مبلغ تا روز k ماه شمسی (میانه‌ی چند ماه کامل اخیر)، سطح دفتر؛ برای projection ماه ناقص
CREATE TABLE month_progress_curve (
  office_id      integer NOT NULL REFERENCES offices(id),
  day_of_month   smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  share          double precision NOT NULL CHECK (share >= 0 AND share <= 1),
  months_used    smallint NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (office_id, day_of_month)
);

CREATE TABLE export_jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id    integer NOT NULL REFERENCES offices(id),
  user_id      integer NOT NULL,
  kind         text NOT NULL,
  params       jsonb NOT NULL,               -- شامل ctx کاربر برای اعمال همان دامنه‌ی دسترسی در Worker
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','expired')),
  storage_key  text,
  row_count    bigint,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);
CREATE INDEX export_jobs_user_idx ON export_jobs (office_id, user_id, id DESC);
