import { cellToText, normalizeTerminalNo, parseAmount, parseCount, parseDateCell, toEnglishDigits } from '@pos/shared';
import type pg from 'pg';
import { BatchError, type HandlerCtx, type MergeStats, type TypeHandler } from '../types';

const COLS = [
  'row_no', 'terminal_no', 'amount', 'tx_count', 'total_amount', 'total_tx_count', 'as_of_date',
  'shop_name', 'owner_name', 'phone', 'address', 'bank_name', 'err_code', 'err_col', 'err_msg',
] as const;

type Err = { code: string; col: string; msg: string };

/** سلول اختیاری متنی: خالی = null (بدون تغییر)؛ بیش از حد مجاز = خطا */
function optText(raw: unknown, max: number, col: string, errRef: { e?: Err }): string | null {
  if (raw === undefined) return null;
  const t = cellToText(raw).replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  if (t.length > max) {
    errRef.e ??= { code: 'TOO_LONG', col, msg: `حداکثر ${max} کاراکتر مجاز است` };
    return t.slice(0, max);
  }
  return t;
}

/**
 * کنترل یکنوایی نسبت به رکوردهای موجود در دیتابیس (همان ماه شمسی).
 * ردیف‌های دیتابیس که در همین فایل بازنویسی می‌شوند نادیده گرفته می‌شوند.
 * هم در اعتبارسنجی و هم دوباره درست قبل از merge اجرا می‌شود.
 */
async function neighborCheck(client: pg.PoolClient, ctx: HandlerCtx): Promise<void> {
  const t = ctx.table;
  const neighbor = (cmp: '<' | '>', order: 'DESC' | 'ASC', bound: string): string => `
    SELECT x.cum_amount, x.cum_count FROM transactions_snapshot x
     WHERE x.office_id = $1 AND x.terminal_id = s.terminal_id
       AND ${bound} AND x.as_of_date ${cmp} s.as_of_date
       AND NOT EXISTS (SELECT 1 FROM ${t} o WHERE o.terminal_id = x.terminal_id AND o.as_of_date = x.as_of_date
                          AND o.err_code IS NULL AND NOT o.skipped)
     ORDER BY x.as_of_date ${order} LIMIT 1`;
  await client.query(
    `UPDATE ${t} s SET err_code = 'CUM_NON_MONOTONIC', err_col = 'amount',
            err_msg = 'مانده‌ی تجمعی با رکوردهای قبل/بعد همان ماه سازگار نیست'
       FROM periods p
      WHERE p.period_id = s.period_id AND s.err_code IS NULL AND NOT s.skipped
        AND (EXISTS (SELECT 1 FROM (${neighbor('<', 'DESC', 'x.as_of_date >= p.start_date')}) pv
                      WHERE pv.cum_amount > s.amount OR pv.cum_count > s.tx_count)
          OR EXISTS (SELECT 1 FROM (${neighbor('>', 'ASC', 'x.as_of_date < p.end_date')}) nx
                      WHERE nx.cum_amount < s.amount OR nx.cum_count < s.tx_count))`,
    [ctx.officeId],
  );
}

