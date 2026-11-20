import type pg from 'pg';
import { createLogger, createPools, hashPassword, loadEnv, runForecastOffice, runRebuild, withTx } from '@pos/core';
import { addDaysIso, periodIdOfDate, todayInTehran } from '@pos/shared';
import { stringArg } from './_args';

/**
 * داده‌ی نمایشی «واقع‌نما» (نام فارسی، ستاد/پشتیبان/مسیر/بانک، ترمینال، ۱۴ ماه تراکنش، پروژه، کاربر):
 *   npm run seed:demo                  (دفتر demo؛ اگر وجود داشته باشد متوقف می‌شود)
 *   npm run seed:demo -- --reset       (دفتر demo را پاک و دوباره می‌سازد)
 * گزینه‌ها: --office=demo  --terminals=640  --months=14  --password=demo1234
 * پیش‌نیاز: npm run db:migrate && npm run db:seed-periods
 * همه‌ی کاربران یک رمز دارند. ورود فقط با نام کاربری و رمز است (admin / demo1234).
 */
const code = stringArg('office') ?? 'demo';
const N = Number(stringArg('terminals') ?? 640);
const MONTHS = Number(stringArg('months') ?? 14);
const PASSWORD = stringArg('password') ?? 'demo1234';
const reset = process.argv.includes('--reset');
if (!Number.isInteger(N) || N < 50 || N > 20_000) throw new Error('--terminals باید بین ۵۰ و ۲۰۰۰۰ باشد');
if (!Number.isInteger(MONTHS) || MONTHS < 5 || MONTHS > 36) throw new Error('--months باید بین ۵ و ۳۶ باشد');

