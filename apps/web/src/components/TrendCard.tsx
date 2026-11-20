import { Card, Segmented, Select, Space } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { BankShareDto, GrowthItemDto, PeriodMetrics } from '@pos/shared';
import { api } from '../lib/api';
import { fmtMoney, fmtNum, periodLabel } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useRef2 } from '../refdata';
import { Loading, NoData } from './common';
import { EChart } from './EChart';

type Metric = 'amount' | 'txCount' | 'activeTerminals';
type Group = 'total' | 'bank' | 'supporter';

const METRIC_FA: Record<Metric, string> = { amount: 'مبلغ', txCount: 'تراکنش', activeTerminals: 'ترمینال فعال' };
const fmt = (m: Metric): ((v: number) => string) => (m === 'amount' ? fmtMoney : fmtNum);

/**
 * روند ۱۲ ماهه با انتخاب شاخص (مبلغ، تعداد تراکنش، ترمینال فعال) و تفکیک (کل، بانک‌ها، پشتیبان‌ها).
 * در حالت تفکیک، چند بانک/پشتیبان به‌صورت هم‌زمان روی یک نمودار مقایسه می‌شوند؛ پیش‌فرض ۵ مورد برتر ماه انتخاب‌شده.
 */
export function TrendCard({ unitId, bankId, from, to }: { unitId?: number; bankId?: number; from: number; to: number }): JSX.Element {
  const ref = useRef2();
  const [metric, setMetric] = useState<Metric>('amount');
  const [group, setGroup] = useState<Group>('total');
  const [ids, setIds] = useState<number[]>([]);

  // با تغییر تفکیک/ماه/ستاد، ۵ مورد برتر انتخاب می‌شود
  useEffect(() => {
    if (group === 'total') { setIds([]); return undefined; }
    let alive = true;
    const pickTop = group === 'bank'
      ? api.get<BankShareDto[]>('/analytics/bank-share', { period: to, unitId }).then((r) => r.filter((x) => x.bankId !== 0).slice(0, 5).map((x) => x.bankId))
      : api.get<GrowthItemDto[]>('/analytics/growth', { period: to, unitId, bankId, by: 'supporter' }).then((r) => r.slice(0, 5).map((x) => x.id));
    void pickTop.then((top) => { if (alive) setIds(top); }).catch(() => { if (alive) setIds([]); });
    return () => { alive = false; };
  }, [group, to, unitId, bankId]);

  const key = ids.join(',');
  const data = useApi(async () => {
    const base = { from, to, unitId };
    if (group === 'total') return [{ name: 'همه', rows: await api.get<PeriodMetrics[]>('/analytics/trend', { ...base, bankId }) }];
    return Promise.all(ids.map(async (id) => ({
      name: group === 'bank' ? ref.bankName(id) : ref.supporterName(id),
      rows: await api.get<PeriodMetrics[]>('/analytics/trend', group === 'bank' ? { ...base, bankId: id } : { ...base, bankId, supporterId: id }),
    })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, key, from, to, unitId, bankId]);

  const series = data.data ?? [];
  const periods = series[0]?.rows.map((r) => r.periodId) ?? [];
  const f = fmt(metric);

  const option = useMemo(() => {
    const single = series.length === 1;
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => f(v) },
      legend: single ? undefined : { type: 'scroll', top: 0 },
      grid: { left: 70, right: 24, top: single ? 24 : 44, bottom: 30 },
      xAxis: { type: 'category', data: periods.map(periodLabel) },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => f(v) }, splitLine: { lineStyle: { color: '#ece6d6' } } },
      series: series.map((s) => single
        ? { name: METRIC_FA[metric], type: 'bar', barMaxWidth: 38, itemStyle: { borderRadius: [6, 6, 0, 0] },
            data: s.rows.map((r) => ({ value: r[metric], itemStyle: r.isComplete ? undefined : { opacity: 0.45 } })) }
        : { name: s.name, type: 'line', smooth: true, symbolSize: 6, data: s.rows.map((r) => r[metric]) }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.data, metric]);

  const options = group === 'bank'
    ? ref.banks.map((b) => ({ value: b.id, label: b.name }))
    : ref.supporters.filter((s) => unitId === undefined || s.staffUnitId === unitId).map((s) => ({ value: s.id, label: s.fullName }));

  return (
    <Card title="روند ۱۲ ماهه" extra={(
      <Space wrap>
        <Segmented value={metric} onChange={(v) => setMetric(v as Metric)} options={(Object.keys(METRIC_FA) as Metric[]).map((m) => ({ value: m, label: METRIC_FA[m] }))} />
        <Segmented value={group} onChange={(v) => setGroup(v as Group)} options={[{ value: 'total', label: 'کل' }, { value: 'bank', label: 'بر حسب بانک' }, { value: 'supporter', label: 'بر حسب پشتیبان' }]} />
      </Space>
    )}>
      {group !== 'total' && (
        <Select mode="multiple" allowClear showSearch optionFilterProp="label" maxTagCount="responsive" style={{ width: '100%', marginBottom: 12 }}
          placeholder={group === 'bank' ? 'بانک‌ها را برای مقایسه انتخاب کنید' : 'پشتیبان‌ها را برای مقایسه انتخاب کنید'}
          value={ids} onChange={(v) => setIds((v as number[]).slice(0, 10))} options={options} />
      )}
      <Loading loading={data.loading} error={data.error}>
        {series.length > 0 && periods.length > 0 ? <EChart option={option} height={330} /> : <NoData />}
      </Loading>
    </Card>
  );
}