/** مانده‌ی تجمعی از ابتدای ماه شمسی تا تاریخ فایل (نه مقدار روزانه). */
export const transactionsHandler: TypeHandler = {
  type: 'transactions_cumulative',
  copyColumns: COLS,

  createTableSql: (t) => `CREATE UNLOGGED TABLE ${t} (
    row_no integer NOT NULL, terminal_no text, amount bigint, tx_count integer, total_amount bigint, total_tx_count integer,
    as_of_date date, shop_name text, owner_name text, phone text, address text, bank_name text,
    err_code text, err_col text, err_msg text,
    terminal_id bigint, period_id integer, bank_id integer, skipped boolean NOT NULL DEFAULT false)`,

  indexSql: (t) => [`CREATE INDEX ON ${t} (row_no)`, `CREATE INDEX ON ${t} (terminal_id, as_of_date)`],

  async prepare(client, ctx, indexes) {
    if (ctx.options.source === 'monthly') {
      if (!ctx.options.periodId) throw new BatchError('PERIOD_REQUIRED', 'برای فایل ماهانه، دوره (periodId) الزامی است');
      const r = await client.query<{ d: string }>(
        `SELECT (end_date - 1)::text AS d FROM periods WHERE period_id = $1`, [ctx.options.periodId]);
      if (!r.rows[0]) throw new BatchError('PERIOD_NOT_FOUND', 'دوره‌ی انتخاب‌شده تعریف نشده است');
      ctx.monthEnd = r.rows[0].d;
    } else if (indexes.as_of_date === undefined && !ctx.options.asOfDate) {
      throw new BatchError('ASOF_REQUIRED', 'تاریخ فایل نه در ستون‌ها هست و نه هنگام آپلود وارد شده است');
    }
  },

  toRow(rowNo, raw, ctx) {
    const errRef: { e?: Err } = {};
    const terminalNo = normalizeTerminalNo(cellToText(raw.terminal_no));
    if (terminalNo === '' || terminalNo.length > 32) {
      errRef.e = { code: 'BAD_TERMINAL_NO', col: 'terminal_no', msg: 'شماره ترمینال نامعتبر است' };
    }
    // مبلغ/تعداد «خرید» (الزامی): مبنای فعال‌بودن و پروژه‌ی فاقد درآمد (مگر در تنظیمات «مبلغ کل» انتخاب شود)
    const amount = parseAmount(raw.amount);
    if (!amount.ok) errRef.e ??= { code: amount.code === 'EMPTY' ? 'EMPTY_AMOUNT' : 'BAD_AMOUNT', col: 'amount', msg: 'مبلغ خرید نامعتبر یا خالی است' };
    const count = parseCount(raw.tx_count);
    if (!count.ok) errRef.e ??= { code: count.code === 'EMPTY' ? 'EMPTY_COUNT' : 'BAD_COUNT', col: 'tx_count', msg: 'تعداد تراکنش نامعتبر یا خالی است' };

    // مبلغ/تعداد «کل» (اختیاری): خالی = در فایل نبود
    let totalAmount: number | null = null;
    if (raw.total_amount !== undefined) {
      const r = parseAmount(raw.total_amount);
      if (r.ok) totalAmount = r.value;
      else if (r.code === 'BAD_NUMBER') errRef.e ??= { code: 'BAD_TOTAL_AMOUNT', col: 'total_amount', msg: 'مبلغ کل نامعتبر است' };
    }
    let totalCount: number | null = null;
    if (raw.total_tx_count !== undefined) {
      const r = parseCount(raw.total_tx_count);
      if (r.ok) totalCount = r.value;
      else if (r.code === 'BAD_NUMBER') errRef.e ??= { code: 'BAD_TOTAL_COUNT', col: 'total_tx_count', msg: 'تعداد کل تراکنش نامعتبر است' };
    }

    let asOf: string | null = null;
    if (ctx.monthEnd) asOf = ctx.monthEnd;
    else {
      const d = raw.as_of_date === undefined ? { ok: false as const, code: 'EMPTY' as const } : parseDateCell(raw.as_of_date, ctx.options.calendar);
      if (d.ok) asOf = d.value;
      else if (d.code === 'BAD_DATE') errRef.e ??= { code: 'BAD_DATE', col: 'as_of_date', msg: 'تاریخ نامعتبر است' };
      else asOf = ctx.options.asOfDate ?? null;
    }
    if (asOf === null) errRef.e ??= { code: 'EMPTY_DATE', col: 'as_of_date', msg: 'تاریخ فایل مشخص نیست' };

    // اطلاعات ترمینال (اختیاری)
    const shop = optText(raw.shop_name, 200, 'shop_name', errRef);
    const owner = optText(raw.owner_name, 200, 'owner_name', errRef);
    const address = optText(raw.address, 500, 'address', errRef);
    const bank = optText(raw.bank_name, 100, 'bank_name', errRef);
    const phoneTxt = raw.phone === undefined ? '' : toEnglishDigits(cellToText(raw.phone)).replace(/[\s-]/g, '');
    const phone = phoneTxt === '' ? null : phoneTxt.slice(0, 30);

    return [rowNo, terminalNo === '' ? null : terminalNo, amount.ok ? amount.value : null, count.ok ? count.value : null,
      totalAmount, totalCount, asOf, shop, owner, phone, address, bank,
      errRef.e?.code ?? null, errRef.e?.col ?? null, errRef.e?.msg ?? null];
  },

  async validate(client, ctx) {
    const t = ctx.table;
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
    const mark = (code: string, col: string, msg: string): string =>
      `err_code = '${code}', err_col = '${col}', err_msg = '${msg}'`;

    await q(`UPDATE ${t} s SET terminal_id = x.id FROM terminals x WHERE x.office_id = $1 AND x.terminal_no = s.terminal_no`, [ctx.officeId]);

    // ترمینال تعریف‌نشده: خطا نیست؛ ردیف کنار گذاشته می‌شود و در گزارش «ترمینال‌های تعریف‌نشده» می‌آید
    // (بعد از ثبت، به صندوق pending_terminals می‌رود تا کاربر پشتیبان تعیین کند)
    await q(`UPDATE ${t} SET skipped = true WHERE terminal_id IS NULL AND err_code IS NULL AND terminal_no IS NOT NULL`);
    await q(`INSERT INTO import_unknown_terminals
               (batch_id, terminal_no, rows_count, total_amount, total_all_amount, first_row, shop_name, owner_name, phone, bank_name, has_activity)
             SELECT $1::bigint, g.terminal_no, g.rows_count, g.max_amount, g.max_total, g.first_row,
                    l.shop_name, l.owner_name, l.phone, l.bank_name, g.has_activity
               FROM (SELECT terminal_no, count(*)::int AS rows_count, COALESCE(max(amount), 0)::bigint AS max_amount,
                            COALESCE(max(total_amount), 0)::bigint AS max_total, min(row_no) AS first_row,
                            bool_or(COALESCE(amount, 0) > 0 OR COALESCE(total_amount, 0) > 0) AS has_activity
                       FROM ${t} WHERE skipped GROUP BY terminal_no) g
               JOIN LATERAL (SELECT x.shop_name, x.owner_name, x.phone, x.bank_name FROM ${t} x
                              WHERE x.skipped AND x.terminal_no = g.terminal_no
                              ORDER BY x.as_of_date DESC NULLS LAST, x.row_no DESC LIMIT 1) l ON true
             ON CONFLICT (batch_id, terminal_no) DO UPDATE
               SET rows_count = EXCLUDED.rows_count, total_amount = EXCLUDED.total_amount, total_all_amount = EXCLUDED.total_all_amount,
                   first_row = EXCLUDED.first_row, shop_name = EXCLUDED.shop_name, owner_name = EXCLUDED.owner_name,
                   phone = EXCLUDED.phone, bank_name = EXCLUDED.bank_name, has_activity = EXCLUDED.has_activity`,
      [ctx.batchId]);

    await q(`UPDATE ${t} SET ${mark('FUTURE_DATE', 'as_of_date', 'تاریخ در آینده است')}
              WHERE err_code IS NULL AND NOT skipped AND as_of_date > $1::date`, [ctx.today]);

    await q(`UPDATE ${t} s SET period_id = p.period_id FROM periods p
              WHERE s.err_code IS NULL AND NOT s.skipped AND s.as_of_date >= p.start_date AND s.as_of_date < p.end_date`);
    await q(`UPDATE ${t} SET ${mark('PERIOD_NOT_FOUND', 'as_of_date', 'ماه شمسی این تاریخ در سامانه تعریف نشده است')}
              WHERE err_code IS NULL AND NOT skipped AND period_id IS NULL`);

    await q(`UPDATE ${t} s SET ${mark('DUPLICATE_IN_FILE', 'terminal_no', 'ترمینال و تاریخ در فایل تکراری است')}
               FROM (SELECT row_no, row_number() OVER (PARTITION BY terminal_id, as_of_date ORDER BY row_no) AS rn
                       FROM ${t} WHERE err_code IS NULL AND NOT skipped) d
              WHERE d.row_no = s.row_no AND d.rn > 1`);

    // یکنوایی داخل فایل: هر دو ردیفِ ناسازگار رد می‌شوند تا بعد از skip_invalid هم دیتابیس سازگار بماند
    await q(`UPDATE ${t} s SET ${mark('CUM_NON_MONOTONIC', 'amount', 'مانده‌ی تجمعی کاهش یافته است')}
               FROM (SELECT row_no, amount, tx_count,
                            lag(amount) OVER w AS pa, lag(tx_count) OVER w AS pc,
                            lead(amount) OVER w AS na, lead(tx_count) OVER w AS nc
                       FROM ${t} WHERE err_code IS NULL AND NOT skipped
                     WINDOW w AS (PARTITION BY terminal_id, period_id ORDER BY as_of_date)) w
              WHERE w.row_no = s.row_no AND s.err_code IS NULL
                AND (w.amount < w.pa OR w.tx_count < w.pc OR w.amount > w.na OR w.tx_count > w.nc)`);

    await neighborCheck(client, ctx);

    // نام بانک فایل ← بانک تعریف‌شده‌ی دفتر (تطبیق نرمال‌شده‌ی ی/ک/ارقام)
    await q(`UPDATE ${t} s SET bank_id = b.id
               FROM (SELECT DISTINCT ON (fa_normalize(name)) id, fa_normalize(name) AS nn FROM banks
                      WHERE office_id = $1 ORDER BY fa_normalize(name), id) b
              WHERE s.bank_name IS NOT NULL AND fa_normalize(s.bank_name) = b.nn`, [ctx.officeId]);

    const warnings: Record<string, number> = {};
    const one = async (sql: string, params: unknown[] = []): Promise<number> =>
      Number(((await q(sql, params)).rows[0] as { n: number }).n);
    warnings.old_date = await one(`SELECT count(*)::int AS n FROM ${t} WHERE err_code IS NULL AND NOT skipped AND as_of_date < $1::date - 7`, [ctx.today]);
    warnings.after_return = await one(`SELECT count(*)::int AS n FROM ${t} s JOIN terminals x ON x.office_id = $1 AND x.id = s.terminal_id
                          WHERE s.err_code IS NULL AND NOT s.skipped AND x.returned_at IS NOT NULL AND s.as_of_date > x.returned_at`, [ctx.officeId]);
    // مبلغ کل نمی‌تواند کمتر از مبلغ خرید باشد (خرید زیرمجموعه‌ی کل است)؛ فقط هشدار
    warnings.total_less_than_purchase = await one(
      `SELECT count(*)::int AS n FROM ${t} WHERE err_code IS NULL AND NOT skipped AND total_amount IS NOT NULL AND total_amount < amount`);
    warnings.unknown_bank = await one(
      `SELECT count(DISTINCT fa_normalize(bank_name))::int AS n FROM ${t} WHERE err_code IS NULL AND NOT skipped AND bank_name IS NOT NULL AND bank_id IS NULL`);
    return { warnings };
  },

  async recheck(client, ctx) {
    await neighborCheck(client, ctx);
  },

  async merge(client, ctx): Promise<MergeStats> {
    const t = ctx.table;
    const o = ctx.officeId;
    const source = ctx.options.source === 'monthly' ? 2 : 1;
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

    await q(`SELECT ensure_period_partition(period_id) FROM (SELECT DISTINCT period_id FROM ${t} WHERE err_code IS NULL AND NOT skipped) d`);
    // xmax روی جدول پارتیشن‌شده در دسترس نیست؛ شمارش insert/update از روی وجود قبلی کلید محاسبه می‌شود
    const pre = (await client.query<{ valid: number; existing: number }>(
      `SELECT count(*)::int AS valid, count(x.terminal_id)::int AS existing
         FROM ${t} s
         LEFT JOIN transactions_snapshot x
           ON x.office_id = $1 AND x.terminal_id = s.terminal_id AND x.as_of_date = s.as_of_date
        WHERE s.err_code IS NULL AND NOT s.skipped`, [o])).rows[0] ?? { valid: 0, existing: 0 };
    // فایلی که ستون «کل» ندارد، مبلغ کل قبلاً ثبت‌شده‌ی همان تاریخ را پاک نمی‌کند (COALESCE)
    const r = await client.query<{ changed: number }>(
      `WITH up AS (
         INSERT INTO transactions_snapshot AS x
           (office_id, terminal_id, as_of_date, cum_amount, cum_count, cum_total_amount, cum_total_count, source, import_batch_id)
         SELECT $1::int, s.terminal_id, s.as_of_date, s.amount, s.tx_count, s.total_amount, s.total_tx_count, $2::smallint, $3::bigint
           FROM ${t} s WHERE s.err_code IS NULL AND NOT s.skipped
          ORDER BY s.terminal_id, s.as_of_date
         ON CONFLICT (office_id, terminal_id, as_of_date) DO UPDATE
            SET cum_amount = EXCLUDED.cum_amount, cum_count = EXCLUDED.cum_count, source = EXCLUDED.source,
                cum_total_amount = COALESCE(EXCLUDED.cum_total_amount, x.cum_total_amount),
                cum_total_count = COALESCE(EXCLUDED.cum_total_count, x.cum_total_count),
                import_batch_id = EXCLUDED.import_batch_id, updated_at = now()
          WHERE (x.cum_amount, x.cum_count, x.source, x.cum_total_amount, x.cum_total_count)
                IS DISTINCT FROM
                (EXCLUDED.cum_amount, EXCLUDED.cum_count, EXCLUDED.source,
                 COALESCE(EXCLUDED.cum_total_amount, x.cum_total_amount), COALESCE(EXCLUDED.cum_total_count, x.cum_total_count))
         RETURNING x.terminal_id, x.as_of_date
       ), aff AS (
         INSERT INTO import_batch_affected (batch_id, terminal_id, period_id)
         SELECT DISTINCT $3::bigint, u.terminal_id, p.period_id
           FROM up u JOIN periods p ON u.as_of_date >= p.start_date AND u.as_of_date < p.end_date
         RETURNING 1
       )
       SELECT count(*)::int AS changed FROM up`,
      [o, source, ctx.batchId]);
    const changed = r.rows[0]?.changed ?? 0;
    const inserted = pre.valid - pre.existing; // کلیدهای جدید همگی درج می‌شوند
    const updated = Math.max(0, changed - inserted);

    const extra: Record<string, number> = {};
    const st = (await q(`SELECT sync_terminal_info AS sync, sync_create_banks AS banks FROM office_settings WHERE office_id = $1`, [o])).rows[0] as
      { sync: boolean; banks: boolean } | undefined;

    // ---- ۱) ترمینال‌های تعریف‌نشده ← صندوق pending_terminals (به‌همراه ردیف‌های تراکنششان)
    extra.pendingTerminals = await mergePending(client, ctx, source);

    // ---- ۲) همگام‌سازی اطلاعات ترمینال‌های موجود با فایل (اگر در تنظیمات فعال باشد)
    if (st?.sync !== false) {
      const s = await syncTerminalInfo(client, ctx, st?.banks !== false);
      extra.infoUpdated = s.updated;
      extra.bankChanges = s.bankChanges;
      extra.banksCreated = s.banksCreated;
    }
    return { inserted, updated, unchanged: Math.max(0, pre.existing - updated), extra };
  },
};

