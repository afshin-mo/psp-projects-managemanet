import type pg from 'pg';
import { z } from 'zod';
import {
  LAG_SEVERITY, addDaysIso, diffDaysIso, normalizeSearchText, normalizeTerminalNo, escapeLike, projectLag,
  type BulkResultDto, type BulkStatusInput, type CreateProjectInput, type Page,
  type PatchProjectInput, type ProjectAlertDto, type ProjectDto, type ProjectImportResultDto, type ProjectListQuery,
  type ProjectMatrixDto, type ProjectProgressDto, type ProjectStatus, type ProjectSupporterProgressDto,
  type ProjectTerminalDto, type ProjectTerminalStatus, type ProjectTerminalsQuery, type ProjectTrendDto, type RemoveResultDto,
  type SetTerminalStatusInput, type StatusCounts,
} from '@pos/shared';
import { writeAudit } from '../audit/audit';
import { SqlParams } from '../db/sql';
import { queryOne, queryRows, withTx, type Queryable } from '../db/types';
import { HttpError, notFound } from '../errors';
import { decodeCursor, encodeCursor } from '../pagination';
import { assertRoles, scopeWhere, type TenantContext, type TenantRole } from '../tenant/scope';

const MANAGERS: readonly TenantRole[] = ['office_manager', 'data_admin'];
/** همه‌ی نقش‌های دفتر می‌توانند وضعیت ترمینال‌های داخل دامنه‌ی خودشان را تغییر دهند */
const WORKERS: readonly TenantRole[] = ['office_manager', 'data_admin', 'unit_head', 'supporter'];

/** دامنه‌ی دسترسی روی «ترمینال» (پشتیبان/ستاد جاری)؛ پروژه‌ها خودشان در سطح دفتر مشترک‌اند */
const PT_SCOPE = { office: 't.office_id', unit: 't.current_unit_id', supporter: 't.current_supporter_id' } as const;

const P_COLS = `p.id, p.name, p.description, p.start_date AS "startDate", p.due_date AS "dueDate", p.status, p.created_at AS "createdAt", p.auto_kind AS "autoKind"`;

interface ProjectRow {
  id: number; name: string; description: string | null; startDate: string; dueDate: string; status: ProjectStatus; createdAt: string;
  autoKind: 'no_income_prev' | 'no_income_curr' | null;
}

const emptyCounts = (): StatusCounts => ({ notStarted: 0, inProgress: 0, done: 0, failed: 0 });
const totalOf = (c: StatusCounts): number => c.notStarted + c.inProgress + c.done + c.failed;

function addStatus(c: StatusCounts, status: string, n: number): void {
  if (status === 'not_started') c.notStarted += n;
  else if (status === 'in_progress') c.inProgress += n;
  else if (status === 'done') c.done += n;
  else if (status === 'failed') c.failed += n;
}

function toDto(row: ProjectRow, counts: StatusCounts, today: string): ProjectDto {
  const total = totalOf(counts);
  return {
    ...row, ...counts, total,
    lag: projectLag({ startDate: row.startDate, dueDate: row.dueDate, today, total, done: counts.done, failed: counts.failed }),
  };
}

async function loadProject(ctx: TenantContext, db: Queryable, id: number, lock = false): Promise<ProjectRow> {
  const row = await queryOne<ProjectRow>(db,
    `SELECT ${P_COLS} FROM projects p WHERE p.office_id = $1 AND p.id = $2${lock ? ' FOR UPDATE' : ''}`, [ctx.officeId, id]);
  if (!row) throw notFound('پروژه');
  return row;
}

function assertActive(p: ProjectRow): void {
  if (p.status !== 'active') throw new HttpError(409, 'PROJECT_NOT_ACTIVE', 'پروژه فعال نیست؛ تغییر ترمینال‌ها ممکن نیست');
}

