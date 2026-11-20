import { Alert, Button, Card, Col, Row, Select, Space, Table, Tag, Typography, message } from 'antd';
import { useMemo, useState } from 'react';
import type { ForecastDto, ForecastRunDto, ForecastSummaryDto } from '@pos/shared';
import { Loading, NoData } from '../components/common';
import { EChart } from '../components/EChart';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { fmtMoney, fmtNum, fmtPct, jalaliText, periodLabel } from '../lib/format';
import { errMsg, useApi } from '../lib/hooks';
import { useRef2 } from '../refdata';

const MODEL_FA = { holt_winters: 'هولت-وینترز (فصلی)', holt: 'هولت (روند)', mean: 'میانگین' } as const;

export default function Forecast(): JSX.Element {
  const { user, isManager, can } = useAuth();
  const canRun = can('forecast.manage');
  const ref = useRef2();
  const defaultScope = isManager ? 'office' : user?.role === 'unit_head' ? 'unit' : 'supporter';
  const [scope, setScope] = useState<'office' | 'unit' | 'supporter'>(defaultScope);
  const [id, setId] = useState<number | undefined>(user?.role === 'unit_head' ? (user.unitId ?? undefined) : (user?.supporterId ?? undefined));
  const [busy, setBusy] = useState(false);

  const need = scope !== 'office' && id === undefined;
  const fc = useApi(() => (need ? Promise.resolve(null) : api.get<ForecastDto>('/forecast', { scope, id })), [scope, id]);
  const sumScope = scope === 'unit' ? 'unit' : 'supporter';
  const summary = useApi(() => (isManager || user?.role === 'unit_head' ? api.get<ForecastSummaryDto[]>('/forecast/summary', { scope: sumScope }) : Promise.resolve([])), [sumScope]);
  const status = useApi(() => (canRun ? api.get<{ run: ForecastRunDto | null }>('/forecast/status') : Promise.resolve(null)), [], 5000);

  const d = fc.data;
  const opt = useMemo(() => {
    if (!d) return {};
    const labels = [...d.history.map((h) => h.periodId), ...d.forecast.map((f) => f.periodId)];
    const hLen = d.history.length;
    const pad = (n: number): null[] => Array(n).fill(null) as null[];
    const last = d.history[hLen - 1]?.amount ?? null;
    return {
      tooltip: { trigger: 'axis' }, legend: { data: ['واقعی', 'پیش‌بینی', 'بازه‌ی اطمینان'] }, grid: { left: 70, right: 20, top: 40, bottom: 30 },
      xAxis: { type: 'category', data: labels.map(periodLabel) }, yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtMoney(v) } },
      series: [
        { name: 'واقعی', type: 'line', data: [...d.history.map((h) => h.amount), ...pad(d.forecast.length)] },
        { name: 'پیش‌بینی', type: 'line', lineStyle: { type: 'dashed' }, data: [...pad(Math.max(0, hLen - 1)), last, ...d.forecast.map((f) => f.value)] },
        { name: 'بازه‌ی اطمینان', type: 'line', stack: 'ci', symbol: 'none', lineStyle: { opacity: 0 }, data: [...pad(hLen), ...d.forecast.map((f) => f.lower)] },
        { name: 'بازه‌ی اطمینان', type: 'line', stack: 'ci', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.2 }, data: [...pad(hLen), ...d.forecast.map((f) => f.upper - f.lower)] },
      ],
    };
  }, [d]);

  const run = async (): Promise<void> => {
    setBusy(true);
    try { await api.post('/forecast/run', { horizon: 6 }); message.success('اجرای پیش‌بینی در صف قرار گرفت'); status.reload(); } catch (e) { message.error(errMsg(e)); } finally { setBusy(false); }
  };
  const r = status.data?.run;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          {isManager && <Select style={{ width: 140 }} value={scope} onChange={(v) => { setScope(v); setId(undefined); }}
            options={[{ value: 'office', label: 'کل دفتر' }, { value: 'unit', label: 'ستاد' }, { value: 'supporter', label: 'پشتیبان' }]} />}
          {scope === 'unit' && isManager && <Select style={{ width: 180 }} placeholder="ستاد" value={id} onChange={setId} options={ref.units.map((u) => ({ value: u.id, label: u.name }))} />}
          {scope === 'supporter' && user?.role !== 'supporter' && <Select showSearch optionFilterProp="label" style={{ width: 200 }} placeholder="پشتیبان" value={id} onChange={setId}
            options={ref.supporters.map((s) => ({ value: s.id, label: s.fullName }))} />}
          {canRun && <Button type="primary" loading={busy || r?.status === 'queued' || r?.status === 'running'} onClick={() => { void run(); }}>اجرای مجدد پیش‌بینی</Button>}
        </Space>
        {r && <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
          آخرین اجرا: {jalaliText(r.createdAt)} — <Tag color={r.status === 'done' ? 'green' : r.status === 'failed' ? 'red' : 'blue'}>{r.status}</Tag>
          {r.message ? ` ${r.message}` : ''}
        </Typography.Paragraph>}
      </Card>

      {need ? <Alert type="info" showIcon message="یک مورد را برای نمایش پیش‌بینی انتخاب کنید" /> : (
        <Loading loading={fc.loading} error={fc.error}>
          {d && d.forecast.length > 0 ? (
            <Card title={`${d.name} — پیش‌بینی ${fmtNum(d.forecast.length)} ماه آینده`}
              extra={<Space>{d.model && <Tag color="blue">{MODEL_FA[d.model]}</Tag>}{d.mape !== null && <Tag>خطای آزمون: {fmtPct(d.mape)}</Tag>}</Space>}>
              <EChart option={opt} height={360} />
              <Table size="small" rowKey="periodId" pagination={false} dataSource={d.forecast} columns={[
                { title: 'ماه', dataIndex: 'periodId', render: periodLabel }, { title: 'پیش‌بینی', dataIndex: 'value', render: fmtMoney },
                { title: 'کران پایین', dataIndex: 'lower', render: fmtMoney }, { title: 'کران بالا', dataIndex: 'upper', render: fmtMoney },
              ]} />
            </Card>
          ) : <Card><NoData /><Typography.Paragraph type="secondary">برای پیش‌بینی حداقل ۴ ماه کامل لازم است؛ پس از آماده شدن داده، اجرا را بزنید.</Typography.Paragraph></Card>}
        </Loading>
      )}

      {(isManager || user?.role === 'unit_head') && (
        <Row><Col span={24}><Card title={`پیش‌بینی ماه بعد به تفکیک ${sumScope === 'unit' ? 'ستاد' : 'پشتیبان'}`}>
          <Table size="small" rowKey="scopeId" loading={summary.loading} dataSource={summary.data ?? []} pagination={{ pageSize: 15 }} columns={[
            { title: 'نام', dataIndex: 'name' },
            { title: 'آخرین ماه واقعی', dataIndex: 'lastActual', render: fmtMoney },
            { title: 'پیش‌بینی ماه بعد', dataIndex: 'value', render: fmtMoney, sorter: (a, b) => a.value - b.value },
            { title: 'تغییر', dataIndex: 'changePct', render: (v: number | null) => (v === null ? '—' : <Tag color={v >= 0 ? 'green' : 'red'}>{fmtPct(v)}</Tag>), sorter: (a, b) => (a.changePct ?? 0) - (b.changePct ?? 0) },
            { title: 'مدل', dataIndex: 'model', render: (m: keyof typeof MODEL_FA) => MODEL_FA[m] },
          ]} />
        </Card></Col></Row>
      )}
    </Space>
  );
}
