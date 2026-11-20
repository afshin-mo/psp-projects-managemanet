import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BankDto, RouteGroupDto, StaffUnitDto, SupporterDto } from '@pos/shared';
import { api } from './lib/api';
import { useAuth } from './auth';

interface RefData {
  units: StaffUnitDto[];
  supporters: SupporterDto[];
  banks: BankDto[];
  routes: RouteGroupDto[];
  unitName: (id: number | null | undefined) => string;
  supporterName: (id: number | null | undefined) => string;
  bankName: (id: number | null | undefined) => string;
  routeName: (id: number | null | undefined) => string;
  reload: () => void;
}

const Ctx = createContext<RefData | null>(null);

/** داده‌های پایه (ستاد، پشتیبان، بانک، مسیر) برای انتخاب‌گرها و نمایش نام‌ها؛ فقط در دامنه‌ی دسترسی نقش */
export function RefDataProvider({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  const [d, setD] = useState({ units: [] as StaffUnitDto[], supporters: [] as SupporterDto[], banks: [] as BankDto[], routes: [] as RouteGroupDto[] });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!user) return;
    void Promise.all([
      api.get<StaffUnitDto[]>('/staff-units'), api.get<SupporterDto[]>('/supporters'),
      api.get<BankDto[]>('/banks'), api.get<RouteGroupDto[]>('/route-groups'),
    ]).then(([units, supporters, banks, routes]) => setD({ units, supporters, banks, routes })).catch(() => undefined);
  }, [user, tick]);

  const value = useMemo<RefData>(() => {
    const mk = <T extends { id: number }>(list: T[], f: (x: T) => string) => {
      const m = new Map(list.map((x) => [x.id, f(x)]));
      return (id: number | null | undefined): string => (id === null || id === undefined ? '—' : (m.get(id) ?? `#${id}`));
    };
    return {
      ...d,
      unitName: mk(d.units, (x) => x.name), supporterName: mk(d.supporters, (x) => x.fullName),
      bankName: mk(d.banks, (x) => x.name), routeName: mk(d.routes, (x) => x.name),
      reload: () => setTick((t) => t + 1),
    };
  }, [d]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRef2(): RefData {
  const c = useContext(Ctx);
  if (!c) throw new Error('RefDataProvider missing');
  return c;
}