const env = loadEnv();
const logger = createLogger(env, 'seed-demo');
const pools = createPools(env, logger, 'pos-seed-demo');
const pool = pools.write;
const today = todayInTehran();
const t0 = Date.now();
const lap = (m: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// ---------------------------------------------------------------- تصادفی قطعی (هر بار همان داده)
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(14050805);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const between = (a: number, b: number): number => a + rnd() * (b - a);
const int = (a: number, b: number): number => Math.floor(between(a, b + 1));
function weighted<T>(items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((x, y) => x + y, 0);
  let r = rnd() * total;
  for (let i = 0; i < items.length; i += 1) { r -= weights[i] as number; if (r <= 0) return items[i] as T; }
  return items[items.length - 1] as T;
}

// ---------------------------------------------------------------- داده‌ی پایه
const FIRST_M = ['علی', 'محمد', 'رضا', 'حسین', 'مهدی', 'امیر', 'سعید', 'مجید', 'بهروز', 'کامران', 'پیمان', 'فرهاد', 'حمید', 'ناصر', 'سینا', 'آرش'];
const FIRST_F = ['زهرا', 'مریم', 'فاطمه', 'سارا', 'نرگس', 'الهه', 'مینا', 'لیلا', 'شیوا', 'پریسا', 'نسترن', 'مهسا', 'الهام', 'ساناز', 'هستی', 'شبنم'];
const LAST = ['احمدی', 'محمدی', 'رضایی', 'حسینی', 'کریمی', 'جعفری', 'موسوی', 'صادقی', 'قاسمی', 'نوری', 'اکبری', 'رحیمی', 'سلیمانی', 'فرهادی', 'شریفی', 'بهرامی', 'مرادی', 'یوسفی', 'کاظمی', 'عباسی', 'طاهری', 'هاشمی', 'زارعی', 'نجفی', 'امینی', 'صفایی', 'دهقان', 'مهدوی'];
const personName = (): string => `${rnd() < 0.55 ? pick(FIRST_M) : pick(FIRST_F)} ${pick(LAST)}`;

const UNITS: Array<{ name: string; routes: string[] }> = [
  { name: 'ستاد شمال', routes: ['تجریش و نیاوران', 'سعادت‌آباد', 'پاسداران'] },
  { name: 'ستاد جنوب', routes: ['شوش', 'جوادیه', 'شهرری'] },
  { name: 'ستاد شرق', routes: ['نارمک', 'تهرانپارس', 'پیروزی'] },
  { name: 'ستاد غرب', routes: ['شهرک غرب', 'جنت‌آباد', 'اکباتان'] },
];
const BANKS: Array<[string, number]> = [['بانک ملی', 30], ['بانک ملت', 22], ['بانک صادرات', 16], ['بانک تجارت', 12], ['پارسیان', 12], ['سامان', 8]];
const STREETS = ['ولیعصر', 'شریعتی', 'کارگر', 'انقلاب', 'آزادی', 'مطهری', 'پیروزی', 'دماوند', 'ستارخان', 'فاطمی', 'جمهوری', 'بهار', 'نیاوران', 'سی‌متری جی', 'ازگل', 'مولوی'];
const BRANDS = ['نگین', 'آفتاب', 'سپهر', 'بهار', 'پارس', 'گلستان', 'مهر', 'نیکان', 'آریا', 'ستاره', 'دریا', 'طوبی', 'رز', 'سروش', 'آرمان', 'هستی', 'یاس', 'کیان', 'سحر', 'ماهان'];
/** نوع کسب‌وکار: [نام، حداقل و حداکثر گردش ماهانه (ریال)، میانگین مبلغ هر تراکنش (ریال)] */
const TYPES: Array<[string, number, number, number]> = [
  ['سوپرمارکت', 400e6, 1400e6, 420e3], ['نانوایی', 250e6, 700e6, 90e3], ['داروخانه', 600e6, 2200e6, 650e3],
  ['رستوران', 500e6, 1800e6, 900e3], ['فست‌فود', 300e6, 1100e6, 520e3], ['پوشاک', 200e6, 1200e6, 1.4e6],
  ['لوازم خانگی', 400e6, 2500e6, 6e6], ['کافه', 150e6, 600e6, 380e3], ['قنادی', 200e6, 800e6, 450e3],
  ['میوه و تره‌بار', 150e6, 500e6, 300e3], ['کتاب‌فروشی', 60e6, 300e6, 480e3], ['لوازم یدکی', 200e6, 900e6, 2.2e6],
  ['طلا و جواهر', 800e6, 3500e6, 12e6], ['آرایشگاه', 60e6, 250e6, 700e3],
];
/** ضریب فصلی بر اساس ماه شمسی (فروردین و اسفند: نوروز) */
const SEASON = [1.22, 1.05, 1.0, 0.96, 0.92, 0.94, 1.0, 1.04, 1.02, 1.0, 1.06, 1.3];
const RETURN_REASONS = ['تعطیلی فروشگاه', 'انتقال به بانک دیگر', 'عدم استفاده', 'تغییر کاربری واحد', 'درخواست پذیرنده'];
const NOTES = ['مراجعه حضوری انجام شد', 'پذیرنده در دسترس نبود', 'نیازمند پیگیری مجدد', 'هماهنگی تلفنی انجام شد', 'قطعه موجود نبود'];

const sql = {
  async reset(c: pg.PoolClient, officeId: number): Promise<void> {
    await c.query('DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE office_id = $1)', [officeId]);
    const tables = (await c.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = current_schema() AND c.column_name = 'office_id'
          AND c.table_name !~ '^(transactions_snapshot_|audit_log_)'`)).rows.map((r) => r.table_name);
    // ترتیب وابستگی مشخص نیست؛ هر جدولی که به‌خاطر FK پاک نشد در دور بعد دوباره تلاش می‌شود
    let pending = tables;
    for (let pass = 0; pass < 12 && pending.length > 0; pass += 1) {
      const next: string[] = [];
      for (const t of pending) {
        await c.query('SAVEPOINT del');
        try { await c.query(`DELETE FROM ${t} WHERE office_id = $1`, [officeId]); await c.query('RELEASE SAVEPOINT del'); } catch { await c.query('ROLLBACK TO SAVEPOINT del'); await c.query('RELEASE SAVEPOINT del'); next.push(t); }
      }
      pending = next;
    }
    if (pending.length > 0) throw new Error(`پاک‌سازی کامل نشد: ${pending.join(', ')}`);
    await c.query('DELETE FROM offices WHERE id = $1', [officeId]);
  },
};

interface Sup { id: number; unitIdx: number; unitId: number; name: string }
interface Term {
  no: string; owner: string; phone: string; addr: string; shop: string; sup: Sup; routeId: number; bankId: number;
  installed: string; returned: string | null; reason: string | null; base: number; ticket: number; factor: number; dropped: boolean; id: number;
}

try {
  const existing = (await pool.query<{ id: number }>('SELECT id FROM offices WHERE code = $1', [code])).rows[0];
  if (existing && !reset) throw new Error(`دفتر «${code}» از قبل وجود دارد. برای ساخت دوباره: npm run seed:demo -- --reset`);
  if (existing) { await withTx(pool, (c) => sql.reset(c, existing.id)); lap('دفتر قبلی پاک شد'); }

  const hash = await hashPassword(PASSWORD);
  const startedPeriods = (await pool.query<{ period_id: number; sd: string; ed: string; days: number }>(
    `SELECT period_id, start_date::text AS sd, end_date::text AS ed, (end_date - start_date)::int AS days FROM periods
      WHERE end_date <= $1::date ORDER BY period_id DESC LIMIT $2`, [today, MONTHS])).rows.reverse();
  if (startedPeriods.length < MONTHS) throw new Error('جدول periods کافی نیست؛ ابتدا npm run db:seed-periods را اجرا کنید');
  const current = (await pool.query<{ period_id: number; sd: string; days: number }>(
    'SELECT period_id, start_date::text AS sd, (end_date - start_date)::int AS days FROM periods WHERE period_id = $1', [periodIdOfDate(today)])).rows[0];
  if (!current) throw new Error('دوره‌ی ماه جاری در جدول periods نیست؛ npm run db:seed-periods را اجرا کنید');
  const windowStart = (startedPeriods[0] as { sd: string }).sd;

  const officeId = await withTx(pool, async (c) => {
    const q = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> => c.query<R>(text, values);
    const officeId = ((await q<{ id: number }>('INSERT INTO offices (name, code) VALUES ($1, $2) RETURNING id', ['دفتر پشتیبانی تهران', code])).rows[0] as { id: number }).id;

    // ---- ستاد، پشتیبان، بانک، مسیر
    const headNames = UNITS.map(() => personName());
    const unitIds: number[] = [];
    for (const [i, u] of UNITS.entries()) {
      unitIds.push(((await q<{ id: number }>('INSERT INTO staff_units (office_id, name, manager_name) VALUES ($1,$2,$3) RETURNING id', [officeId, u.name, headNames[i]])).rows[0] as { id: number }).id);
    }
    const used = new Set<string>(headNames);
    const sups: Sup[] = [];
    for (const [ui, unitId] of unitIds.entries()) {
      for (let k = 0; k < 4; k += 1) {
        let name = personName();
        while (used.has(name)) name = personName();
        used.add(name);
        const r = await q<{ id: number }>('INSERT INTO supporters (office_id, staff_unit_id, full_name, phone) VALUES ($1,$2,$3,$4) RETURNING id',
          [officeId, unitId, name, `09${int(10, 39)}${String(int(0, 9_999_999)).padStart(7, '0')}`]);
        sups.push({ id: (r.rows[0] as { id: number }).id, unitIdx: ui, unitId, name });
      }
    }
    const bankIds: number[] = [];
    for (const [name] of BANKS) bankIds.push(((await q<{ id: number }>('INSERT INTO banks (office_id, name) VALUES ($1,$2) RETURNING id', [officeId, name])).rows[0] as { id: number }).id);
    const routeIds: number[][] = UNITS.map(() => []);
    for (const [ui, u] of UNITS.entries()) {
      for (const rn of u.routes) routeIds[ui]!.push(((await q<{ id: number }>('INSERT INTO route_groups (office_id, name) VALUES ($1,$2) RETURNING id', [officeId, rn])).rows[0] as { id: number }).id);
    }
    await q('INSERT INTO activity_rules (office_id, bank_id, valid_from_period, min_monthly_amount) VALUES ($1, 0, 139801, 20000000)', [officeId]);

    // ---- کاربران: admin، data، head1..4، sup1..16 (همه با یک رمز)
    const user = async (username: string, fullName: string, role: string, unitId: number | null, supId: number | null): Promise<number> =>
      ((await q<{ id: number }>(
        'INSERT INTO users (office_id, username, password_hash, full_name, role, staff_unit_id, supporter_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [officeId, username, hash, fullName, role, unitId, supId])).rows[0] as { id: number }).id;
    const adminId = await user('admin', 'مدیر دفتر', 'office_manager', null, null);
    await user('data', 'کارشناس داده', 'data_admin', null, null);
    for (const [i, unitId] of unitIds.entries()) await user(`head${i + 1}`, headNames[i] as string, 'unit_head', unitId, null);
    for (const [i, s] of sups.entries()) await user(`sup${i + 1}`, s.name, 'supporter', null, s.id);
    lap(`ستاد/پشتیبان/بانک/مسیر/کاربر ساخته شد (${sups.length} پشتیبان)`);

    // ---- ترمینال‌ها
    const supWeights = sups.map(() => between(0.6, 1.5)); // بعضی پشتیبان‌ها بار بیشتری دارند
    const terms: Term[] = [];
    for (let i = 0; i < N; i += 1) {
      const sup = weighted(sups, supWeights);
      const [tname, lo, hi, ticket] = pick(TYPES);
      const installed = rnd() < 0.72 ? addDaysIso('2022-03-21', int(0, 900)) : addDaysIso(windowStart, int(0, Math.max(1, daysBetween(windowStart, today) - 20)));
      terms.push({
        no: String(20_000_000 + i * 13 + int(0, 12)), owner: personName(), phone: `09${int(10, 39)}${String(int(0, 9_999_999)).padStart(7, '0')}`,
        addr: `تهران، خیابان ${pick(STREETS)}، پلاک ${int(1, 320)}`, shop: `${tname} ${pick(BRANDS)}`,
        sup, routeId: pick(routeIds[sup.unitIdx] as number[]), bankId: weighted(bankIds, BANKS.map((b) => b[1])),
        installed: installed > addDaysIso(today, -10) ? addDaysIso(today, -40) : installed, returned: null, reason: null,
        base: between(lo, hi) * between(0.85, 1.15), ticket: ticket * between(0.8, 1.25), factor: 1, dropped: false, id: 0,
      });
    }
    // کم‌تراکنش (۶٪)، برگشتی (۴٪)، افت شدید اخیر (۷ ترمینال)
    const idx = [...terms.keys()];
    const take = (n: number): number[] => { const out: number[] = []; for (let k = 0; k < n && idx.length; k += 1) out.push(idx.splice(int(0, idx.length - 1), 1)[0] as number); return out; };
    for (const i of take(Math.round(N * 0.06))) (terms[i] as Term).factor = between(0.02, 0.07);
    for (const i of take(Math.round(N * 0.04))) {
      const t = terms[i] as Term;
      const from = t.installed > windowStart ? addDaysIso(t.installed, 30) : windowStart;
      if (from >= today) continue;
      t.returned = addDaysIso(from, int(0, Math.max(1, daysBetween(from, today) - 5)));
      t.reason = pick(RETURN_REASONS);
    }
    for (const i of take(7)) { const t = terms[i] as Term; if (!t.returned && t.factor === 1 && t.installed < windowStart) t.dropped = true; }

    const ins = await q<{ id: number; terminal_no: string }>(
      `INSERT INTO terminals (office_id, terminal_no, owner_name, phone, address, shop_name, route_group_id, bank_id, status, installed_at, returned_at,
                              return_reason, current_supporter_id, current_unit_id, search_norm)
       SELECT $1::int, x.tno, x.own, x.phone, x.addr, x.shop, x.route, x.bank, CASE WHEN x.ret IS NULL THEN 'active' ELSE 'returned' END, x.inst::date, x.ret::date,
              x.reason, x.sup, x.unit, fa_normalize(x.tno || ' ' || x.shop || ' ' || x.own)
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[], $9::text[], $10::text[], $11::text[], $12::int[], $13::int[])
              AS x(tno, own, phone, addr, shop, route, bank, inst, ret, reason, sup, unit)
       RETURNING id, terminal_no`,
      [officeId, terms.map((t) => t.no), terms.map((t) => t.owner), terms.map((t) => t.phone), terms.map((t) => t.addr), terms.map((t) => t.shop),
       terms.map((t) => t.routeId), terms.map((t) => t.bankId), terms.map((t) => t.installed), terms.map((t) => t.returned), terms.map((t) => t.reason),
       terms.map((t) => t.sup.id), terms.map((t) => t.sup.unitId)]);
    const idByNo = new Map(ins.rows.map((r) => [r.terminal_no, r.id]));
    for (const t of terms) t.id = idByNo.get(t.no) as number;

    // ---- تاریخچه‌ی پشتیبان؛ ~۴٪ ترمینال‌ها در میانه‌ی بازه پشتیبانشان عوض شده (برای نمایش تاریخچه)
    const H = { t: [] as number[], s: [] as number[], u: [] as number[], r: [] as number[], b: [] as number[], sd: [] as string[], ed: [] as (string | null)[] };
    const addH = (t: Term, sup: Sup, sd: string, ed: string | null): void => {
      H.t.push(t.id); H.s.push(sup.id); H.u.push(sup.unitId); H.r.push(t.routeId); H.b.push(t.bankId); H.sd.push(sd); H.ed.push(ed);
    };
    let transfers = 0;
    for (const t of terms) {
      const switchAt = addDaysIso(windowStart, int(40, Math.max(41, daysBetween(windowStart, today) - 40)));
      if (rnd() < 0.04 && t.installed < addDaysIso(switchAt, -5) && (!t.returned || t.returned > switchAt)) {
        let old = pick(sups);
        while (old.id === t.sup.id) old = pick(sups);
        addH(t, old, t.installed, switchAt);
        addH(t, t.sup, switchAt, null);
        transfers += 1;
      } else addH(t, t.sup, t.installed, null);
    }
    await q(
      `INSERT INTO terminal_supporter_history (office_id, terminal_id, supporter_id, staff_unit_id, route_group_id, bank_id, start_date, end_date)
       SELECT $1::int, x.t, x.s, x.u, x.r, x.b, x.sd::date, x.ed::date
         FROM unnest($2::bigint[], $3::int[], $4::int[], $5::int[], $6::int[], $7::text[], $8::text[]) AS x(t, s, u, r, b, sd, ed)`,
      [officeId, H.t, H.s, H.u, H.r, H.b, H.sd, H.ed]);
    lap(`${terms.length} ترمینال + تاریخچه (${transfers} تعویض پشتیبان)`);

    // ---- تراکنش‌ها: فایل پایان هر ماه کامل + فایل میانه‌ی ماه برای ۳ ماه آخر + فایل جاری ماه ناقص
    for (const p of [...startedPeriods.map((x) => x.period_id), current.period_id]) await q('SELECT ensure_period_partition($1)', [p]);
    const S = { t: [] as number[], d: [] as string[], a: [] as number[], n: [] as number[] };
    const addSnap = (t: Term, date: string, amount: number): void => {
      const a = Math.max(1000, Math.round(amount / 1000) * 1000);
      S.t.push(t.id); S.d.push(date); S.a.push(a); S.n.push(Math.max(1, Math.round(a / t.ticket)));
    };
    const eligible = (t: Term, start: string, end: string): boolean => t.installed < end && (!t.returned || t.returned >= start);
    const monthAmount = (t: Term, pid: number, i: number): number =>
      t.base * (SEASON[(pid % 100) - 1] as number) * (1 + 0.011 * i) * between(0.9, 1.1) * t.factor;
    for (const [i, p] of startedPeriods.entries()) {
      const last = i === startedPeriods.length - 1;
      for (const t of terms) {
        if (!eligible(t, p.sd, p.ed)) continue;
        let amount = monthAmount(t, p.period_id, i) * (t.returned && t.returned < p.ed ? 0.5 : 1);
        if (last && t.dropped) amount *= 0.35;
        addSnap(t, addDaysIso(p.ed, -1), amount);
        if (i >= startedPeriods.length - 3 && t.installed < addDaysIso(p.sd, 14)) addSnap(t, addDaysIso(p.sd, 14), amount * between(0.42, 0.52));
      }
    }
    {
      const elapsed = daysBetween(current.sd, today);
      if (elapsed >= 3) {
        for (const t of terms) {
          if (t.returned || t.installed >= addDaysIso(current.sd, elapsed - 1)) continue;
          const full = monthAmount(t, current.period_id, startedPeriods.length) * (t.dropped ? 0.3 : 1);
          addSnap(t, addDaysIso(current.sd, elapsed - 1), full * (elapsed / current.days) * 0.95);
        }
      }
    }
    const CH = 20_000;
    for (let i = 0; i < S.t.length; i += CH) {
      await q(
        `INSERT INTO transactions_snapshot (office_id, terminal_id, as_of_date, cum_amount, cum_count, source, import_batch_id)
         SELECT $1::int, x.t, x.d::date, x.a, x.n, 1, 0 FROM unnest($2::bigint[], $3::text[], $4::bigint[], $5::int[]) AS x(t, d, a, n)`,
        [officeId, S.t.slice(i, i + CH), S.d.slice(i, i + CH), S.a.slice(i, i + CH), S.n.slice(i, i + CH)]);
    }
    lap(`${S.t.length} ردیف تراکنش (${startedPeriods.length} ماه کامل + ماه جاری)`);

    // ---- پروژه‌ها
    const active = terms.filter((t) => !t.returned);
    const lowOnes = terms.filter((t) => !t.returned && t.factor < 1);
    const supSkew = new Map(sups.map((s) => [s.id, between(0.35, 1)])); // بعضی پشتیبان‌ها در پروژه‌ها عقب‌ترند
    const shuffle = <T,>(xs: T[]): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i -= 1) { const j = int(0, i); [a[i], a[j]] = [a[j] as T, a[i] as T]; } return a; };
    const PROJECTS: Array<{ name: string; desc: string; start: number; due: number; status: string; pool: Term[]; size: number; doneBase: number; failBase: number }> = [
      { name: 'تعویض کارت‌خوان‌های نسل قدیم', desc: 'جایگزینی مدل‌های منسوخ با ترمینال‌های جدید در همه‌ی ستادها', start: -70, due: 20, status: 'active', pool: active, size: Math.min(90, Math.round(N * 0.14)), doneBase: 0.85, failBase: 0.04 },
      { name: 'به‌روزرسانی نرم‌افزار ترمینال‌ها', desc: 'نصب نسخه‌ی جدید نرم‌افزار و آزمون تراکنش آزمایشی', start: -25, due: 35, status: 'active', pool: active, size: Math.min(160, Math.round(N * 0.25)), doneBase: 0.55, failBase: 0.02 },
      { name: 'آموزش پذیرندگان کم‌تراکنش', desc: 'بازدید حضوری و آموزش استفاده‌ی بهینه برای پذیرندگان کم‌فعالیت', start: -110, due: -12, status: 'active', pool: lowOnes.length >= 20 ? lowOnes : active, size: Math.min(55, Math.max(20, lowOnes.length)), doneBase: 0.75, failBase: 0.05 },
      { name: 'نصب ترمینال‌های جدید ناحیه‌ی شرق', desc: 'پروژه‌ی پایان‌یافته‌ی توسعه‌ی شبکه در ستاد شرق', start: -200, due: -120, status: 'closed', pool: active.filter((t) => t.sup.unitIdx === 2), size: 40, doneBase: 1, failBase: 0.07 },
    ];
    let projCount = 0;
    for (const pr of PROJECTS) {
      const pid = ((await q<{ id: number }>(
        `INSERT INTO projects (office_id, name, description, start_date, due_date, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [officeId, pr.name, pr.desc, addDaysIso(today, pr.start), addDaysIso(today, pr.due), pr.status, adminId])).rows[0] as { id: number }).id;
      const chosen = shuffle(pr.pool).slice(0, pr.size);
      const rows = chosen.map((t) => {
        const skew = pr.status === 'closed' ? 1 : (supSkew.get(t.sup.id) as number);
        const r = rnd();
        const pDone = pr.doneBase * skew, pFail = pr.failBase;
        const status = r < pDone ? 'done' : r < pDone + pFail ? 'failed' : r < pDone + pFail + 0.18 ? 'in_progress' : 'not_started';
        const changed = status === 'not_started' ? null : addDaysIso(today, -int(0, Math.min(60, Math.abs(pr.start))));
        return { t, status, changed, note: status === 'failed' || (status !== 'not_started' && rnd() < 0.15) ? pick(NOTES) : null };
      });
      await q(
        `INSERT INTO project_terminals (office_id, project_id, terminal_id, status, note, status_changed_at, status_changed_by, added_by)
         SELECT $1::int, $2::bigint, x.t, x.s, x.n, x.d::timestamptz, CASE WHEN x.d IS NULL THEN NULL ELSE $3::int END, $3::int
           FROM unnest($4::bigint[], $5::text[], $6::text[], $7::text[]) AS x(t, s, n, d)`,
        [officeId, pid, adminId, rows.map((r) => r.t.id), rows.map((r) => r.status), rows.map((r) => r.note), rows.map((r) => r.changed)]);
      const ev = rows.filter((r) => r.changed);
      if (ev.length > 0) {
        await q(
          `INSERT INTO project_terminal_events (office_id, project_id, terminal_id, from_status, to_status, note, changed_by, created_at)
           SELECT $1::int, $2::bigint, x.t, 'not_started', x.s, x.n, $3::int, x.d::timestamptz FROM unnest($4::bigint[], $5::text[], $6::text[], $7::text[]) AS x(t, s, n, d)`,
          [officeId, pid, adminId, ev.map((r) => r.t.id), ev.map((r) => r.status), ev.map((r) => r.note), ev.map((r) => r.changed)]);
      }
      projCount += 1;
    }
    lap(`${projCount} پروژه`);
    return officeId;
  });

  await runRebuild({ pool, logger, today: () => today }, officeId);
  lap('تجمیع آمار (rebuild)');
  const fc = await runForecastOffice({ pool, logger }, officeId, 6);
  lap(`پیش‌بینی: ${fc.series} سری`);
  for (const t of ['transactions_snapshot', 'terminals', 'terminal_supporter_history', 'fact_terminal_month', 'agg_supporter_month', 'agg_unit_month', 'agg_office_month', 'terminal_alerts']) await pool.query(`ANALYZE ${t}`);

  console.log(`
═══════════════════════════════════════════════
 داده‌ی نمایشی آماده شد  (دفتر: ${code})
 ورود فقط با نام کاربری و رمز  —  رمز همه: ${PASSWORD}
───────────────────────────────────────────────
  admin        مدیر دفتر (دسترسی کامل)
  data         ادمین داده
  head1..head4 مسئول ستاد (شمال، جنوب، شرق، غرب)
  sup1..sup16  پشتیبان
═══════════════════════════════════════════════`);
} catch (err) {
  logger.error({ err }, 'seed-demo failed');
  process.exitCode = 1;
} finally {
  await pools.close();
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
}
