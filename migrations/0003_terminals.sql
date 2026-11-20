-- 0003_terminals: ترمینال، تاریخچه‌ی پشتیبان (SCD2)، صندوق خروجی بازمحاسبه

CREATE TABLE terminals (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id            integer NOT NULL REFERENCES offices(id),
  terminal_no          text NOT NULL,                       -- متن؛ صفر اول حفظ می‌شود
  owner_name           text,
  phone                text,
  address              text,
  shop_name            text,
  route_group_id       integer,
  bank_id              integer,
  -- وضعیت واقعی: active | returned (انصراف/برگشتی). «کم‌تراکنش» یک طبقه‌بندی ماهانه است و اینجا نیست.
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','returned')),
  installed_at         date,
  returned_at          date,
  current_supporter_id integer NOT NULL,                    -- denormalized از history
  current_unit_id      integer NOT NULL,
  attributes           jsonb NOT NULL DEFAULT '{}',         -- ستون‌های اضافی قالب فایل
  search_norm          text NOT NULL DEFAULT '',            -- متن نرمال‌شده‌ی جستجو (شماره + فروشگاه + مالک)
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (office_id, terminal_no),
  UNIQUE (office_id, id),
  FOREIGN KEY (office_id, current_supporter_id) REFERENCES supporters (office_id, id),
  FOREIGN KEY (office_id, current_unit_id)      REFERENCES staff_units (office_id, id),
  FOREIGN KEY (office_id, route_group_id)       REFERENCES route_groups (office_id, id),
  FOREIGN KEY (office_id, bank_id)              REFERENCES banks (office_id, id),
  CONSTRAINT terminals_returned_chk CHECK ((status = 'returned') = (returned_at IS NOT NULL)),
  CONSTRAINT terminals_dates_chk CHECK (returned_at IS NULL OR installed_at IS NULL OR returned_at >= installed_at)
);
-- cursor pagination روی id؛ همه‌ی ایندکس‌ها با office_id شروع می‌شوند
CREATE INDEX terminals_supporter_idx ON terminals (office_id, current_supporter_id, id);
CREATE INDEX terminals_unit_idx      ON terminals (office_id, current_unit_id, id);
CREATE INDEX terminals_route_idx     ON terminals (office_id, route_group_id, id);
CREATE INDEX terminals_bank_idx      ON terminals (office_id, bank_id, id);
CREATE INDEX terminals_status_idx    ON terminals (office_id, status, id);
-- جستجوی ILIKE '%…%' با trigram. نکته: pg_trgm برای حروف فارسی به locale دیتابیس (UTF-8) وابسته است؛
-- اگر show_trgm('فروشگاه') خالی بود، ایندکس کمکی نمی‌کند ولی نتیجه‌ی جستجو همچنان درست است (README).
CREATE INDEX terminals_search_trgm ON terminals USING gin (search_norm gin_trgm_ops);

-- تاریخچه‌ی پشتیبان/مسیر/بانک. بازه‌ی [start_date, end_date) ؛ end_date خالی = جاری.
CREATE TABLE terminal_supporter_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id       integer NOT NULL,
  terminal_id     bigint  NOT NULL,
  supporter_id    integer NOT NULL,
  staff_unit_id   integer NOT NULL,
  route_group_id  integer NOT NULL DEFAULT 0,               -- 0 = نامشخص
  bank_id         integer NOT NULL DEFAULT 0,
  start_date      date NOT NULL,
  end_date        date,
  during          daterange GENERATED ALWAYS AS (daterange(start_date, end_date, '[)')) STORED,
  changed_by      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date > start_date),
  FOREIGN KEY (office_id, terminal_id) REFERENCES terminals (office_id, id),
  CONSTRAINT tsh_no_overlap EXCLUDE USING gist (office_id WITH =, terminal_id WITH =, during WITH &&)
);
CREATE INDEX tsh_terminal_idx  ON terminal_supporter_history (office_id, terminal_id, start_date);
CREATE INDEX tsh_supporter_idx ON terminal_supporter_history (office_id, supporter_id, start_date);
-- حداکثر یک ردیف جاری برای هر ترمینال
CREATE UNIQUE INDEX tsh_one_open_uq ON terminal_supporter_history (office_id, terminal_id) WHERE end_date IS NULL;

-- Transactional outbox: تغییراتی که آمار گذشته/جاری را تحت‌تأثیر می‌گذارند همراه transaction اصلی ثبت می‌شوند
-- و در فاز ۲ توسط Worker (snapshot.recompute) مصرف می‌شوند؛ بنابراین هیچ رویدادی گم نمی‌شود.
CREATE TABLE recompute_outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id       integer NOT NULL,
  terminal_id     bigint  NOT NULL,
  effective_date  date    NOT NULL,
  reason          text    NOT NULL CHECK (reason IN ('assignment','installed_at','returned_at','import')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
CREATE INDEX recompute_outbox_pending_idx ON recompute_outbox (office_id, id) WHERE processed_at IS NULL;
