import {
  AUTO_PROJECT_KINDS, periodIdOfDate, periodNameFa, prevPeriodId, todayInTehran, addDaysIso,
  type AutoProjectKind, type AutoProjectRunDto, type AutoProjectRunResultDto, type AutoProjectsStatusDto,
} from '@pos/shared';
import type pg from 'pg';
import { writeAudit } from '../audit/audit';
import { queryOne, queryRows, withTx, type Queryable } from '../db/types';
import type { Logger } from '../logging/pino';
import { assertRoles, type TenantContext } from '../tenant/scope';

export interface AutoProjectDeps { pool: pg.Pool; logger: Logger; today?: () => string }

interface Settings {
  incomeBasis: 'purchase' | 'total';
  prevEnabled: boolean; prevDeadlineDay: number; currEnabled: boolean; currCheckDay: number;
}
interface PeriodRow { startDate: string; endDate: string }

const BASIS_FA = { purchase: 'مبلغ خرید', total: 'مبلغ کل' } as const;

async function loadSettings(db: Queryable, officeId: number): Promise<Settings> {
  const r = await queryOne<Settings>(db,
    `SELECT income_basis AS "incomeBasis", auto_no_income_prev AS "prevEnabled", auto_prev_deadline_day AS "prevDeadlineDay",
            auto_no_income_curr AS "currEnabled", auto_curr_check_day AS "currCheckDay"
       FROM office_settings WHERE office_id = $1`, [officeId]);
  if (!r) throw new Error('office settings missing');
  return r;
}

async function loadPeriod(db: Queryable, periodId: number): Promise<PeriodRow | undefined> {
  return queryOne<PeriodRow>(db, `SELECT start_date::text AS "startDate", end_date::text AS "endDate" FROM periods WHERE period_id = $1`, [periodId]);
}

/**
 * ساخت/تکمیل یک پروژه‌ی خودکار «فاقد درآمد».
 *  - ماه قبل: ترمینال‌های «کم‌تراکنش» آن ماه؛ مهلت = روز autoPrevDeadlineDay ماه جاری. فقط وقتی داده‌ی ماه قبل کامل شده ساخته می‌شود.
 *  - ماه جاری: از روز autoCurrCheckDay به بعد، ترمینال‌های کم‌تراکنشِ ماه جاری؛ مهلت = آخرین روز همین ماه.
 * «کم‌تراکنش» = طبقه‌ی ۲ در fact (مبلغ خرید یا کل طبق تنظیم income_basis کمتر از آستانه‌ی بانک؛ نوپا و برگشتی خارج‌اند).
 * ایدمپوتنت: اجرای دوباره فقط ترمینال‌های جدید را اضافه می‌کند؛ پروژه‌ی بسته/لغوشده بازنمی‌شود؛ ترمینال‌های حذف‌شده‌ی دستی برنمی‌گردند.
 */