/** شمارش وضعیت ترمینال‌ها در دامنه‌ی دسترسی کاربر؛ کلید = شناسه‌ی پروژه */
async function countsByProject(ctx: TenantContext, db: Queryable, projectIds?: readonly number[]): Promise<Map<number, StatusCounts>> {
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, PT_SCOPE);
  if (projectIds) where.push(`pt.project_id = ANY(${p.add(projectIds)}::bigint[])`);
  const rows = await queryRows<{ projectId: number; status: string; n: number }>(db,
    `SELECT pt.project_id AS "projectId", pt.status, count(*)::int AS n
       FROM project_terminals pt JOIN terminals t ON t.office_id = pt.office_id AND t.id = pt.terminal_id
      WHERE ${where.join(' AND ')} GROUP BY pt.project_id, pt.status`, p.values);
  const out = new Map<number, StatusCounts>();
  for (const r of rows) {
    const c = out.get(r.projectId) ?? emptyCounts();
    addStatus(c, r.status, r.n);
    out.set(r.projectId, c);
  }
  return out;
}

// ------------------------------------------------------------------ پروژه

export async function listProjects(ctx: TenantContext, db: Queryable, q: ProjectListQuery, today: string): Promise<ProjectDto[]> {
  const p = new SqlParams();
  const where = [`p.office_id = ${p.add(ctx.officeId)}`];
  if (q.status) where.push(`p.status = ${p.add(q.status)}`);
  const rows = await queryRows<ProjectRow>(db,
    `SELECT ${P_COLS} FROM projects p WHERE ${where.join(' AND ')}
      ORDER BY (p.status = 'active') DESC, p.due_date, p.id LIMIT 500`, p.values);
  const counts = await countsByProject(ctx, db, rows.map((r) => r.id));
  return rows.map((r) => toDto(r, counts.get(r.id) ?? emptyCounts(), today));
}

export async function getProject(ctx: TenantContext, db: Queryable, id: number, today: string): Promise<ProjectDto> {
  const row = await loadProject(ctx, db, id);
  const counts = await countsByProject(ctx, db, [id]);
  return toDto(row, counts.get(id) ?? emptyCounts(), today);
}

