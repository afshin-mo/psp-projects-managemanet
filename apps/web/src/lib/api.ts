/** کلاینت API: توکن در localStorage، تمدید خودکار با refresh token، و خطای یکدست */

const BASE = '/api/v1';
const KEY = 'pos.tokens';

export interface AuthUser {
  id: number; username: string; fullName: string;
  role: 'system_admin' | 'office_manager' | 'unit_head' | 'supporter' | 'data_admin';
  officeId: number | null; unitId: number | null; supporterId: number | null;
  /** مجوزهای مؤثر کاربر (سطح دسترسی) */
  permissions: string[];
}
interface Tokens { accessToken: string; refreshToken: string }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const tokens = {
  get(): Tokens | null {
    try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Tokens | null; } catch { return null; }
  },
  set(t: Tokens | null): void {
    try { if (t) localStorage.setItem(KEY, JSON.stringify(t)); else localStorage.removeItem(KEY); } catch { /* ignore */ }
  },
};

let onLogout: () => void = () => undefined;
export const setLogoutHandler = (fn: () => void): void => { onLogout = fn; };

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  const t = tokens.get();
  if (!t) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }),
      });
      if (!res.ok) return false;
      const j = (await res.json()) as Tokens;
      tokens.set({ accessToken: j.accessToken, refreshToken: j.refreshToken });
      return true;
    } catch { return false; } finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

function qs(params?: Record<string, unknown>): string {
  if (!params) return '';
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    return new ApiError(res.status, j.error?.code ?? 'ERROR', j.error?.message ?? res.statusText, j.error?.details);
  } catch { return new ApiError(res.status, 'ERROR', res.statusText || 'خطای ناشناخته'); }
}

async function raw(path: string, init: RequestInit & { retry?: boolean } = {}): Promise<Response> {
  const t = tokens.get();
  const headers = new Headers(init.headers);
  if (t) headers.set('authorization', `Bearer ${t.accessToken}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401 && init.retry !== false && t) {
    if (await refresh()) return raw(path, { ...init, retry: false });
    tokens.set(null);
    onLogout();
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

async function json<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await raw(path, {
    method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string, params?: Record<string, unknown>) => json<T>(`${path}${qs(params)}`, 'GET'),
  post: <T>(path: string, body?: unknown) => json<T>(path, 'POST', body ?? {}),
  patch: <T>(path: string, body: unknown) => json<T>(path, 'PATCH', body),
  put: <T>(path: string, body: unknown) => json<T>(path, 'PUT', body),
  del: (path: string) => json<void>(path, 'DELETE'),
  /** آپلود multipart؛ فیلدها باید قبل از فایل بیایند (API همین را لازم دارد) */
  upload: async <T>(path: string, fields: Record<string, string>, file: File): Promise<T> => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('file', file);
    return (await (await raw(path, { method: 'POST', body: fd })).json()) as T;
  },
  /** دانلود فایل با توکن (لینک ساده Authorization ندارد) */
  download: async (path: string, params?: Record<string, unknown>, fallbackName = 'download.xlsx'): Promise<void> => {
    const res = await raw(`${path}${qs(params)}`);
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m?.[1] ? decodeURIComponent(m[1]) : fallbackName;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  login: async (officeCode: string | undefined, username: string, password: string): Promise<AuthUser> => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(officeCode ? { officeCode } : {}), username, password }),
    });
    if (!res.ok) throw await parseError(res);
    const j = (await res.json()) as Tokens & { user: AuthUser };
    tokens.set({ accessToken: j.accessToken, refreshToken: j.refreshToken });
    return j.user;
  },
  logout: async (): Promise<void> => {
    const t = tokens.get();
    tokens.set(null);
    if (t) await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) }).catch(() => undefined);
  },
  me: () => json<AuthUser>('/auth/me', 'GET'),
};
