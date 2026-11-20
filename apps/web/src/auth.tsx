import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission } from '@pos/shared';
import { api, setLogoutHandler, tokens, type AuthUser } from './lib/api';

interface AuthCtx {
  user: AuthUser | null;
  ready: boolean;
  login: (office: string | undefined, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** مدیر دفتر یا ادمین داده */
  isManager: boolean;
  /** آیا کاربر این مجوز را دارد؟ (سطح دسترسی) */
  can: (permission: Permission) => boolean;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setLogoutHandler(() => setUser(null));
    if (!tokens.get()) { setReady(true); return; }
    api.me().then(setUser).catch(() => tokens.set(null)).finally(() => setReady(true));
  }, []);

  const login = useCallback(async (office: string | undefined, username: string, password: string) => {
    setUser(await api.login(office, username, password));
  }, []);
  const logout = useCallback(async () => { await api.logout(); setUser(null); }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      user, ready, login, logout, isManager: user?.role === 'office_manager' || user?.role === 'data_admin',
      can: (p: Permission) => !!user?.permissions?.includes(p),
    }),
    [user, ready, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
