import type pg from 'pg';

export interface AdoptResult { resolved: number; snapshots: number }

/**
 * ترمینال‌هایی که در صندوق «تعریف‌نشده‌ها» (pending_terminals) بودند و حالا در terminals وجود دارند
 * (با تعیین پشتیبان، ایجاد دستی یا ایمپورت ترمینال): ردیف‌های تراکنش نگه‌داشته‌شده‌شان وارد snapshot اصلی می‌شود
 * و ورودی صندوق «حل‌شده» می‌گردد. داده‌ی واقعی موجود هرگز بازنویسی نمی‌شود (ON CONFLICT DO NOTHING).
 * باید داخل transaction فراخوان باشد. terminalNos خالی = همه‌ی ورودی‌های pending که ترمینالشان الان وجود دارد.
 */
export async function adoptPendingRows(
  c: pg.PoolClient, officeId: number, userId: number | null, terminalNos?: readonly string[],
): Promise<AdoptResult> {
  // هر statement باید دقیقاً پارامترهای خودش را بگیرد (پارامتر بلااستفاده در PG خطا می‌دهد)
  const params = [officeId, terminalNos ?? null];
  const only = 'AND ($2::text[] IS NULL OR p.terminal_no = ANY($2::text[]))';
  const from = `FROM pending_terminal_snapshots s
       JOIN pending_terminals p ON p.office_id = s.office_id AND p.terminal_no = s.terminal_no
       JOIN terminals t ON t.office_id = p.office_id AND t.terminal_no = p.terminal_no
      WHERE p.office_id = $1 AND p.status = 'pending' ${only}`;

  await c.query(
    `SELECT ensure_period_partition(d.period_id)
       FROM (SELECT DISTINCT pr.period_id ${from.replace('WHERE', 'JOIN periods pr ON s.as_of_date >= pr.start_date AND s.as_of_date < pr.end_date WHERE')}) d`,
    params);

  const ins = await c.query(
    `INSERT INTO transactions_snapshot (office_id, terminal_id, as_of_date, cum_amount, cum_count, cum_total_amount, cum_total_count, source, import_batch_id)
     SELECT s.office_id, t.id, s.as_of_date, s.cum_amount, s.cum_count, s.cum_total_amount, s.cum_total_count, s.source, s.import_batch_id
       ${from}
      ORDER BY t.id, s.as_of_date
     ON CONFLICT (office_id, terminal_id, as_of_date) DO NOTHING`, params);

  // آمار از اولین تاریخ داده‌ی این ترمینال‌ها بازمحاسبه شود
  await c.query(
    `INSERT INTO recompute_outbox (office_id, terminal_id, effective_date, reason)
     SELECT $1::int, t.id, min(s.as_of_date), 'import' ${from} GROUP BY t.id`, params);

  const done = await c.query(
    `UPDATE pending_terminals p SET status = 'resolved', resolved_terminal_id = t.id, resolved_by = $3::int, resolved_at = now()
       FROM terminals t
      WHERE t.office_id = p.office_id AND t.terminal_no = p.terminal_no AND p.office_id = $1 AND p.status = 'pending' ${only}`, [officeId, terminalNos ?? null, userId]);

  await c.query(
    `DELETE FROM pending_terminal_snapshots s USING pending_terminals p
      WHERE p.office_id = s.office_id AND p.terminal_no = s.terminal_no AND p.office_id = $1 AND p.status = 'resolved' ${only}`, params);

  return { resolved: done.rowCount ?? 0, snapshots: ins.rowCount ?? 0 };
}
