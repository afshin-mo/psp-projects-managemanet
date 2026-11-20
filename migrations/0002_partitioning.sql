-- 0002_partitioning: والدهای پارتیشن‌شده و توابع ساخت پارتیشن
--  • transactions_snapshot: پارتیشن به‌ازای هر ماه شمسی (هم‌راستا با periods)
--  • audit_log: پارتیشن ماهانه‌ی میلادی بر اساس created_at (UTC)

-- مانده‌ی تجمعی از ابتدای ماه شمسی تا پایان as_of_date (نه مقدار روزانه)
CREATE TABLE transactions_snapshot (
  office_id        integer  NOT NULL,
  terminal_id      bigint   NOT NULL,
  as_of_date       date     NOT NULL,
  cum_amount       bigint   NOT NULL CHECK (cum_amount >= 0),   -- ریال
  cum_count        integer  NOT NULL CHECK (cum_count  >= 0),
  source           smallint NOT NULL CHECK (source IN (1, 2)),   -- 1 روزانه‌ی تجمعی، 2 فایل ماهانه
  import_batch_id  bigint   NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (office_id, terminal_id, as_of_date)
) PARTITION BY RANGE (as_of_date);
-- FK عمداً ندارد (هزینه‌ی bulk)؛ وجود terminal_id در مرحله‌ی staging تضمین می‌شود.
CREATE INDEX transactions_snapshot_brin ON transactions_snapshot USING brin (as_of_date);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  office_id   integer NOT NULL,
  user_id     integer,
  batch_id    bigint,
  entity_type text NOT NULL,
  entity_id   bigint NOT NULL,
  action      text NOT NULL CHECK (action IN ('create','update','delete','assign','import','setting')),
  before      jsonb,
  after       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);
CREATE INDEX audit_log_entity_idx ON audit_log (office_id, entity_type, entity_id, created_at DESC);

-- ساخت پارتیشن یک دوره‌ی شمسی. idempotent و امن در برابر اجرای هم‌زمان چند Worker.
CREATE FUNCTION ensure_period_partition(p_period integer) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  r      record;
  ns     text;
  n      text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pos:ensure_partition'));

  SELECT start_date, end_date INTO r FROM periods WHERE period_id = p_period;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'period % not found in periods (run seed-periods)', p_period
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT nspname INTO ns
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE c.oid = 'transactions_snapshot'::regclass;

  n := format('transactions_snapshot_%s', p_period);
  IF to_regclass(format('%I.%I', ns, n)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.transactions_snapshot FOR VALUES FROM (%L) TO (%L)',
      ns, n, ns, r.start_date, r.end_date);
  END IF;
  RETURN n;
END $$;

-- همه‌ی دوره‌هایی که با بازه‌ی [p_from, p_to) هم‌پوشانی دارند
CREATE FUNCTION ensure_period_partitions(p_from date, p_to date) RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT period_id FROM periods
            WHERE start_date < p_to AND end_date > p_from
            ORDER BY period_id
  LOOP
    RETURN NEXT ensure_period_partition(r.period_id);
  END LOOP;
END $$;

-- پارتیشن ماهانه‌ی audit_log (مرز بر اساس UTC)
CREATE FUNCTION ensure_audit_partition(p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  s   date := date_trunc('month', p_month)::date;
  e   date := (date_trunc('month', p_month) + interval '1 month')::date;
  ns  text;
  n   text := format('audit_log_%s', to_char(date_trunc('month', p_month), 'YYYY_MM'));
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pos:ensure_partition'));
  SELECT nspname INTO ns
    FROM pg_class c JOIN pg_namespace s2 ON s2.oid = c.relnamespace
   WHERE c.oid = 'audit_log'::regclass;

  IF to_regclass(format('%I.%I', ns, n)) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I.%I PARTITION OF %I.audit_log FOR VALUES FROM (%L) TO (%L)',
      ns, n, ns,
      (s::timestamp AT TIME ZONE 'UTC'), (e::timestamp AT TIME ZONE 'UTC'));
  END IF;
  RETURN n;
END $$;
