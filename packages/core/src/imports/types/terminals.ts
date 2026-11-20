import {
  cellToText, normalizeSearchText, normalizeTerminalNo, parseDateCell, toEnglishDigits, type CalendarHint,
} from '@pos/shared';
import { adoptPendingRows } from '../../pending/adopt';
import type { HandlerCtx, Lookups, MergeStats, TypeHandler } from '../types';

const COLS = [
  'row_no', 'terminal_no', 'shop_name', 'owner_name', 'phone', 'address', 'supporter_id', 'route_group_id',
  'bank_id', 'installed_at', 'returned_at', 'err_code', 'err_col', 'err_msg',
] as const;

type Err = { code: string; col: string; msg: string };

function text(raw: unknown, max: number, col: string, errRef: { e?: Err }): string | null {
  const t = cellToText(raw).replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  if (t.length > max) {
    errRef.e ??= { code: 'TOO_LONG', col, msg: `حداکثر ${max} کاراکتر مجاز است` };
    return t.slice(0, max);
  }
  return t;
}

function resolveName(map: Map<string, number[]>, raw: unknown, col: string, label: string, errRef: { e?: Err }): number | null {
  const name = normalizeSearchText(cellToText(raw));
  if (name === '') return null;
  const hits = map.get(name);
  if (!hits || hits.length === 0) {
    errRef.e ??= { code: `${col.toUpperCase()}_NOT_FOUND`, col, msg: `${label} «${cellToText(raw)}» تعریف نشده است` };
    return null;
  }
  if (hits.length > 1) {
    errRef.e ??= { code: `${col.toUpperCase()}_AMBIGUOUS`, col, msg: `${label} «${cellToText(raw)}» چندمعنایی است` };
    return null;
  }
  return hits[0] ?? null;
}

function date(raw: unknown, col: string, cal: CalendarHint, errRef: { e?: Err }): string | null {
  const r = parseDateCell(raw, cal);
  if (r.ok) return r.value;
  if (r.code === 'BAD_DATE') errRef.e ??= { code: 'BAD_DATE', col, msg: 'تاریخ نامعتبر است' };
  return null;
}