/**
 * ردیف‌های ترمینال ناشناخته (skipped) ← pending_terminals و pending_terminal_snapshots.
 * اطلاعات آخرین فایل (بر پایه‌ی تاریخ) ورودی صندوق را به‌روز می‌کند. ورودی «نادیده‌گرفته‌شده» (dismissed) دست نمی‌خورد.
 */
async function mergePending(client: pg.PoolClient, ctx: HandlerCtx, source: number): Promise<number> {
  const t = ctx.table;
  const o = ctx.officeId;
  await client.query(
    `CREATE TEMP TABLE unk ON COMMIT DROP AS
     SELECT DISTINCT ON (s.terminal_no, s.as_of_date) s.terminal_no, s.as_of_date, s.amount, s.tx_count, s.total_amount, s.total_tx_count,
            s.shop_name, s.owner_name, s.phone, s.address, s.bank_name
       FROM ${t} s
      WHERE s.skipped AND s.err_code IS NULL AND s.as_of_date IS NOT NULL AND s.as_of_date <= $1::date
      ORDER BY s.terminal_no, s.as_of_date, s.row_no DESC`, [ctx.today]);
  const up = await client.query(
    `INSERT INTO pending_terminals AS p
       (office_id, terminal_no, shop_name, owner_name, phone, address, bank_name, has_activity,
        last_as_of_date, last_amount, last_tx_count, last_total_amount, first_batch_id, last_batch_id)
     SELECT $1::int, l.terminal_no, l.shop_name, l.owner_name, l.phone, l.address, l.bank_name, a.has_activity,
            l.as_of_date, l.amount, l.tx_count, l.total_amount, $2::bigint, $2::bigint
       FROM (SELECT DISTINCT ON (terminal_no) * FROM unk ORDER BY terminal_no, as_of_date DESC) l
       JOIN (SELECT terminal_no, bool_or(COALESCE(amount, 0) > 0 OR COALESCE(total_amount, 0) > 0) AS has_activity
               FROM unk GROUP BY terminal_no) a ON a.terminal_no = l.terminal_no
     ON CONFLICT (office_id, terminal_no) DO UPDATE
        SET shop_name = COALESCE(EXCLUDED.shop_name, p.shop_name), owner_name = COALESCE(EXCLUDED.owner_name, p.owner_name),
            phone = COALESCE(EXCLUDED.phone, p.phone), address = COALESCE(EXCLUDED.address, p.address),
            bank_name = COALESCE(EXCLUDED.bank_name, p.bank_name), has_activity = p.has_activity OR EXCLUDED.has_activity,
            last_as_of_date = EXCLUDED.last_as_of_date, last_amount = EXCLUDED.last_amount, last_tx_count = EXCLUDED.last_tx_count,
            last_total_amount = EXCLUDED.last_total_amount, last_batch_id = EXCLUDED.last_batch_id, last_seen_at = now()
      WHERE p.status = 'pending' AND EXCLUDED.last_as_of_date >= p.last_as_of_date`,
    [o, ctx.batchId]);
  await client.query(
    `INSERT INTO pending_terminal_snapshots AS ps
       (office_id, terminal_no, as_of_date, cum_amount, cum_count, cum_total_amount, cum_total_count, source, import_batch_id)
     SELECT $1::int, u.terminal_no, u.as_of_date, u.amount, u.tx_count, u.total_amount, u.total_tx_count, $2::smallint, $3::bigint
       FROM unk u JOIN pending_terminals p ON p.office_id = $1 AND p.terminal_no = u.terminal_no AND p.status = 'pending'
     ON CONFLICT (office_id, terminal_no, as_of_date) DO UPDATE
        SET cum_amount = EXCLUDED.cum_amount, cum_count = EXCLUDED.cum_count,
            cum_total_amount = COALESCE(EXCLUDED.cum_total_amount, ps.cum_total_amount),
            cum_total_count = COALESCE(EXCLUDED.cum_total_count, ps.cum_total_count),
            source = EXCLUDED.source, import_batch_id = EXCLUDED.import_batch_id`,
    [o, source, ctx.batchId]);
  return up.rowCount ?? 0;
}

