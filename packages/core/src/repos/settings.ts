import type pg from 'pg';
import type { ActivityRuleDto, ActivityRuleInput, OfficeSettingsDto, PatchOfficeSettingsInput } from '@pos/shared';
import { writeAudit } from '../audit/audit';
import { SqlParams } from '../db/sql';
import { queryOne, queryRows, withTx, type Queryable } from '../db/types';
import { HttpError, notFound } from '../errors';
import { assertRoles, type TenantContext, type TenantRole } from '../tenant/scope';

const READERS: readonly TenantRole[] = ['office_manager', 'data_admin', 'unit_head'];
const WRITERS: readonly TenantRole[] = ['office_manager', 'data_admin'];

const S_COLS = `new_terminal_cutoff_day AS "newTerminalCutoffDay", preliminary_alert_min_day AS "preliminaryAlertMinDay",
  drop_alert_threshold_pct AS "dropAlertThresholdPct", income_basis AS "incomeBasis",
  auto_no_income_prev AS "autoNoIncomePrev", auto_prev_deadline_day AS "autoPrevDeadlineDay",
  auto_no_income_curr AS "autoNoIncomeCurr", auto_curr_check_day AS "autoCurrCheckDay",
  sync_terminal_info AS "syncTerminalInfo", sync_create_banks AS "syncCreateBanks",
  score_weights AS "scoreWeights", updated_at AS "updatedAt"`;

export async function getOfficeSettings(ctx: TenantContext, db: Queryable): Promise<OfficeSettingsDto> {
  assertRoles(ctx, READERS);
  const row = await queryOne<OfficeSettingsDto>(db, `SELECT ${S_COLS} FROM office_settings WHERE office_id = $1`, [ctx.officeId]);
  if (!row) throw notFound('تنظیمات دفتر');
  return row;
}

const FIELDS = {
  newTerminalCutoffDay: 'new_terminal_cutoff_day',
  preliminaryAlertMinDay: 'preliminary_alert_min_day',
  dropAlertThresholdPct: 'drop_alert_threshold_pct',
  incomeBasis: 'income_basis',
  autoNoIncomePrev: 'auto_no_income_prev',
  autoPrevDeadlineDay: 'auto_prev_deadline_day',
  autoNoIncomeCurr: 'auto_no_income_curr',
  autoCurrCheckDay: 'auto_curr_check_day',
  syncTerminalInfo: 'sync_terminal_info',
  syncCreateBanks: 'sync_create_banks',
} as const;
type FieldKey = keyof typeof FIELDS;

/** changed.* نشان می‌دهد کدام تغییرها به بازطبقه‌بندی/بازمحاسبه‌ی هشدار نیاز دارند */
export async function updateOfficeSettings(
  ctx: TenantContext, pool: pg.Pool, input: PatchOfficeSettingsInput,
): Promise<{ settings: OfficeSettingsDto; reclassify: boolean }> {
  assertRoles(ctx, WRITERS);
  return withTx(pool, async (c) => {
    const cur = await queryOne<OfficeSettingsDto>(c, `SELECT ${S_COLS} FROM office_settings WHERE office_id = $1 FOR UPDATE`, [ctx.officeId]);
    if (!cur) throw notFound('تنظیمات دفتر');
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const p = new SqlParams();
    const sets: string[] = [];
    for (const key of Object.keys(FIELDS) as FieldKey[]) {
      const next = input[key];
      if (next === undefined || next === cur[key]) continue;
      before[key] = cur[key];
      after[key] = next;
      sets.push(`${FIELDS[key]} = ${p.add(next)}`);
    }
    const w = input.scoreWeights;
    if (w && JSON.stringify(w) !== JSON.stringify(cur.scoreWeights)) {
      before.scoreWeights = cur.scoreWeights;
      after.scoreWeights = w;
      sets.push(`score_weights = ${p.add(JSON.stringify(w))}::jsonb`);
    }
    if (sets.length === 0) return { settings: cur, reclassify: false };
    sets.push(`updated_by = ${p.add(ctx.userId)}`, 'updated_at = now()');
    await c.query(`UPDATE office_settings SET ${sets.join(', ')} WHERE office_id = ${p.add(ctx.officeId)}`, p.values);
    await c.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [ctx.officeId]); // کش آماری بی‌اعتبار شود
    await writeAudit(c, { officeId: ctx.officeId, userId: ctx.userId, entityType: 'office_settings', entityId: ctx.officeId, action: 'setting', before, after });
    const settings = (await queryOne<OfficeSettingsDto>(c, `SELECT ${S_COLS} FROM office_settings WHERE office_id = $1`, [ctx.officeId])) as OfficeSettingsDto;
    // روز نوپا و درصد افت روی طبقه‌ی ماهانه/هشدارهای موجود اثر می‌گذارند؛ روز هشدار مقدماتی فقط در لحظه‌ی خواندن
    return { settings, reclassify: 'newTerminalCutoffDay' in after || 'dropAlertThresholdPct' in after || 'incomeBasis' in after };
  });
}

