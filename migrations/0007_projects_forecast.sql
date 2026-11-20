-- 0007_projects_forecast: مدیریت پروژه، پیش‌بینی، دلیل انصراف ترمینال

-- دلیل انصراف/برگشت (ثبت از طریق POST /terminals/:id/return)
ALTER TABLE terminals ADD COLUMN return_reason text;

-- ---------------------------------------------------------------- پروژه
-- پروژه = مجموعه‌ای از ترمینال‌ها با بازه‌ی زمانی (مثلاً «تعویض کارت‌خوان نسل قدیم»)
CREATE TABLE projects (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id   integer NOT NULL REFERENCES offices(id),
  name        text NOT NULL,
  description text,
  start_date  date NOT NULL,
  due_date    date NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','cancelled')),
  created_by  integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (office_id, id),
  UNIQUE (office_id, name),
  CONSTRAINT projects_dates_chk CHECK (due_date >= start_date)
);
CREATE INDEX projects_status_idx ON projects (office_id, status, id DESC);

-- وضعیت هر ترمینال در پروژه. پشتیبان/ستاد از جدول terminals (جاری) خوانده می‌شود.
CREATE TABLE project_terminals (
  office_id         integer NOT NULL,
  project_id        bigint  NOT NULL,
  terminal_id       bigint  NOT NULL,
  status            text    NOT NULL DEFAULT 'not_started'
                    CHECK (status IN ('not_started','in_progress','done','failed')),
  note              text,
  status_changed_at timestamptz,
  status_changed_by integer,
  added_at          timestamptz NOT NULL DEFAULT now(),
  added_by          integer,
  PRIMARY KEY (project_id, terminal_id),
  FOREIGN KEY (office_id, project_id)  REFERENCES projects  (office_id, id) ON DELETE CASCADE,
  FOREIGN KEY (office_id, terminal_id) REFERENCES terminals (office_id, id)
);
CREATE INDEX project_terminals_status_idx   ON project_terminals (office_id, project_id, status);
CREATE INDEX project_terminals_terminal_idx ON project_terminals (office_id, terminal_id);

-- تاریخچه‌ی تغییر وضعیت (برای ردیابی و گزارش‌های بعدی)
CREATE TABLE project_terminal_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id   integer NOT NULL,
  project_id  bigint  NOT NULL,
  terminal_id bigint  NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  note        text,
  changed_by  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (office_id, project_id) REFERENCES projects (office_id, id) ON DELETE CASCADE
);
CREATE INDEX project_events_idx ON project_terminal_events (office_id, project_id, created_at DESC);

-- ---------------------------------------------------------------- پیش‌بینی
-- آخرین نتیجه‌ی پیش‌بینی هر سری (دفتر/ستاد/پشتیبان). با هر اجرا، همه‌ی ردیف‌های دفتر جایگزین می‌شوند.
CREATE TABLE forecast_results (
  office_id     integer NOT NULL REFERENCES offices(id),
  scope_type    text    NOT NULL CHECK (scope_type IN ('office','unit','supporter')),
  scope_id      integer NOT NULL DEFAULT 0,              -- 0 برای سطح دفتر
  target_period integer NOT NULL,
  base_period   integer NOT NULL,                        -- آخرین ماه کامل مورد استفاده
  model         text    NOT NULL CHECK (model IN ('holt_winters','holt','mean')),
  value         bigint  NOT NULL,
  lower         bigint  NOT NULL,
  upper         bigint  NOT NULL,
  mape          double precision,                        -- خطای holdout (درصد)؛ NULL = داده‌ی کافی نبود
  generated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (office_id, scope_type, scope_id, target_period)
);

CREATE TABLE forecast_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id     integer NOT NULL REFERENCES offices(id),
  requested_by  integer,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  horizon       smallint NOT NULL,
  base_period   integer,
  series_count  integer,
  message       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX forecast_runs_idx ON forecast_runs (office_id, id DESC);