interface SyncStats { updated: number; bankChanges: number; banksCreated: number }

/**
 * اطلاعات ترمینال (نام فروشگاه، مالک، موبایل، آدرس، بانک) از آخرین ردیف هر ترمینال در فایل با دیتابیس مقایسه و در صورت مغایرت
 * به‌روز می‌شود. قواعد:
 *  - سلول خالی در فایل = بدون تغییر.
 *  - فایلِ قدیمی‌تر از آخرین فایلِ همگام‌شده‌ی آن ترمینال (terminals.info_as_of) هرگز اطلاعات را بازنویسی نمی‌کند.
 *  - هر تغییر در audit_log با کاربر ایمپورت و شناسه‌ی دسته ثبت می‌شود (قبل/بعد).
 *  - تغییر بانک در تاریخچه‌ی SCD2 ثبت می‌شود؛ تاریخ اعمال = تاریخ فایل (نه قبل از شروع ردیف جاری، نه بعد از امروز).
 *  - بانکِ ناشناخته: در صورت فعال‌بودن تنظیم «ساخت خودکار بانک» تعریف می‌شود، وگرنه بانک ترمینال بدون تغییر می‌ماند.
 */
async function syncTerminalInfo(client: pg.PoolClient, ctx: HandlerCtx, createBanks: boolean): Promise<SyncStats> {
  const t = ctx.table;
  const [o, u, b] = [ctx.officeId, ctx.userId, ctx.batchId];
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

  await q(`CREATE TEMP TABLE info ON COMMIT DROP AS
           SELECT DISTINCT ON (s.terminal_id) s.terminal_id, s.as_of_date, s.shop_name, s.owner_name, s.phone, s.address, s.bank_name, s.bank_id
             FROM ${t} s WHERE s.err_code IS NULL AND NOT s.skipped AND s.terminal_id IS NOT NULL
            ORDER BY s.terminal_id, s.as_of_date DESC, s.row_no DESC`);

  let banksCreated = 0;
  if (createBanks) {
    const nb = await q(
      `WITH nb AS (
         INSERT INTO banks (office_id, name)
         SELECT $1::int, x.name FROM (SELECT DISTINCT ON (fa_normalize(bank_name)) btrim(bank_name) AS name
                                        FROM info WHERE bank_id IS NULL AND bank_name IS NOT NULL
                                        ORDER BY fa_normalize(bank_name), bank_name) x
         ON CONFLICT (office_id, name) DO NOTHING RETURNING id, name)
       INSERT INTO audit_log (office_id, user_id, batch_id, entity_type, entity_id, action, before, after)
       SELECT $1::int, $2::int, $3::bigint, 'bank', nb.id, 'create', NULL, jsonb_build_object('name', nb.name, 'source', 'transactions_file')
         FROM nb`, [o, u, b]);
    banksCreated = nb.rowCount ?? 0;
    if (banksCreated > 0) {
      await q(`UPDATE info i SET bank_id = x.id
                 FROM (SELECT DISTINCT ON (fa_normalize(name)) id, fa_normalize(name) AS nn FROM banks WHERE office_id = $1
                        ORDER BY fa_normalize(name), id) x
                WHERE i.bank_id IS NULL AND i.bank_name IS NOT NULL AND fa_normalize(i.bank_name) = x.nn`, [o]);
    }
  }

  await q(`CREATE TEMP TABLE chg ON COMMIT DROP AS
    SELECT * FROM (
      SELECT i.terminal_id, i.as_of_date,
             t.shop_name AS o_shop, t.owner_name AS o_owner, t.phone AS o_phone, t.address AS o_address, t.bank_id AS o_bank,
             COALESCE(i.shop_name, t.shop_name) AS n_shop, COALESCE(i.owner_name, t.owner_name) AS n_owner,
             COALESCE(i.phone, t.phone) AS n_phone, COALESCE(i.address, t.address) AS n_address,
             COALESCE(i.bank_id, t.bank_id) AS n_bank
        FROM info i JOIN terminals t ON t.office_id = $1 AND t.id = i.terminal_id
       WHERE t.info_as_of IS NULL OR i.as_of_date >= t.info_as_of) q`, [o]);

  // آخرین تاریخ فایلِ همگام‌شده برای همه‌ی ترمینال‌های داخل فایل (حتی بدون مغایرت) ثبت می‌شود
  await q(`UPDATE terminals t SET info_as_of = c.as_of_date FROM chg c WHERE t.office_id = $1 AND t.id = c.terminal_id`, [o]);
  await q(`DELETE FROM chg WHERE (n_shop, n_owner, n_phone, n_address, n_bank) IS NOT DISTINCT FROM (o_shop, o_owner, o_phone, o_address, o_bank)`);

  const updated = Number(((await q('SELECT count(*)::int AS n FROM chg')).rows[0] as { n: number }).n);
  if (updated === 0) return { updated: 0, bankChanges: 0, banksCreated };

  // ---- audit (قبل از به‌روزرسانی؛ فقط فیلدهای تغییرکرده)
  const pairs = `(VALUES ('shopName', to_jsonb(c.o_shop), to_jsonb(c.n_shop)), ('ownerName', to_jsonb(c.o_owner), to_jsonb(c.n_owner)),
      ('phone', to_jsonb(c.o_phone), to_jsonb(c.n_phone)), ('address', to_jsonb(c.o_address), to_jsonb(c.n_address)),
      ('bankId', to_jsonb(c.o_bank), to_jsonb(c.n_bank))) v(k, o, n)`;
  await q(`INSERT INTO audit_log (office_id, user_id, batch_id, entity_type, entity_id, action, before, after)
           SELECT $1::int, $2::int, $3::bigint, 'terminal', c.terminal_id, 'import',
                  (SELECT jsonb_object_agg(v.k, v.o) FROM ${pairs} WHERE v.o IS DISTINCT FROM v.n),
                  (SELECT jsonb_object_agg(v.k, v.n) FROM ${pairs} WHERE v.o IS DISTINCT FROM v.n)
             FROM chg c`, [o, u, b]);

  // ---- تغییر بانک ← تاریخچه (SCD2)
  await q(`ALTER TABLE chg ADD COLUMN bank_changed boolean, ADD COLUMN open_id bigint, ADD COLUMN open_start date, ADD COLUMN eff date`);
  await q(`UPDATE chg SET bank_changed = n_bank IS DISTINCT FROM o_bank`);
  await q(`UPDATE chg c SET open_id = h.id, open_start = h.start_date
             FROM terminal_supporter_history h
            WHERE c.bank_changed AND h.office_id = $1 AND h.terminal_id = c.terminal_id AND h.end_date IS NULL`, [o]);
  await q(`UPDATE chg SET eff = LEAST(GREATEST(as_of_date, open_start), $1::date) WHERE bank_changed AND open_id IS NOT NULL`, [ctx.today]);
  // تاریخ اعمال = شروع ردیف جاری ← همان ردیف اصلاح می‌شود
  await q(`UPDATE terminal_supporter_history h SET bank_id = COALESCE(c.n_bank, 0), changed_by = $1
             FROM chg c WHERE c.bank_changed AND c.open_id = h.id AND c.eff = c.open_start`, [u]);
  // وگرنه ابتدا ردیف جاری بسته می‌شود (قید عدم‌هم‌پوشانی) و بعد ردیف تازه باز می‌شود
  await q(`UPDATE terminal_supporter_history h SET end_date = c.eff
             FROM chg c WHERE c.bank_changed AND c.open_id = h.id AND c.eff > c.open_start`);
  await q(`INSERT INTO terminal_supporter_history (office_id, terminal_id, supporter_id, staff_unit_id, route_group_id, bank_id, start_date, changed_by)
           SELECT $1::int, h.terminal_id, h.supporter_id, h.staff_unit_id, h.route_group_id, COALESCE(c.n_bank, 0), c.eff, $2::int
             FROM chg c JOIN terminal_supporter_history h ON h.id = c.open_id
            WHERE c.bank_changed AND c.eff > c.open_start`, [o, u]);
  await q(`INSERT INTO recompute_outbox (office_id, terminal_id, effective_date, reason)
           SELECT $1::int, c.terminal_id, c.eff, 'assignment' FROM chg c WHERE c.bank_changed AND c.eff IS NOT NULL`, [o]);

  await q(`UPDATE terminals t
              SET shop_name = c.n_shop, owner_name = c.n_owner, phone = c.n_phone, address = c.n_address, bank_id = c.n_bank,
                  search_norm = fa_normalize(concat_ws(' ', t.terminal_no, c.n_shop, c.n_owner)), updated_at = now()
             FROM chg c WHERE t.office_id = $1 AND t.id = c.terminal_id`, [o]);

  const bankChanges = Number(((await q('SELECT count(*)::int AS n FROM chg WHERE bank_changed')).rows[0] as { n: number }).n);
  return { updated, bankChanges, banksCreated };
}