const R_COLS = `bank_id AS "bankId", valid_from_period AS "validFromPeriod", min_monthly_amount AS "minMonthlyAmount", created_at AS "createdAt"`;

export async function listActivityRules(ctx: TenantContext, db: Queryable): Promise<ActivityRuleDto[]> {
  assertRoles(ctx, READERS);
  return queryRows(db, `SELECT ${R_COLS} FROM activity_rules WHERE office_id = $1 ORDER BY bank_id, valid_from_period DESC`, [ctx.officeId]);
}

/** ثبت/به‌روزرسانی آستانه برای (بانک، دوره‌ی شروع). فراخواننده باید activity.reclassify را از validFromPeriod صف کند. */
export async function upsertActivityRule(ctx: TenantContext, pool: pg.Pool, input: ActivityRuleInput): Promise<ActivityRuleDto> {
  assertRoles(ctx, WRITERS);
  return withTx(pool, async (c) => {
    if (input.bankId > 0) {
      const bank = await queryOne(c, 'SELECT 1 AS ok FROM banks WHERE office_id = $1 AND id = $2', [ctx.officeId, input.bankId]);
      if (!bank) throw new HttpError(422, 'INVALID_BANK', 'بانک نامعتبر است');
    }
    const prev = await queryOne<{ minMonthlyAmount: number }>(c,
      `SELECT min_monthly_amount AS "minMonthlyAmount" FROM activity_rules
        WHERE office_id = $1 AND bank_id = $2 AND valid_from_period = $3 FOR UPDATE`,
      [ctx.officeId, input.bankId, input.validFromPeriod]);
    const row = await queryOne<ActivityRuleDto>(c,
      `INSERT INTO activity_rules (office_id, bank_id, valid_from_period, min_monthly_amount, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (office_id, bank_id, valid_from_period)
       DO UPDATE SET min_monthly_amount = EXCLUDED.min_monthly_amount, created_by = EXCLUDED.created_by, created_at = now()
       RETURNING ${R_COLS}`,
      [ctx.officeId, input.bankId, input.validFromPeriod, input.minMonthlyAmount, ctx.userId]);
    await writeAudit(c, {
      officeId: ctx.officeId, userId: ctx.userId, entityType: 'activity_rule', entityId: input.bankId, action: 'setting',
      before: prev ? { validFromPeriod: input.validFromPeriod, minMonthlyAmount: prev.minMonthlyAmount } : null,
      after: { validFromPeriod: input.validFromPeriod, minMonthlyAmount: input.minMonthlyAmount },
    });
    await c.query('UPDATE offices SET data_version = data_version + 1 WHERE id = $1', [ctx.officeId]);
    return row as ActivityRuleDto;
  });
}

/** وضعیت تجمیع (برای مدیر): کار معوق و نسخه‌ی داده */
export async function getAggregationStatus(
  ctx: TenantContext, db: Queryable,
): Promise<{ pendingOutbox: number; aggregatingBatches: number; dataVersion: number }> {
  assertRoles(ctx, ['office_manager']);
  const row = await queryOne<{ pendingOutbox: number; aggregatingBatches: number; dataVersion: number }>(db,
    `SELECT (SELECT count(*) FROM recompute_outbox WHERE office_id = $1 AND processed_at IS NULL)::int AS "pendingOutbox",
            (SELECT count(*) FROM import_batches WHERE office_id = $1 AND status = 'aggregating')::int AS "aggregatingBatches",
            o.data_version AS "dataVersion"
       FROM offices o WHERE o.id = $1`, [ctx.officeId]);
  if (!row) throw notFound('دفتر');
  return row;
}