async function runKind(
  c: pg.PoolClient, officeId: number, kind: AutoProjectKind, s: Settings, today: string,
  opts: { force: boolean; trigger: 'schedule' | 'manual'; userId: number | null },
): Promise<AutoProjectRunResultDto> {
  const curId = periodIdOfDate(today);
  const periodId = kind === 'no_income_prev' ? prevPeriodId(curId) : curId;
  const done = (r: Partial<AutoProjectRunResultDto> & Pick<AutoProjectRunResultDto, 'outcome'>): AutoProjectRunResultDto =>
    ({ kind, periodId, projectId: null, added: 0, eligible: 0, message: null, ...r });

  const enabled = kind === 'no_income_prev' ? s.prevEnabled : s.currEnabled;
  if (!enabled && !opts.force) return done({ outcome: 'skipped', message: 'در تنظیمات غیرفعال است' });

  const cur = await loadPeriod(c, curId);
  if (!cur) return done({ outcome: 'skipped', message: 'ماه جاری در جدول دوره‌ها تعریف نشده است' });

  let startDate: string;
  let dueDate: string;
  if (kind === 'no_income_prev') {
    dueDate = addDaysIso(cur.startDate, s.prevDeadlineDay - 1);
    startDate = cur.startDate;
    if (opts.trigger === 'schedule' && today > dueDate) return done({ outcome: 'skipped', message: 'مهلت پروژه‌ی این ماه گذشته است' });
    const cov = await queryOne<{ withAmount: number; complete: number }>(c,
      `SELECT (count(*) FILTER (WHERE amount > 0))::int AS "withAmount", (count(*) FILTER (WHERE amount > 0 AND is_complete))::int AS complete
         FROM fact_terminal_month WHERE office_id = $1 AND period_id = $2`, [officeId, periodId]);
    if (!cov || cov.withAmount === 0 || cov.complete * 2 < cov.withAmount) {
      return done({ outcome: 'skipped', message: 'داده‌ی کامل ماه قبل هنوز ایمپورت نشده است (فایل پایان ماه را ایمپورت کنید)' });
    }
  } else {
    const checkDate = addDaysIso(cur.startDate, s.currCheckDay - 1);
    if (opts.trigger === 'schedule' && today < checkDate) return done({ outcome: 'skipped', message: 'هنوز به روز ارزیابی ماه جاری نرسیده‌ایم' });
    const need = opts.trigger === 'schedule' ? addDaysIso(checkDate, -1) : cur.startDate;
    const cov = await queryOne<{ last: string | null }>(c,
      `SELECT max(last_as_of_date)::text AS last FROM fact_terminal_month WHERE office_id = $1 AND period_id = $2`, [officeId, periodId]);
    if (!cov?.last || cov.last < need) {
      return done({ outcome: 'skipped', message: `فایل تراکنش ماه جاری هنوز تا تاریخ لازم (${need}) ایمپورت نشده است` });
    }
    startDate = today;
    dueDate = addDaysIso(cur.endDate, -1);
  }

  const label = periodNameFa(periodId);
  const existing = await queryOne<{ id: number; status: string }>(c,
    `SELECT id, status FROM projects WHERE office_id = $1 AND auto_kind = $2 AND auto_period = $3`, [officeId, kind, periodId]);
  if (existing && existing.status !== 'active') {
    return done({ outcome: 'skipped', projectId: existing.id, message: 'پروژه‌ی این ماه بسته یا لغو شده است و دوباره باز نمی‌شود' });
  }

  let projectId = existing?.id ?? null;
  let created = false;
  if (projectId === null) {
    let name = kind === 'no_income_prev' ? `فاقد درآمد ماه قبل — ${label}` : `فاقد درآمد ماه جاری — ${label}`;
    if (await queryOne(c, 'SELECT 1 AS x FROM projects WHERE office_id = $1 AND name = $2', [officeId, name])) name += ' (خودکار)';
    const desc = kind === 'no_income_prev'
      ? `ترمینال‌هایی که ${BASIS_FA[s.incomeBasis]} آن‌ها در ${label} کمتر از آستانه‌ی حد مجاز بود. مهلت: روز ${s.prevDeadlineDay} ماه جاری.`
      : `ترمینال‌هایی که ${BASIS_FA[s.incomeBasis]} آن‌ها تا روز ${s.currCheckDay} ${label} کمتر از آستانه‌ی حد مجاز بوده است. مهلت: پایان همین ماه.`;
    const row = await queryOne<{ id: number }>(c,
      `INSERT INTO projects (office_id, name, description, start_date, due_date, created_by, auto_kind, auto_period)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [officeId, name, desc, startDate, dueDate, opts.userId ?? 0, kind, periodId]);
    projectId = (row as { id: number }).id;
    created = true;
    await writeAudit(c, {
      officeId, userId: opts.userId, entityType: 'project', entityId: projectId, action: 'create',
      after: { name, startDate, dueDate, autoKind: kind, periodId, trigger: opts.trigger },
    });
  }

  const eligibleSql = `FROM fact_terminal_month f JOIN terminals t ON t.office_id = f.office_id AND t.id = f.terminal_id
      WHERE f.office_id = $1 AND f.period_id = $2 AND f.activity_class = 2 AND t.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM auto_project_exclusions x WHERE x.project_id = $3 AND x.terminal_id = f.terminal_id)`;
  const eligible = (await queryOne<{ n: number }>(c, `SELECT count(*)::int AS n ${eligibleSql}`, [officeId, periodId, projectId]))?.n ?? 0;
  const ins = await c.query(
    `INSERT INTO project_terminals (office_id, project_id, terminal_id, status, note, added_by)
     SELECT f.office_id, $3::bigint, f.terminal_id, 'not_started', 'افزوده‌شده خودکار', $4::int ${eligibleSql}
     ON CONFLICT (project_id, terminal_id) DO NOTHING`, [officeId, periodId, projectId, opts.userId]);
  const added = ins.rowCount ?? 0;

  if (added > 0 && !created) {
    await writeAudit(c, { officeId, userId: opts.userId, entityType: 'project', entityId: projectId, action: 'update', after: { addedTerminals: added, auto: true } });
  }
  return done({ outcome: created ? 'created' : added > 0 ? 'updated' : 'unchanged', projectId, added, eligible,
    message: created ? `پروژه ساخته شد و ${added} ترمینال اضافه شد` : null });
}

export async function runAutoProjects(
  deps: AutoProjectDeps, officeId: number,
  opts: { kind?: AutoProjectKind | undefined; force?: boolean; trigger?: 'schedule' | 'manual'; userId?: number | null } = {},
): Promise<AutoProjectRunResultDto[]> {
  const today = (deps.today ?? todayInTehran)();
  const o = { force: opts.force ?? false, trigger: opts.trigger ?? 'schedule', userId: opts.userId ?? null } as const;
  const kinds = opts.kind ? [opts.kind] : [...AUTO_PROJECT_KINDS];
  return withTx(deps.pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`autoproj:${officeId}`]);
    const s = await loadSettings(c, officeId);
    const out: AutoProjectRunResultDto[] = [];
    for (const kind of kinds) {
      const r = await runKind(c, officeId, kind, s, today, o);
      out.push(r);
      // اجرای زمان‌بندی‌شده‌ی بی‌اثر یا ردشده، گزارش تکراری نمی‌سازد؛ اجرای دستی همیشه ثبت می‌شود
      if (o.trigger === 'manual' || r.outcome === 'created' || r.outcome === 'updated') {
        await c.query(
          `INSERT INTO auto_project_runs (office_id, kind, period_id, project_id, outcome, added, eligible, message, trigger, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [officeId, kind, r.periodId, r.projectId, r.outcome, r.added, r.eligible, r.message, o.trigger, o.userId]);
      }
    }
    if (out.some((r) => r.outcome === 'created' || r.outcome === 'updated')) {
      await c.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [officeId]);
    }
    return out;
  });
}

