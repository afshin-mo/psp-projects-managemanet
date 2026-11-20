import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface ApiState<T> { data: T | null; loading: boolean; error: string | null; reload: () => void }

/** بارگذاری داده با وابستگی‌ها؛ پاسخ‌های قدیمی (race) نادیده گرفته می‌شوند. pollMs: بازخوانی دوره‌ای */
export function useApi<T>(fn: () => Promise<T>, deps: readonly unknown[], pollMs?: number): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (silent: boolean) => {
    const my = ++seq.current;
    if (!silent) setLoading(true);
    try {
      const r = await fnRef.current();
      if (my === seq.current) { setData(r); setError(null); }
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError ? e.message : 'خطا در ارتباط با سرور');
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(false); }, deps);
  useEffect(() => {
    if (!pollMs) return undefined;
    const t = setInterval(() => { void run(true); }, pollMs);
    return () => clearInterval(t);
  }, [pollMs, run]);

  return { data, loading, error, reload: () => { void run(false); } };
}

export const errMsg = (e: unknown): string => (e instanceof ApiError ? e.message : 'خطا در ارتباط با سرور');