/** ایجاد و ویرایش ترمینال با کلید «شماره ترمینال». سلول خالی یعنی «بدون تغییر». */
export const terminalsHandler: TypeHandler = {
  type: 'terminals',
  copyColumns: COLS,

  createTableSql: (t) => `CREATE UNLOGGED TABLE ${t} (
    row_no integer NOT NULL, terminal_no text, shop_name text, owner_name text, phone text, address text,
    supporter_id integer, route_group_id integer, bank_id integer, installed_at date, returned_at date,
    err_code text, err_col text, err_msg text,
    terminal_id bigint, is_new boolean NOT NULL DEFAULT false, skipped boolean NOT NULL DEFAULT false)`,

  indexSql: (t) => [`CREATE INDEX ON ${t} (row_no)`, `CREATE INDEX ON ${t} (terminal_no)`],

  async prepare() {},

  toRow(rowNo, raw, ctx) {
    const errRef: { e?: Err } = {};
    const terminalNo = normalizeTerminalNo(cellToText(raw.terminal_no));
    if (terminalNo === '') errRef.e = { code: 'EMPTY_TERMINAL_NO', col: 'terminal_no', msg: 'شماره ترمینال خالی است' };
    else if (terminalNo.length > 32) errRef.e = { code: 'BAD_TERMINAL_NO', col: 'terminal_no', msg: 'شماره ترمینال بیش از ۳۲ کاراکتر است' };

    const shop = text(raw.shop_name, 200, 'shop_name', errRef);
    const owner = text(raw.owner_name, 200, 'owner_name', errRef);
    const address = text(raw.address, 500, 'address', errRef);
    const phoneTxt = toEnglishDigits(cellToText(raw.phone)).replace(/[\s-]/g, '');
    const phone = phoneTxt === '' ? null : phoneTxt.slice(0, 30);

    const supporter = resolveName(ctx.lookups.supporters, raw.supporter_name, 'supporter_name', 'پشتیبان', errRef);
    const route = resolveName(ctx.lookups.routes, raw.route_name, 'route_name', 'مسیر', errRef);
    const bank = resolveName(ctx.lookups.banks, raw.bank_name, 'bank_name', 'بانک', errRef);
    const installed = date(raw.installed_at, 'installed_at', ctx.options.calendar, errRef);
    const returned = date(raw.returned_at, 'returned_at', ctx.options.calendar, errRef);

    return [rowNo, terminalNo === '' ? null : terminalNo, shop, owner, phone, address, supporter, route, bank,
      installed, returned, errRef.e?.code ?? null, errRef.e?.col ?? null, errRef.e?.msg ?? null];
  },

  async validate(client, ctx) {
    const t = ctx.table;
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
    const mark = (code: string, col: string, msg: string): string =>
      `err_code = '${code}', err_col = '${col}', err_msg = '${msg}'`;

    await q(`UPDATE ${t} s SET terminal_id = x.id FROM terminals x WHERE x.office_id = $1 AND x.terminal_no = s.terminal_no`, [ctx.officeId]);
    await q(`UPDATE ${t} SET is_new = true WHERE terminal_id IS NULL AND terminal_no IS NOT NULL`);

    await q(`UPDATE ${t} s SET ${mark('DUPLICATE_IN_FILE', 'terminal_no', 'شماره ترمینال در فایل تکراری است')}
               FROM (SELECT row_no, row_number() OVER (PARTITION BY terminal_no ORDER BY row_no) AS rn
                       FROM ${t} WHERE terminal_no IS NOT NULL) d
              WHERE d.row_no = s.row_no AND d.rn > 1 AND s.err_code IS NULL`);

    await q(`UPDATE ${t} SET ${mark('SUPPORTER_REQUIRED', 'supporter_name', 'برای ترمینال جدید پشتیبان الزامی است')}
              WHERE is_new AND supporter_id IS NULL AND err_code IS NULL`);

    // تاریخ اعمال تغییر پشتیبان/مسیر/بانک نباید قبل از شروع تخصیص جاری باشد
    await q(`UPDATE ${t} s SET ${mark('EFFECTIVE_BEFORE_START', 'supporter_name', 'تاریخ اعمال قبل از شروع تخصیص جاری است')}
               FROM terminals x
               JOIN terminal_supporter_history h ON h.office_id = x.office_id AND h.terminal_id = x.id AND h.end_date IS NULL
              WHERE x.office_id = $1 AND x.id = s.terminal_id AND NOT s.is_new AND s.err_code IS NULL
                AND h.start_date > $2::date
                AND ((s.supporter_id IS NOT NULL AND s.supporter_id <> x.current_supporter_id)
                  OR (s.route_group_id IS NOT NULL AND s.route_group_id IS DISTINCT FROM x.route_group_id)
                  OR (s.bank_id IS NOT NULL AND s.bank_id IS DISTINCT FROM x.bank_id))`,
      [ctx.officeId, ctx.effectiveDate]);

    // انصراف قبل از نصب (با مقادیر مؤثر پس از merge)
    await q(`UPDATE ${t} s SET ${mark('RETURN_BEFORE_INSTALL', 'returned_at', 'تاریخ انصراف قبل از تاریخ نصب است')}
               FROM terminals x
              WHERE x.office_id = $1 AND x.id = s.terminal_id AND NOT s.is_new AND s.err_code IS NULL
                AND COALESCE(x.returned_at, s.returned_at) < COALESCE(s.installed_at, x.installed_at)`, [ctx.officeId]);
    await q(`UPDATE ${t} SET ${mark('RETURN_BEFORE_INSTALL', 'returned_at', 'تاریخ انصراف قبل از تاریخ نصب است')}
              WHERE is_new AND err_code IS NULL AND returned_at < installed_at`);
    return { warnings: {} };
  },

  async recheck() {},

  async merge(client, ctx): Promise<MergeStats> {
    const t = ctx.table;
    const [o, u, b] = [ctx.officeId, ctx.userId, ctx.batchId];
    const eff = ctx.effectiveDate;
    const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

    // ---- ترمینال‌های موجود که واقعاً تغییر می‌کنند
    await q(`CREATE TEMP TABLE chg ON COMMIT DROP AS
      SELECT * FROM (
        SELECT s.row_no, s.terminal_id, t.terminal_no,
               t.owner_name AS o_owner, t.phone AS o_phone, t.address AS o_address, t.shop_name AS o_shop,
               t.installed_at AS o_installed, t.returned_at AS o_returned,
               t.current_supporter_id AS o_sup, t.current_unit_id AS o_unit, t.route_group_id AS o_route, t.bank_id AS o_bank,
               COALESCE(s.owner_name, t.owner_name) AS n_owner, COALESCE(s.phone, t.phone) AS n_phone,
               COALESCE(s.address, t.address) AS n_address, COALESCE(s.shop_name, t.shop_name) AS n_shop,
               COALESCE(s.installed_at, t.installed_at) AS n_installed, COALESCE(t.returned_at, s.returned_at) AS n_returned,
               COALESCE(s.supporter_id, t.current_supporter_id) AS n_sup, sp.staff_unit_id AS n_unit,
               COALESCE(s.route_group_id, t.route_group_id) AS n_route, COALESCE(s.bank_id, t.bank_id) AS n_bank
          FROM ${t} s
          JOIN terminals t ON t.office_id = $1 AND t.id = s.terminal_id
          JOIN supporters sp ON sp.office_id = $1 AND sp.id = COALESCE(s.supporter_id, t.current_supporter_id)
         WHERE s.err_code IS NULL AND NOT s.skipped AND NOT s.is_new) q
       WHERE (q.n_owner, q.n_phone, q.n_address, q.n_shop, q.n_installed, q.n_returned, q.n_sup, q.n_route, q.n_bank)
             IS DISTINCT FROM
             (q.o_owner, q.o_phone, q.o_address, q.o_shop, q.o_installed, q.o_returned, q.o_sup, q.o_route, q.o_bank)`, [o]);
    await q(`ALTER TABLE chg ADD COLUMN assign_changed boolean, ADD COLUMN inplace boolean NOT NULL DEFAULT false`);
    await q(`UPDATE chg SET assign_changed = (n_sup, n_route, n_bank) IS DISTINCT FROM (o_sup, o_route, o_bank)`);

    // ---- audit (قبل از به‌روزرسانی؛ فقط فیلدهای تغییرکرده)
    const pairs = `(VALUES ('ownerName', to_jsonb(c.o_owner), to_jsonb(c.n_owner)),
        ('phone', to_jsonb(c.o_phone), to_jsonb(c.n_phone)), ('address', to_jsonb(c.o_address), to_jsonb(c.n_address)),
        ('shopName', to_jsonb(c.o_shop), to_jsonb(c.n_shop)), ('installedAt', to_jsonb(c.o_installed), to_jsonb(c.n_installed)),
        ('returnedAt', to_jsonb(c.o_returned), to_jsonb(c.n_returned)), ('supporterId', to_jsonb(c.o_sup), to_jsonb(c.n_sup)),
        ('routeGroupId', to_jsonb(c.o_route), to_jsonb(c.n_route)), ('bankId', to_jsonb(c.o_bank), to_jsonb(c.n_bank))) v(k, o, n)`;
    await q(`INSERT INTO audit_log (office_id, user_id, batch_id, entity_type, entity_id, action, before, after)
             SELECT $1::int, $2::int, $3::bigint, 'terminal', c.terminal_id, 'import',
                    (SELECT jsonb_object_agg(v.k, v.o) FROM ${pairs} WHERE v.o IS DISTINCT FROM v.n),
                    (SELECT jsonb_object_agg(v.k, v.n) FROM ${pairs} WHERE v.o IS DISTINCT FROM v.n)
               FROM chg c`, [o, u, b]);

    // ---- تاریخچه‌ی پشتیبان/مسیر/بانک (SCD2): ردیف هم‌تاریخ اصلاح می‌شود، وگرنه بسته و ردیف جدید باز می‌شود
    await q(`UPDATE chg c SET inplace = true FROM terminal_supporter_history h
              WHERE c.assign_changed AND h.office_id = $1 AND h.terminal_id = c.terminal_id
                AND h.end_date IS NULL AND h.start_date = $2::date`, [o, eff]);
    await q(`UPDATE terminal_supporter_history h
                SET supporter_id = c.n_sup, staff_unit_id = c.n_unit, route_group_id = COALESCE(c.n_route, 0),
                    bank_id = COALESCE(c.n_bank, 0), changed_by = $2
               FROM chg c WHERE c.assign_changed AND c.inplace AND h.office_id = $1 AND h.terminal_id = c.terminal_id
                AND h.end_date IS NULL`, [o, u]);
    await q(`UPDATE terminal_supporter_history h SET end_date = $2::date
               FROM chg c WHERE c.assign_changed AND NOT c.inplace AND h.office_id = $1 AND h.terminal_id = c.terminal_id
                AND h.end_date IS NULL`, [o, eff]);
    await q(`INSERT INTO terminal_supporter_history
               (office_id, terminal_id, supporter_id, staff_unit_id, route_group_id, bank_id, start_date, changed_by)
             SELECT $1::int, c.terminal_id, c.n_sup, c.n_unit, COALESCE(c.n_route, 0), COALESCE(c.n_bank, 0), $2::date, $3::int
               FROM chg c WHERE c.assign_changed AND NOT c.inplace`, [o, eff, u]);

    await q(`UPDATE terminals t
                SET owner_name = c.n_owner, phone = c.n_phone, address = c.n_address, shop_name = c.n_shop,
                    installed_at = c.n_installed, returned_at = c.n_returned,
                    status = CASE WHEN c.n_returned IS NULL THEN 'active' ELSE 'returned' END,
                    route_group_id = c.n_route, bank_id = c.n_bank,
                    current_supporter_id = c.n_sup, current_unit_id = c.n_unit,
                    search_norm = fa_normalize(concat_ws(' ', t.terminal_no, c.n_shop, c.n_owner)), updated_at = now()
               FROM chg c WHERE t.office_id = $1 AND t.id = c.terminal_id`, [o]);

    // ---- صندوق خروجی بازمحاسبه‌ی آمار (فاز ۳ مصرف می‌کند)
    await q(`INSERT INTO recompute_outbox (office_id, terminal_id, effective_date, reason)
             SELECT $1::int, c.terminal_id, $2::date, 'assignment'::text FROM chg c WHERE c.assign_changed
             UNION ALL
             SELECT $1::int, c.terminal_id, LEAST(c.o_installed, c.n_installed), 'installed_at'::text FROM chg c
              WHERE c.o_installed IS DISTINCT FROM c.n_installed
             UNION ALL
             SELECT $1::int, c.terminal_id, c.n_returned, 'returned_at'::text FROM chg c
              WHERE c.o_returned IS DISTINCT FROM c.n_returned AND c.n_returned IS NOT NULL`, [o, eff]);

    // ---- ترمینال‌های جدید
    const ins = await q(`INSERT INTO terminals
        (office_id, terminal_no, owner_name, phone, address, shop_name, route_group_id, bank_id, installed_at, returned_at,
         status, current_supporter_id, current_unit_id, search_norm)
      SELECT $1::int, s.terminal_no, s.owner_name, s.phone, s.address, s.shop_name, s.route_group_id, s.bank_id, s.installed_at,
             s.returned_at, CASE WHEN s.returned_at IS NULL THEN 'active' ELSE 'returned' END, s.supporter_id,
             sp.staff_unit_id, fa_normalize(concat_ws(' ', s.terminal_no, s.shop_name, s.owner_name))
        FROM ${t} s JOIN supporters sp ON sp.office_id = $1 AND sp.id = s.supporter_id
       WHERE s.is_new AND s.err_code IS NULL AND NOT s.skipped
       ORDER BY s.row_no`, [o]);
    await q(`INSERT INTO terminal_supporter_history
               (office_id, terminal_id, supporter_id, staff_unit_id, route_group_id, bank_id, start_date, changed_by)
             SELECT $1::int, t.id, t.current_supporter_id, t.current_unit_id, COALESCE(t.route_group_id, 0),
                    COALESCE(t.bank_id, 0), COALESCE(t.installed_at, DATE '2000-01-01'), $2::int
               FROM terminals t JOIN ${t} s ON s.terminal_no = t.terminal_no
              WHERE t.office_id = $1 AND s.is_new AND s.err_code IS NULL AND NOT s.skipped`, [o, u]);
    await q(`INSERT INTO audit_log (office_id, user_id, batch_id, entity_type, entity_id, action, before, after)
             SELECT $1::int, $2::int, $3::bigint, 'terminal', t.id, 'import', NULL,
                    jsonb_build_object('terminalNo', t.terminal_no, 'supporterId', t.current_supporter_id,
                      'unitId', t.current_unit_id, 'shopName', t.shop_name, 'ownerName', t.owner_name,
                      'routeGroupId', t.route_group_id, 'bankId', t.bank_id)
               FROM terminals t JOIN ${t} s ON s.terminal_no = t.terminal_no
              WHERE t.office_id = $1 AND s.is_new AND s.err_code IS NULL AND NOT s.skipped`, [o, u, b]);

    // ترمینال جدید: از ماه نصب (یا ماه جاری) تا الان در تجمیع وارد می‌شود
    await q(`INSERT INTO recompute_outbox (office_id, terminal_id, effective_date, reason)
             SELECT $1::int, t.id, COALESCE(t.installed_at, $2::date), 'import'::text
               FROM terminals t JOIN ${t} s ON s.terminal_no = t.terminal_no
              WHERE t.office_id = $1 AND s.is_new AND s.err_code IS NULL AND NOT s.skipped`, [o, ctx.today]);

    // اگر ترمینال‌های جدید قبلاً در صندوق «تعریف‌نشده‌ها» بودند، ردیف‌های تراکنششان وارد آمار می‌شود
    const adopted = await adoptPendingRows(client, o, u);

    const inserted = ins.rowCount ?? 0;
    const updated = Number(((await q('SELECT count(*)::int AS n FROM chg')).rows[0] as { n: number }).n);
    const valid = Number(((await q(`SELECT count(*)::int AS n FROM ${t} WHERE err_code IS NULL AND NOT skipped`)).rows[0] as { n: number }).n);
    return { inserted, updated, unchanged: Math.max(0, valid - inserted - updated), extra: { pendingResolved: adopted.resolved } };
  },
};

export type { Lookups, HandlerCtx };
