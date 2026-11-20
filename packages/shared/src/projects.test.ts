import { describe, expect, it } from 'vitest';
import { parseProjectTerminalStatus, projectLag } from './projects';

const base = { startDate: '2025-01-01', dueDate: '2025-01-10', total: 100, failed: 0 };

describe('projectLag', () => {
  it('همه‌ی ترمینال‌ها بسته شده: completed (حتی بعد از سررسید)', () => {
    expect(projectLag({ ...base, today: '2025-02-01', done: 90, failed: 10 }).level).toBe('completed');
  });

  it('قبل از شروع: not_started_yet', () => {
    expect(projectLag({ ...base, today: '2024-12-30', done: 0 }).level).toBe('not_started_yet');
  });

  it('بعد از سررسید با کار باقی‌مانده: overdue', () => {
    const r = projectLag({ ...base, today: '2025-01-11', done: 99 });
    expect(r.level).toBe('overdue');
    expect(r.daysLeft).toBe(-1);
  });

  it('وسط بازه: خط برنامه‌ی خطی', () => {
    // روز ۵ از ۱۰ = ۵۰٪ مورد انتظار
    const ok = projectLag({ ...base, today: '2025-01-05', done: 45 });
    expect(ok.expectedPct).toBe(50);
    expect(ok.level).toBe('on_track'); // شکاف ۵ ≤ ۱۰
    expect(projectLag({ ...base, today: '2025-01-05', done: 35 }).level).toBe('at_risk'); // شکاف ۱۵
    expect(projectLag({ ...base, today: '2025-01-05', done: 20 }).level).toBe('behind'); // شکاف ۳۰ > ۲۰
  });

  it('ناموفق‌ها «بسته‌شده» حساب می‌شوند', () => {
    const r = projectLag({ ...base, today: '2025-01-05', done: 30, failed: 20 });
    expect(r.actualPct).toBe(50);
    expect(r.level).toBe('on_track');
  });

  it('پروژه‌ی بدون ترمینال: on_track و بدون تقسیم بر صفر', () => {
    const r = projectLag({ ...base, today: '2025-01-05', total: 0, done: 0 });
    expect(r.level).toBe('on_track');
    expect(r.actualPct).toBe(0);
  });

  it('آستانه‌ی سفارشی', () => {
    expect(projectLag({ ...base, today: '2025-01-05', done: 45, tolerancePct: 2 }).level).toBe('behind');
  });
});

describe('parseProjectTerminalStatus', () => {
  it('برچسب‌های فارسی و انگلیسی (با ی/ک عربی و نیم‌فاصله)', () => {
    expect(parseProjectTerminalStatus('انجام شده')).toBe('done');
    expect(parseProjectTerminalStatus(' در حال انجام ')).toBe('in_progress');
    expect(parseProjectTerminalStatus('DONE')).toBe('done');
    expect(parseProjectTerminalStatus('شروع‌نشده')).toBe('not_started');
    expect(parseProjectTerminalStatus('ناموفق')).toBe('failed');
    expect(parseProjectTerminalStatus('نامعلوم')).toBeNull();
  });
});