export async function createProject(ctx: TenantContext, pool: pg.Pool, input: CreateProjectInput, today: string): Promise<ProjectDto> {
  assertRoles(ctx, MANAGERS);
  const id = await withTx(pool, async (c) => {
    const row = await queryOne<{ id: number }>(c,
      `INSERT INTO projects (office_id, name, description, start_date, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.officeId, input.name, input.description ?? null, input.startDate, input.dueDate, ctx.userId]);
    const pid = (row as { id: number }).id;
    await writeAudit(c, {
      officeId: ctx.officeId, userId: ctx.userId, entityType: 'project', entityId: pid, action: 'create',
      after: { name: input.name, startDate: input.startDate, dueDate: input.dueDate },
    });
    return pid;
  });
  return getProject(ctx, pool, id, today);
}

const PATCH_COLS = { name: 'name', description: 'description', startDate: 'start_date', dueDate: 'due_date', status: 'status' } as const;
type PatchKey = keyof typeof PATCH_COLS;

export async function patchProject(ctx: TenantContext, pool: pg.Pool, id: number, input: PatchProjectInput, today: string): Promise<ProjectDto> {
  assertRoles(ctx, MANAGERS);
  await withTx(pool, async (c) => {
    const cur = await loadProject(ctx, c, id, true);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const p = new SqlParams();
    const sets: string[] = [];
    for (const key of Object.keys(PATCH_COLS) as PatchKey[]) {
      const next = input[key];
      if (next === undefined || next === cur[key]) continue;
      before[key] = cur[key];
      after[key] = next;
      sets.push(`${PATCH_COLS[key]} = ${p.add(next)}`);
    }
    if (sets.length === 0) return;
    const start = (after.startDate as string | undefined) ?? cur.startDate;
    const due = (after.dueDate as string | undefined) ?? cur.dueDate;
    if (due < start) throw new HttpError(422, 'INVALID_RANGE', 'سررسید نمی‌تواند قبل از شروع باشد');
    sets.push('updated_at = now()');
    await c.query(`UPDATE projects SET ${sets.join(', ')} WHERE office_id = ${p.add(ctx.officeId)} AND id = ${p.add(id)}`, p.values);
    await writeAudit(c, { officeId: ctx.officeId, userId: ctx.userId, entityType: 'project', entityId: id, action: 'update', before, after });
  });
  return getProject(ctx, pool, id, today);
}

// ------------------------------------------------------------------ ترمینال‌های پروژه

export interface ProjectTerminalRowInput {
  terminalNo?: string;
  terminalId?: number;
  status?: ProjectTerminalStatus;
  note?: string | null;
}

/**
 * وضعیت چند ترمینال یک پروژه را (در دامنه‌ی کاربر) تغییر می‌دهد و تاریخچه می‌نویسد.
 * note === undefined یعنی «یادداشت را تغییر نده».
 */
async function applyStatusChange(
  ctx: TenantContext, c: pg.PoolClient, projectId: number, ids: readonly number[], status: ProjectTerminalStatus,
  note: string | null | undefined,
): Promise<{ updated: number; unchanged: number; missing: number }> {
  if (ids.length === 0) return { updated: 0, unchanged: 0, missing: 0 };
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, PT_SCOPE);
  where.push(`pt.project_id = ${p.add(projectId)}`, `pt.terminal_id = ANY(${p.add(ids)}::bigint[])`);
  const rows = await queryRows<{ terminalId: number; status: ProjectTerminalStatus; note: string | null }>(c,
    `SELECT pt.terminal_id AS "terminalId", pt.status, pt.note
       FROM project_terminals pt JOIN terminals t ON t.office_id = pt.office_id AND t.id = pt.terminal_id
      WHERE ${where.join(' AND ')} FOR UPDATE OF pt`, p.values);

  const toUpdate = rows.filter((r) => r.status !== status || (note !== undefined && r.note !== note));
  if (toUpdate.length > 0) {
    await c.query(
      `UPDATE project_terminals SET
         status = $3::text,
         note = CASE WHEN $4::boolean THEN $5::text ELSE note END,
         status_changed_at = CASE WHEN status <> $3::text THEN now() ELSE status_changed_at END,
         status_changed_by = CASE WHEN status <> $3::text THEN $6::int ELSE status_changed_by END
       WHERE project_id = $1::bigint AND terminal_id = ANY($2::bigint[])`,
      [projectId, toUpdate.map((r) => r.terminalId), status, note !== undefined, note ?? null, ctx.userId]);
    const changed = toUpdate.filter((r) => r.status !== status);
    if (changed.length > 0) {
      await c.query(
        `INSERT INTO project_terminal_events (office_id, project_id, terminal_id, from_status, to_status, note, changed_by)
         SELECT $1::int, $2::bigint, x.terminal_id, x.from_status, $3::text, $4::text, $5::int
           FROM unnest($6::bigint[], $7::text[]) AS x(terminal_id, from_status)`,
        [ctx.officeId, projectId, status, note ?? null, ctx.userId, changed.map((r) => r.terminalId), changed.map((r) => r.status)]);
    }
  }
  return { updated: toUpdate.length, unchanged: rows.length - toUpdate.length, missing: ids.length - rows.length };
}

/**
 * افزودن ترمینال به پروژه (با شناسه یا شماره ترمینال). ترمینال‌های ناشناخته گزارش می‌شوند و مانع بقیه نیستند.
 * اگر ردیف فایل «وضعیت» داشته باشد: برای ترمینال جدید وضعیت اولیه، و برای ترمینال موجود در پروژه تغییر وضعیت است.
 */
export async function addProjectTerminals(
  ctx: TenantContext, pool: pg.Pool, projectId: number, rows: readonly ProjectTerminalRowInput[],
): Promise<ProjectImportResultDto> {
  assertRoles(ctx, MANAGERS);
  if (rows.length === 0) throw new HttpError(422, 'NO_ROWS', 'ترمینالی برای افزودن ارسال نشده است');
  return withTx(pool, async (c) => {
    assertActive(await loadProject(ctx, c, projectId, true));

    const nos = [...new Set(rows.flatMap((r) => (r.terminalNo ? [normalizeTerminalNo(r.terminalNo)] : [])))];
    const idList = [...new Set(rows.flatMap((r) => (r.terminalId ? [r.terminalId] : [])))];
    const found = await queryRows<{ id: number; terminalNo: string }>(c,
      `SELECT id, terminal_no AS "terminalNo" FROM terminals
        WHERE office_id = $1 AND (terminal_no = ANY($2::text[]) OR id = ANY($3::bigint[]))`, [ctx.officeId, nos, idList]);
    const byNo = new Map(found.map((f) => [f.terminalNo, f.id]));
    const idSet = new Set(found.map((f) => f.id));

    const resolved = new Map<number, { status?: ProjectTerminalStatus; note?: string | null }>();
    const unknown: string[] = [];
    for (const r of rows) {
      const id = r.terminalId !== undefined ? (idSet.has(r.terminalId) ? r.terminalId : undefined)
        : byNo.get(normalizeTerminalNo(r.terminalNo ?? ''));
      if (id === undefined) {
        unknown.push(r.terminalNo ?? String(r.terminalId));
        continue;
      }
      resolved.set(id, { ...(r.status ? { status: r.status } : {}), ...(r.note !== undefined ? { note: r.note } : {}) });
    }

    const ids = [...resolved.keys()];
    let added = 0;
    let statusUpdated = 0;
    if (ids.length > 0) {
      const inserted = await queryRows<{ terminalId: number }>(c,
        `INSERT INTO project_terminals (office_id, project_id, terminal_id, status, note, added_by, status_changed_at, status_changed_by)
         SELECT $1::int, $2::bigint, x.terminal_id, x.status, x.note, $3::int,
                CASE WHEN x.status <> 'not_started' THEN now() END, CASE WHEN x.status <> 'not_started' THEN $3::int END
           FROM unnest($4::bigint[], $5::text[], $6::text[]) AS x(terminal_id, status, note)
         ON CONFLICT (project_id, terminal_id) DO NOTHING RETURNING terminal_id AS "terminalId"`,
        [ctx.officeId, projectId, ctx.userId, ids, ids.map((id) => resolved.get(id)?.status ?? 'not_started'),
         ids.map((id) => resolved.get(id)?.note ?? null)]);
      added = inserted.length;
      const insertedSet = new Set(inserted.map((r) => r.terminalId));
      // ترمینال‌های از قبل موجود که فایل برایشان وضعیت مشخص کرده: تغییر وضعیت
      const byStatus = new Map<ProjectTerminalStatus, number[]>();
      for (const id of ids) {
        const st = resolved.get(id)?.status;
        if (insertedSet.has(id) || !st) continue;
        byStatus.set(st, [...(byStatus.get(st) ?? []), id]);
      }
      for (const [st, list] of byStatus) statusUpdated += (await applyStatusChange(ctx, c, projectId, list, st, undefined)).updated;
    }

    await writeAudit(c, {
      officeId: ctx.officeId, userId: ctx.userId, entityType: 'project', entityId: projectId, action: 'update',
      after: { addedTerminals: added, statusUpdated, unknown: unknown.length },
    });
    return {
      added, alreadyInProject: ids.length - added, statusUpdated,
      unknown: unknown.slice(0, 100), unknownCount: unknown.length, invalid: [], invalidCount: 0,
    };
  });
}

export async function removeProjectTerminals(
  ctx: TenantContext, pool: pg.Pool, projectId: number, terminalIds: readonly number[],
): Promise<RemoveResultDto> {
  assertRoles(ctx, MANAGERS);
  return withTx(pool, async (c) => {
    const project = await loadProject(ctx, c, projectId, true);
    assertActive(project);
    // پروژه‌ی خودکار: ترمینال حذف‌شده‌ی دستی دوباره اضافه نشود
    if (project.autoKind) {
      await c.query(
        `INSERT INTO auto_project_exclusions (office_id, project_id, terminal_id, created_by)
         SELECT $1::int, $2::bigint, pt.terminal_id, $4::int FROM project_terminals pt
          WHERE pt.project_id = $2 AND pt.terminal_id = ANY($3::bigint[]) ON CONFLICT DO NOTHING`,
        [ctx.officeId, projectId, terminalIds, ctx.userId]);
    }
    const r = await c.query(
      'DELETE FROM project_terminals WHERE office_id = $1 AND project_id = $2 AND terminal_id = ANY($3::bigint[])',
      [ctx.officeId, projectId, terminalIds]);
    await writeAudit(c, {
      officeId: ctx.officeId, userId: ctx.userId, entityType: 'project', entityId: projectId, action: 'update',
      after: { removedTerminals: r.rowCount ?? 0 },
    });
    return { removed: r.rowCount ?? 0 };
  });
}

const listCursorSchema = z.object({ id: z.number().int().nonnegative() });

export async function listProjectTerminals(
  ctx: TenantContext, db: Queryable, projectId: number, q: ProjectTerminalsQuery,
): Promise<Page<ProjectTerminalDto>> {
  await loadProject(ctx, db, projectId);
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, PT_SCOPE);
  where.push(`pt.project_id = ${p.add(projectId)}`);
  if (q.cursor) where.push(`pt.terminal_id > ${p.add(decodeCursor(q.cursor, listCursorSchema).id)}`);
  if (q.status) where.push(`pt.status = ${p.add(q.status)}`);
  if (q.supporterId !== undefined) where.push(`t.current_supporter_id = ${p.add(q.supporterId)}`);
  if (q.unitId !== undefined) where.push(`t.current_unit_id = ${p.add(q.unitId)}`);
  if (q.q) {
    const norm = normalizeSearchText(q.q);
    if (norm) where.push(`t.search_norm ILIKE ${p.add(`%${escapeLike(norm)}%`)}`);
  }
  const rows = await queryRows<ProjectTerminalDto>(db,
    `SELECT pt.terminal_id AS "terminalId", t.terminal_no AS "terminalNo", t.shop_name AS "shopName",
            t.current_supporter_id AS "supporterId", t.current_unit_id AS "unitId", pt.status, pt.note,
            pt.status_changed_at AS "statusChangedAt"
       FROM project_terminals pt JOIN terminals t ON t.office_id = pt.office_id AND t.id = pt.terminal_id
      WHERE ${where.join(' AND ')} ORDER BY pt.terminal_id LIMIT ${p.add(q.limit + 1)}`, p.values);
  let nextCursor: string | null = null;
  if (rows.length > q.limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    if (last) nextCursor = encodeCursor({ id: last.terminalId });
  }
  return { items: rows, nextCursor };
}

/** تغییر وضعیت یک ترمینال */
export async function setProjectTerminalStatus(
  ctx: TenantContext, pool: pg.Pool, projectId: number, terminalId: number, input: SetTerminalStatusInput,
): Promise<BulkResultDto> {
  return bulkSetProjectTerminalStatus(ctx, pool, projectId, { terminalIds: [terminalId], status: input.status, note: input.note });
}

/**
 * تغییر وضعیت گروهی (حداکثر ۵۰۰۰). همه یا هیچ: اگر ترمینالی در پروژه نباشد یا در دامنه‌ی کاربر نباشد
 * (مثلاً پشتیبان برای ترمینال دیگری)، کل عملیات رد می‌شود.
 */
export async function bulkSetProjectTerminalStatus(
  ctx: TenantContext, pool: pg.Pool, projectId: number, input: BulkStatusInput,
): Promise<BulkResultDto> {
  assertRoles(ctx, WORKERS);
  return withTx(pool, async (c) => {
    assertActive(await loadProject(ctx, c, projectId));
    const ids = [...new Set(input.terminalIds)];
    const r = await applyStatusChange(ctx, c, projectId, ids, input.status, input.note);
    if (r.missing > 0) {
      throw new HttpError(422, 'TERMINALS_NOT_IN_PROJECT',
        `${r.missing} ترمینال در این پروژه نیست یا در دسترس شما نیست؛ هیچ تغییری اعمال نشد`);
    }
    if (r.updated > 0) {
      await writeAudit(c, {
        officeId: ctx.officeId, userId: ctx.userId, entityType: 'project', entityId: projectId, action: 'update',
        after: { status: input.status, terminals: r.updated },
      });
    }
    return { updated: r.updated, unchanged: r.unchanged };
  });
}

// ------------------------------------------------------------------ پیشرفت، ماتریس، هشدار

export async function getProjectProgress(ctx: TenantContext, db: Queryable, id: number, today: string): Promise<ProjectProgressDto> {
  const project = await getProject(ctx, db, id, today);
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, PT_SCOPE);
  where.push(`pt.project_id = ${p.add(id)}`);
  const rows = await queryRows<{ supporterId: number; name: string; unitId: number; status: string; n: number }>(db,
    `SELECT t.current_supporter_id AS "supporterId", s.full_name AS name, t.current_unit_id AS "unitId", pt.status, count(*)::int AS n
       FROM project_terminals pt
       JOIN terminals t ON t.office_id = pt.office_id AND t.id = pt.terminal_id
       JOIN supporters s ON s.office_id = t.office_id AND s.id = t.current_supporter_id
      WHERE ${where.join(' AND ')} GROUP BY t.current_supporter_id, s.full_name, t.current_unit_id, pt.status`, p.values);

  const map = new Map<number, { name: string; unitId: number; counts: StatusCounts }>();
  for (const r of rows) {
    const e = map.get(r.supporterId) ?? { name: r.name, unitId: r.unitId, counts: emptyCounts() };
    addStatus(e.counts, r.status, r.n);
    map.set(r.supporterId, e);
  }
  const bySupporter: ProjectSupporterProgressDto[] = [...map.entries()]
    .map(([supporterId, e]) => {
      const total = totalOf(e.counts);
      return {
        supporterId, name: e.name, unitId: e.unitId, ...e.counts, total,
        lag: projectLag({ startDate: project.startDate, dueDate: project.dueDate, today, total, done: e.counts.done, failed: e.counts.failed }),
      };
    })
    .sort((a, b) => b.lag.gapPct - a.lag.gapPct || a.name.localeCompare(b.name, 'fa'));

  return {
    project,
    funnel: [
      { key: 'total', count: project.total },
      { key: 'started', count: project.inProgress + project.done },
      { key: 'done', count: project.done },
    ],
    bySupporter,
  };
}

interface CellRow {
  projectId: number; supporterId: number; name: string; unitId: number; counts: StatusCounts;
}

/** شمارش وضعیت پروژه‌های «فعال» به تفکیک پشتیبان (در دامنه‌ی کاربر) */
async function loadActiveCells(ctx: TenantContext, db: Queryable): Promise<{ projects: ProjectRow[]; cells: CellRow[] }> {
  const projects = await queryRows<ProjectRow>(db,
    `SELECT ${P_COLS} FROM projects p WHERE p.office_id = $1 AND p.status = 'active' ORDER BY p.due_date, p.id LIMIT 100`, [ctx.officeId]);
  if (projects.length === 0) return { projects, cells: [] };
  const p = new SqlParams();
  const where = scopeWhere(ctx, p, PT_SCOPE);
  where.push(`pt.project_id = ANY(${p.add(projects.map((x) => x.id))}::bigint[])`);
  const rows = await queryRows<{ projectId: number; supporterId: number; name: string; unitId: number; status: string; n: number }>(db,
    `SELECT pt.project_id AS "projectId", t.current_supporter_id AS "supporterId", s.full_name AS name,
            t.current_unit_id AS "unitId", pt.status, count(*)::int AS n
       FROM project_terminals pt
       JOIN terminals t ON t.office_id = pt.office_id AND t.id = pt.terminal_id
       JOIN supporters s ON s.office_id = t.office_id AND s.id = t.current_supporter_id
      WHERE ${where.join(' AND ')}
      GROUP BY pt.project_id, t.current_supporter_id, s.full_name, t.current_unit_id, pt.status`, p.values);
  const map = new Map<string, CellRow>();
  for (const r of rows) {
    const key = `${r.projectId}:${r.supporterId}`;
    const e = map.get(key) ?? { projectId: r.projectId, supporterId: r.supporterId, name: r.name, unitId: r.unitId, counts: emptyCounts() };
    addStatus(e.counts, r.status, r.n);
    map.set(key, e);
  }
  return { projects, cells: [...map.values()] };
}

/** ماتریس «پیشرفت پروژه × پشتیبان» برای پروژه‌های فعال */
export async function getProjectsMatrix(ctx: TenantContext, db: Queryable, today: string): Promise<ProjectMatrixDto> {
  const { projects, cells } = await loadActiveCells(ctx, db);
  const counts = new Map<number, StatusCounts>();
  for (const c of cells) {
    const e = counts.get(c.projectId) ?? emptyCounts();
    e.notStarted += c.counts.notStarted; e.inProgress += c.counts.inProgress; e.done += c.counts.done; e.failed += c.counts.failed;
    counts.set(c.projectId, e);
  }
  const dtoProjects = projects.map((pr) => {
    const c = counts.get(pr.id) ?? emptyCounts();
    return {
      id: pr.id, name: pr.name, dueDate: pr.dueDate,
      lag: projectLag({ startDate: pr.startDate, dueDate: pr.dueDate, today, total: totalOf(c), done: c.done, failed: c.failed }),
    };
  });
  const bySupporter = new Map<number, { name: string; unitId: number; byProject: Map<number, StatusCounts> }>();
  for (const c of cells) {
    const e = bySupporter.get(c.supporterId) ?? { name: c.name, unitId: c.unitId, byProject: new Map() };
    e.byProject.set(c.projectId, c.counts);
    bySupporter.set(c.supporterId, e);
  }
  const rows = [...bySupporter.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name, 'fa'))
    .map(([supporterId, e]) => ({
      supporterId, name: e.name, unitId: e.unitId,
      cells: projects.map((pr) => {
        const c = e.byProject.get(pr.id);
        if (!c) return null;
        const total = totalOf(c);
        const lag = projectLag({ startDate: pr.startDate, dueDate: pr.dueDate, today, total, done: c.done, failed: c.failed });
        return { total, done: c.done, failed: c.failed, pct: lag.actualPct, level: lag.level };
      }),
    }));
  return { projects: dtoProjects, rows };
}

/** هشدار عقب‌افتادگی: هر (پروژه فعال × پشتیبان) که نسبت به خط برنامه عقب است؛ شدیدترین‌ها اول */
export async function listProjectAlerts(ctx: TenantContext, db: Queryable, today: string): Promise<ProjectAlertDto[]> {
  const { projects, cells } = await loadActiveCells(ctx, db);
  const byId = new Map(projects.map((pr) => [pr.id, pr]));
  const out: ProjectAlertDto[] = [];
  for (const c of cells) {
    const pr = byId.get(c.projectId);
    if (!pr) continue;
    const total = totalOf(c.counts);
    const lag = projectLag({ startDate: pr.startDate, dueDate: pr.dueDate, today, total, done: c.counts.done, failed: c.counts.failed });
    if (lag.level !== 'overdue' && lag.level !== 'behind' && lag.level !== 'at_risk') continue;
    out.push({
      projectId: pr.id, projectName: pr.name, dueDate: pr.dueDate,
      supporterId: c.supporterId, supporterName: c.name, unitId: c.unitId,
      total, done: c.counts.done, failed: c.counts.failed, remaining: total - c.counts.done - c.counts.failed,
      expectedPct: lag.expectedPct, actualPct: lag.actualPct, gapPct: lag.gapPct, daysLeft: lag.daysLeft, level: lag.level,
    });
  }
  return out
    .sort((a, b) => LAG_SEVERITY[b.level] - LAG_SEVERITY[a.level] || b.gapPct - a.gapPct)
    .slice(0, 500);
}

/**
 * روند پیشرفت هر پشتیبان در گذر زمان (حداکثر ~۲۰ نقطه از شروع پروژه تا امروز).
 * مقدار هر نقطه = درصد ترمینال‌های «بسته‌شده» (انجام + ناموفق) از کل ترمینال‌های آن پشتیبان در پروژه.
 * از رویدادهای تغییر وضعیت ساخته می‌شود؛ وضعیت‌هایی که بدون رویداد ثبت شده‌اند (مثلاً ایمپورت با وضعیت اولیه)
 * به‌صورت مقدار پایه در ابتدای بازه حساب می‌شوند تا نقطه‌ی آخر همیشه با وضعیت فعلی برابر باشد.
 */
export async function getProjectTrend(ctx: TenantContext, db: Queryable, id: number, today: string): Promise<ProjectTrendDto> {
  const project = await loadProject(ctx, db, id);
  const end = project.status === 'active' || today <= project.dueDate ? today : project.dueDate;
  const last = end < project.startDate ? project.startDate : end;
  const span = diffDaysIso(project.startDate, last);
  const step = Math.max(1, Math.ceil(span / 20));
  const dates: string[] = [];
  for (let d = project.startDate; d < last; d = addDaysIso(d, step)) dates.push(d);
  dates.push(last);

  const p1 = new SqlParams();
  const w1 = scopeWhere(ctx, p1, PT_SCOPE);
  w1.push(`pt.project_id = ${p1.add(id)}`);
  const totals = await queryRows<{ supporterId: number; name: string; unitId: number; total: number; resolved: number }>(db,
    `SELECT t.current_supporter_id AS "supporterId", s.full_name AS name, t.current_unit_id AS "unitId", count(*)::int AS total,
            (count(*) FILTER (WHERE pt.status IN ('done','failed')))::int AS resolved
       FROM project_terminals pt
       JOIN terminals t ON t.office_id = pt.office_id AND t.id = pt.terminal_id
       JOIN supporters s ON s.office_id = t.office_id AND s.id = t.current_supporter_id
      WHERE ${w1.join(' AND ')} GROUP BY t.current_supporter_id, s.full_name, t.current_unit_id`, p1.values);

  const p2 = new SqlParams();
  const w2 = scopeWhere(ctx, p2, PT_SCOPE);
  w2.push(`e.project_id = ${p2.add(id)}`);
  const deltas = await queryRows<{ supporterId: number; day: string; delta: number }>(db,
    `SELECT t.current_supporter_id AS "supporterId", ((e.created_at AT TIME ZONE 'Asia/Tehran')::date)::text AS day,
            sum((e.to_status IN ('done','failed'))::int - (COALESCE(e.from_status, 'not_started') IN ('done','failed'))::int)::int AS delta
       FROM project_terminal_events e JOIN terminals t ON t.office_id = e.office_id AND t.id = e.terminal_id
      WHERE ${w2.join(' AND ')} GROUP BY t.current_supporter_id, ((e.created_at AT TIME ZONE 'Asia/Tehran')::date)`, p2.values);
  const bySup = new Map<number, Array<{ day: string; delta: number }>>();
  for (const d of deltas) bySup.set(d.supporterId, [...(bySup.get(d.supporterId) ?? []), { day: d.day, delta: d.delta }]);

  const supporters = totals.map((t) => {
    const ev = bySup.get(t.supporterId) ?? [];
    const baseline = t.resolved - ev.reduce((a, x) => a + x.delta, 0);
    const values = dates.map((date) => {
      const n = baseline + ev.filter((x) => x.day <= date).reduce((a, x) => a + x.delta, 0);
      return Math.round((Math.min(t.total, Math.max(0, n)) / t.total) * 1000) / 10;
    });
    return { supporterId: t.supporterId, name: t.name, unitId: t.unitId, total: t.total, values };
  }).sort((a, b) => a.name.localeCompare(b.name, 'fa'));

  const totalDays = diffDaysIso(project.startDate, project.dueDate) + 1;
  const expectedPct = dates.map((date) =>
    Math.round(Math.min(1, Math.max(0, (diffDaysIso(project.startDate, date) + 1) / totalDays)) * 1000) / 10);
  return { dates, expectedPct, supporters };
}
