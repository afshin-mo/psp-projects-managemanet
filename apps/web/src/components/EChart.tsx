import * as echarts from 'echarts';
import { useEffect, useRef } from 'react';
import { COLORS, FONT, PALETTE } from '../theme';

/** پوشش ساده‌ی ECharts؛ با تغییر option دوباره رسم می‌شود و با تغییر اندازه تنظیم می‌گردد. */
export function EChart({ option, height = 300, onClick }: {
  option: Record<string, unknown>; height?: number; onClick?: (p: { name: string; dataIndex: number }) => void;
}): JSX.Element {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    if (!el.current) return undefined;
    const c = echarts.init(el.current, undefined, { renderer: 'canvas' });
    chart.current = c;
    c.on('click', (p) => clickRef.current?.({ name: String(p.name), dataIndex: p.dataIndex }));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current);
    return () => { ro.disconnect(); c.dispose(); chart.current = null; };
  }, []);

  useEffect(() => {
    chart.current?.setOption({ color: PALETTE, textStyle: { fontFamily: FONT, color: COLORS.muted }, ...option } as echarts.EChartsOption, true);
  }, [option]);

  return <div ref={el} style={{ width: '100%', height }} />;
}
