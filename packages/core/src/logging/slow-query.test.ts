import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createQueryTimer } from './slow-query';

function fakeLogger() {
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, warn };
}

describe('createQueryTimer', () => {
  it('کوئری کند را لاگ و ثبت می‌کند', async () => {
    const { logger, warn } = fakeLogger();
    const record = vi.fn().mockResolvedValue(undefined);
    let t = 0;
    const timed = createQueryTimer({ logger, thresholdMs: 100, sink: { record }, now: () => t });
    const result = await timed('kpi', async () => { t += 250; return 42; }, { officeId: 7 });
    expect(result).toBe(42);
    expect(warn).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ queryName: 'kpi', officeId: 7 }));
  });

  it('کوئری سریع را ثبت نمی‌کند', async () => {
    const { logger, warn } = fakeLogger();
    const record = vi.fn();
    let t = 0;
    const timed = createQueryTimer({ logger, thresholdMs: 100, sink: { record }, now: () => t });
    await timed('fast', async () => { t += 10; });
    expect(warn).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('خطا را بازپرتاب می‌کند و باز هم زمان را اندازه می‌گیرد', async () => {
    const { logger, warn } = fakeLogger();
    let t = 0;
    const timed = createQueryTimer({ logger, thresholdMs: 1, now: () => t });
    await expect(timed('boom', async () => { t += 5; throw new Error('x'); })).rejects.toThrow('x');
    expect(warn).toHaveBeenCalledOnce();
  });
});
