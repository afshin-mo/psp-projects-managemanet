import type { ReactNode } from 'react';

/** کارت شاخص با نوار رنگی کنار؛ unit کنار عدد (مثلاً «میلیارد») */
export function Kpi({ title, value, unit, accent, children }: {
  title: string; value: ReactNode; unit?: string; accent?: string; children?: ReactNode;
}): JSX.Element {
  return (
    <div className="kpi" style={accent ? ({ '--kpi-accent': accent } as React.CSSProperties) : undefined}>
      <div className="kpi-title">{title}</div>
      <div className="kpi-value">{value}{unit && <span className="kpi-unit">{unit}</span>}</div>
      {children && <div className="kpi-sub">{children}</div>}
    </div>
  );
}
