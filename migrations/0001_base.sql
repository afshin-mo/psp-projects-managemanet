-- 0001_base: افزونه‌ها، دفترها، تنظیمات، دوره‌ها، داده پایه، کاربران
-- نیاز: PostgreSQL 16+. pg_trgm و btree_gist «trusted» هستند و مالک دیتابیس می‌تواند بسازد.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE offices (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  code          text NOT NULL UNIQUE,
  is_active     boolean NOT NULL DEFAULT true,
  data_version  bigint NOT NULL DEFAULT 0,          -- با هر ایمپورت موفق زیاد می‌شود (کلید کش)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE office_settings (
  office_id                 integer PRIMARY KEY REFERENCES offices(id) ON DELETE CASCADE,
  new_terminal_cutoff_day   smallint NOT NULL DEFAULT 20
                            CHECK (new_terminal_cutoff_day BETWEEN 1 AND 31),
  preliminary_alert_min_day smallint NOT NULL DEFAULT 10
                            CHECK (preliminary_alert_min_day BETWEEN 1 AND 31),
  drop_alert_threshold_pct  smallint NOT NULL DEFAULT 30
                            CHECK (drop_alert_threshold_pct BETWEEN 1 AND 99),
  updated_by                integer,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- هر دفتر جدید خودکار تنظیمات پیش‌فرض می‌گیرد
CREATE FUNCTION offices_create_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO office_settings (office_id) VALUES (NEW.id);
  RETURN NEW;
END $$;

CREATE TRIGGER offices_after_insert AFTER INSERT ON offices
  FOR EACH ROW EXECUTE FUNCTION offices_create_settings();

-- دوره‌های گزارش (ماه شمسی). سراسری و بدون office_id. با scripts/seed-periods پر می‌شود.
-- period_id = سال*100 + ماه  (140404 = تیر ۱۴۰۴). بازه [start_date, end_date) میلادی است.
CREATE TABLE periods (
  period_id   integer PRIMARY KEY,
  calendar    text NOT NULL DEFAULT 'jalali' CHECK (calendar IN ('jalali','gregorian')),
  year        smallint NOT NULL,
  month       smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  CHECK (start_date < end_date),
  CHECK (period_id = year * 100 + month),
  CONSTRAINT periods_no_overlap EXCLUDE USING gist (daterange(start_date, end_date, '[)') WITH &&)
);
CREATE INDEX periods_start_idx ON periods (start_date);

CREATE TABLE staff_units (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id     integer NOT NULL REFERENCES offices(id),
  name          text NOT NULL,
  manager_name  text,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (office_id, id),
  UNIQUE (office_id, name)
);

CREATE TABLE supporters (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id     integer NOT NULL,
  staff_unit_id integer NOT NULL,
  full_name     text NOT NULL,
  phone         text,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (office_id, id),
  FOREIGN KEY (office_id, staff_unit_id) REFERENCES staff_units (office_id, id)
);
CREATE INDEX supporters_unit_idx ON supporters (office_id, staff_unit_id);

CREATE TABLE banks (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id  integer NOT NULL REFERENCES offices(id),
  name       text NOT NULL,
  code       text,
  UNIQUE (office_id, id),
  UNIQUE (office_id, name)
);

CREATE TABLE route_groups (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id  integer NOT NULL REFERENCES offices(id),
  name       text NOT NULL,
  UNIQUE (office_id, id),
  UNIQUE (office_id, name)
);

-- system_admin = کاربر ستاد مرکزی؛ office_id ندارد و به داده‌ی دفترها دسترسی ندارد
CREATE TABLE users (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id      integer REFERENCES offices(id),
  username       text NOT NULL,
  password_hash  text NOT NULL,                      -- argon2id (فاز ۱)
  full_name      text NOT NULL,
  role           text NOT NULL
                 CHECK (role IN ('system_admin','office_manager','unit_head','supporter','data_admin')),
  staff_unit_id  integer,
  supporter_id   integer,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (office_id, staff_unit_id) REFERENCES staff_units (office_id, id),
  FOREIGN KEY (office_id, supporter_id)  REFERENCES supporters  (office_id, id),
  CONSTRAINT users_role_scope_chk CHECK (
       (role = 'system_admin'   AND office_id IS NULL     AND staff_unit_id IS NULL     AND supporter_id IS NULL)
    OR (role IN ('office_manager','data_admin')
                                AND office_id IS NOT NULL AND staff_unit_id IS NULL     AND supporter_id IS NULL)
    OR (role = 'unit_head'      AND office_id IS NOT NULL AND staff_unit_id IS NOT NULL AND supporter_id IS NULL)
    OR (role = 'supporter'      AND office_id IS NOT NULL AND supporter_id IS NOT NULL  AND staff_unit_id IS NULL)
  )
);
CREATE UNIQUE INDEX users_username_office_uq ON users (office_id, username) WHERE office_id IS NOT NULL;
CREATE UNIQUE INDEX users_username_system_uq ON users (username) WHERE office_id IS NULL;

-- Stateless API: refresh token در DB نگهداری می‌شود (فقط hash)
CREATE TABLE refresh_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id),
  token_hash  char(64) NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- متریک ساده‌ی کوئری‌های کند (نگهداری ۳۰ روز با job housekeeping)
CREATE TABLE slow_query_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  route       text,
  query_name  text NOT NULL,
  duration_ms integer NOT NULL,
  office_id   integer,
  params_hash char(16)
);
CREATE INDEX slow_query_log_at_idx ON slow_query_log (at DESC);
