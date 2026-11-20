-- 0005_aggregation: قوانین آستانه، fact ماهانه، تجمیع‌ها، هشدار افت

-- حداقل مبلغ خرید ماهانه برای «فعال» بودن؛ per-bank. bank_id=0 = پیش‌فرض دفتر.
CREATE TABLE activity_rules (
  office_id           integer NOT NULL REFERENCES offices(id),
  bank_id             integer NOT NULL DEFAULT 0,
  valid_from_period   integer NOT NULL CHECK (valid_from_period BETWEEN 100001 AND 999912),
  min_monthly_amount  bigint  NOT NULL CHECK (min_monthly_amount >= 0),
  created_by          integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (office_id, bank_id, valid_from_period)
);

-- ترمینال × ماه شمسی. ستون‌های supporter/unit/route/bank «snapshot زمان همان ماه»‌اند:
-- با تعویض پشتیبان، آمار ماه‌های گذشته دست‌نخورده می‌ماند و کوئری‌های داشبورد به JOIN تاریخچه نیاز ندارند.
CREATE TABLE fact_terminal_month (
  office_id        integer  NOT NULL,
  period_id        integer  NOT NULL,
  terminal_id      bigint   NOT NULL,
  amount           bigint   NOT NULL,                 -- آخرین مانده‌ی تجمعی ماه (ریال)
  tx_count         integer  NOT NULL,
  last_as_of_date  date,                              -- تاریخ آخرین snapshot ماه (NULL = بدون فایل)
  is_complete      boolean  NOT NULL,                 -- آخرین snapshot در آخرین روز ماه یا فایل ماهانه
  activity_class   smallint NOT NULL CHECK (activity_class BETWEEN 1 AND 4),  -- 1 فعال 2 کم‌تراکنش 3 برگشتی 4 نوپا
  supporter_id     integer  NOT NULL,
  staff_unit_id    integer  NOT NULL,
  route_group_id   integer  NOT NULL DEFAULT 0,
  bank_id          integer  NOT NULL DEFAULT 0,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (office_id, period_id, terminal_id)
);
CREATE INDEX fact_terminal_idx ON fact_terminal_month (office_id, terminal_id, period_id);
CREATE INDEX fact_supporter_idx ON fact_terminal_month (office_id, period_id, supporter_id, route_group_id);
CREATE INDEX fact_unit_idx ON fact_terminal_month (office_id, period_id, staff_unit_id);

-- تجمیع‌ها از fact ساخته می‌شوند. شمارش دستگاه بین ماه‌ها جمع‌پذیر نیست (KPI بازه‌ای ماه آخر را نشان می‌دهد).
CREATE TABLE agg_supporter_month (
  office_id integer NOT NULL, period_id integer NOT NULL,
  supporter_id integer NOT NULL, staff_unit_id integer NOT NULL,
  route_group_id integer NOT NULL, bank_id integer NOT NULL,
  amount bigint NOT NULL, tx_count bigint NOT NULL,
  active_terminals integer NOT NULL, low_terminals integer NOT NULL,
  returned_terminals integer NOT NULL, new_terminals integer NOT NULL,
  incomplete_terminals integer NOT NULL,
  PRIMARY KEY (office_id, period_id, supporter_id, staff_unit_id, route_group_id, bank_id)
);
CREATE INDEX agg_supporter_idx ON agg_supporter_month (office_id, supporter_id, period_id);

CREATE TABLE agg_unit_month (
  office_id integer NOT NULL, period_id integer NOT NULL, staff_unit_id integer NOT NULL,
  route_group_id integer NOT NULL, bank_id integer NOT NULL,
  amount bigint NOT NULL, tx_count bigint NOT NULL,
  active_terminals integer NOT NULL, low_terminals integer NOT NULL,
  returned_terminals integer NOT NULL, new_terminals integer NOT NULL,
  incomplete_terminals integer NOT NULL,
  PRIMARY KEY (office_id, period_id, staff_unit_id, route_group_id, bank_id)
);
CREATE INDEX agg_unit_idx ON agg_unit_month (office_id, staff_unit_id, period_id);

CREATE TABLE agg_office_month (
  office_id integer NOT NULL, period_id integer NOT NULL,
  route_group_id integer NOT NULL, bank_id integer NOT NULL,
  amount bigint NOT NULL, tx_count bigint NOT NULL,
  active_terminals integer NOT NULL, low_terminals integer NOT NULL,
  returned_terminals integer NOT NULL, new_terminals integer NOT NULL,
  incomplete_terminals integer NOT NULL,
  PRIMARY KEY (office_id, period_id, route_group_id, bank_id)
);

-- هشدار افت (فقط ماه‌های کامل): مبلغ ماه کمتر از (۱-درصد) × میانگین ۳ ماه قبل. توسط Worker محاسبه می‌شود.
CREATE TABLE terminal_alerts (
  office_id integer NOT NULL, period_id integer NOT NULL, terminal_id bigint NOT NULL,
  supporter_id integer NOT NULL, staff_unit_id integer NOT NULL,
  avg3_amount bigint NOT NULL, cur_amount bigint NOT NULL, drop_pct numeric(6,2) NOT NULL,
  PRIMARY KEY (office_id, period_id, terminal_id)
);
CREATE INDEX alerts_supporter_idx ON terminal_alerts (office_id, period_id, supporter_id, drop_pct DESC);
CREATE INDEX alerts_unit_idx ON terminal_alerts (office_id, period_id, staff_unit_id, drop_pct DESC);