export async function runAutoProjectsAll(deps: AutoProjectDeps): Promise<number> {
  const offices = (await deps.pool.query<{ id: number }>('SELECT id FROM offices WHERE is_active ORDER BY id')).rows;
  let changed = 0;
  for (const o of offices) {
    try {
      const r = await runAutoProjects(deps, o.id);
      changed += r.filter((x) => x.outcome === 'created' || x.outcome === 'updated').length;
    } catch (err) {
      deps.logger.error({ err, officeId: o.id }, 'auto projects failed');
    }
  }
  deps.logger.info({ offices: offices.length, changed }, 'auto projects done');
  return changed;
}

// ---------------------------------------------------------------- API
const MANAGERS = ['office_manager', 'data_admin'] as const;

export async function getAutoProjectsStatus(ctx: TenantContext, db: Queryable): Promise<AutoProjectsStatusDto> {
  assertRoles(ctx, MANAGERS);
  const runs = await queryRows<AutoProjectRunDto>(db,
    `SELECT id, kind, period_id AS "periodId", project_id AS "projectId", outcome, added, eligible, message, trigger,
            created_by AS "createdBy", created_at AS "createdAt"
       FROM auto_project_runs WHERE office_id = $1 ORDER BY id DESC LIMIT 20`, [ctx.officeId]);
  const projects = await queryRows<AutoProjectsStatusDto['projects'][number]>(db,
    `SELECT p.id, p.name, p.auto_kind AS kind, p.auto_period AS "periodId", p.status,
            p.start_date AS "startDate", p.due_date AS "dueDate",
            (SELECT count(*)::int FROM project_terminals pt WHERE pt.project_id = p.id) AS total
       FROM projects p WHERE p.office_id = $1 AND p.auto_kind IS NOT NULL ORDER BY p.auto_period DESC, p.auto_kind LIMIT 12`, [ctx.officeId]);
  return { runs, projects };
}

export async function runAutoProjectsManual(
  ctx: TenantContext, deps: AutoProjectDeps, kind: AutoProjectKind | undefined, force: boolean,
): Promise<AutoProjectRunResultDto[]> {
  assertRoles(ctx, MANAGERS);
  return runAutoProjects(deps, ctx.officeId, { kind, force, trigger: 'manual', userId: ctx.userId });
}
