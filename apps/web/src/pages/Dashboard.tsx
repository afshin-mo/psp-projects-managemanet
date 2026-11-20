import { DownloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Row, Segmented, Select, Space, Table, Tabs, Tag, Tooltip } from 'antd';
import { useMemo, useState } from 'react';
import {
  periodIdOfDate, shiftPeriod, type BankShareDto, type CoverageDto, type DroppedTerminalDto, type GrowthItemDto, type HeatmapDto,
  type KpiDto, type Page, type PreliminaryAlertDto,
} from '@pos/shared';
import { Kpi } from '../components/Kpi';
import { ProjectProgress } from '../components/ProjectProgress';
import { TrendCard } from '../components/TrendCard';
import { Loading, NoData } from '../components/common';
import { COLORS, HEAT } from '../theme';
import { EChart } from '../components/EChart';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { fmtMoney, fmtNum, fmtPct, periodLabel, todayIso } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useRef2 } from '../refdata';

const pctTag = (v: number | null | undefined, suffix = ''): JSX.Element =>
  v === null || v === undefined ? <Tag>—</Tag> : <Tag color={v >= 0 ? 'green' : 'red'}>{v >= 0 ? '▲' : '▼'} {fmtPct(Math.abs(v))}{suffix}</Tag>;

export default function Dashboard(): JSX.Element {
  const { user, isManager } = useAuth();
  const ref = useRef2();
  const nowPeriod = periodIdOfDate(todayIso());
  const [to, setTo] = useState(nowPeriod);
  const [unitId, setUnitId] = useState<number | undefined>();
  const [bankId, setBankId] = useState<number | undefined>();
  const [by, setBy] = useState<'supporter' | 'unit' | 'route'>('supporter');
  const [metric, setMetric] = useState<'amount' | 'txCount' | 'active'>('amount');

  const from = shiftPeriod(to, -11);
  const f = useMemo(() => ({ unitId, bankId }), [unitId, bankId]);
  const periods = useMemo(() => Array.from({ length: 24 }, (_, i) => shiftPeriod(nowPeriod, -i)), [nowPeriod]);

  const kpi = useApi(() => api.get<KpiDto>('/analytics/kpi', { ...f, to }), [to, unitId, bankId]);
  const share = useApi(() => api.get<BankShareDto[]>('/analytics/bank-share', { ...f, period: to }), [to, unitId, bankId]);
  const growth = useApi(() => api.get<GrowthItemDto[]>('/analytics/growth', { ...f, period: to, by }), [to, unitId, bankId, by]);
  const heat = useApi(() => api.get<HeatmapDto>('/analytics/heatmap', { ...f, from, to, metric }), [to, unitId, bankId, metric]);
  const cov = useApi(() => api.get<CoverageDto[]>('/analytics/coverage'), []);
  const dropped = useApi(() => api.get<Page<DroppedTerminalDto>>('/analytics/alerts/dropped-terminals', { ...f, period: to, limit: 50 }), [to, unitId, bankId]);
  const prelim = useApi(() => api.get<Page<PreliminaryAlertDto>>('/analytics/alerts/preliminary', { ...f, limit: 50 }), [to, unitId, bankId]);

  const k = kpi.data;
  const incomplete = (cov.data ?? []).find((c) => c.periodId === to && !c.isComplete);

  const pieOpt = {
    tooltip: { trigger: 'item', formatter: '{b}: {d}٪' },
    series: [{ type: 'pie', radius: ['40%', '70%'], data: (share.data ?? []).map((b) => ({ name: b.name, value: b.amount })) }],
  };
  const h = heat.data;
  const heatOpt = h && {
    tooltip: { position: 'top' }, grid: { left: 130, right: 20, top: 10, bottom: 50 },
    xAxis: { type: 'category', data: h.periods.map(periodLabel), splitArea: { show: true } },
    yAxis: { type: 'category', data: h.rows.map((r) => r.name), inverse: true },
    visualMap: { min: 0, max: Math.max(1, ...h.rows.flatMap((r) => r.values)), calculable: true, orient: 'horizontal', left: 'center', bottom: 0, show: false, inRange: { color: HEAT } },
    series: [{ type: 'heatmap', data: h.rows.flatMap((r, y) => r.values.map((v, x) => [x, y, v])), label: { show: false } }],
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <Select style={{ width: 160 }} value={to} onChange={setTo} options={periods.map((p) => ({ value: p, label: periodLabel(p) }))} />
          {isManager && (
            <Select allowClear placeholder="همه‌ی ستادها" style={{ width: 160 }} value={unitId} onChange={setUnitId}
              options={ref.units.map((u) => ({ value: u.id, label: u.name }))} />
          )}
          <Select allowClear placeholder="همه‌ی بانک‌ها" style={{ width: 160 }} value={bankId} onChange={setBankId}
            options={ref.banks.map((b) => ({ value: b.id, label: b.name }))} />
          {user?.role !== 'supporter' && (
            <Button icon={<DownloadOutlined />} onClick={() => { void api.download('/analytics/export', { ...f, from, to, period: to, report: 'trend' }, 'trend.xlsx'); }}>خروجی روند</Button>
          )}
        </Space>
      </Card>

      {incomplete && (
        <Alert type="warning" showIcon message={`ماه ${periodLabel(to)} هنوز کامل نیست`}
          description={`برای ${fmtNum(incomplete.withoutFile)} ترمینال فایل پایان ماه نرسیده؛ ارقام این ماه موقتی و تخمینی است.`} />
      )}

      <Loading loading={kpi.loading} error={kpi.error}>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={12} xl={6}>
            <Kpi title="مبلغ تراکنش‌ها" value={fmtMoney(k?.current?.amount)} accent={COLORS.teal}>
              <span>ماه قبل {pctTag(k?.mom.amountPct)}{k?.mom.basis === 'projected' && <Tooltip title="بر پایه‌ی پیش‌بینی ماه ناقص"><Tag>تخمینی</Tag></Tooltip>}</span>
              <span>سال قبل {pctTag(k?.yoy.amountPct)}</span>
            </Kpi>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Kpi title="تعداد تراکنش" value={fmtNum(k?.current?.txCount)} accent={COLORS.saffron}>
              <span>ماه قبل {pctTag(k?.mom.txCountPct)}</span>
            </Kpi>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Kpi title="ترمینال فعال" value={fmtNum(k?.current?.activeTerminals)} accent={COLORS.indigo}>
              <span>کم‌تراکنش {fmtNum(k?.current?.lowTerminals)}</span><span>برگشتی {fmtNum(k?.current?.returnedTerminals)}</span>
            </Kpi>
          </Col>
          <Col xs={24} sm={12} xl={6}>
            <Kpi title="پیش‌بینی پایان ماه" value={k?.projection ? fmtMoney(k.projection.projectedAmount) : '—'} accent={COLORS.brick}>
              <span>{k?.projection ? `بر پایه‌ی ${fmtNum(k.projection.daysCovered)} از ${fmtNum(k.projection.daysInMonth)} روز` : 'ماه کامل است'}</span>
            </Kpi>
          </Col>
        </Row>
      </Loading>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}><TrendCard unitId={unitId} bankId={bankId} from={from} to={to} /></Col>
        <Col xs={24} lg={8}><Card title="سهم بانک‌ها"><Loading loading={share.loading} error={share.error}>
          {(share.data ?? []).length ? <EChart option={pieOpt} /> : <NoData />}</Loading></Card></Col>
      </Row>

      <ProjectProgress />

      <Card title="رشد" extra={<Segmented value={by} onChange={(v) => setBy(v as typeof by)}
        options={[{ value: 'supporter', label: 'پشتیبان' }, ...(isManager ? [{ value: 'unit', label: 'ستاد' }] : []), { value: 'route', label: 'مسیر' }]} />}>
        <Loading loading={growth.loading} error={growth.error}>
          <Table size="small" rowKey="id" dataSource={growth.data ?? []} pagination={{ pageSize: 10 }} columns={[
            { title: 'نام', dataIndex: 'name' },
            { title: 'مبلغ', dataIndex: 'amount', render: fmtMoney, sorter: (a, b) => a.amount - b.amount },
            { title: 'سهم', dataIndex: 'sharePct', render: fmtPct },
            { title: 'نسبت به ماه قبل', dataIndex: 'momPct', render: (v: number | null) => pctTag(v), sorter: (a, b) => (a.momPct ?? 0) - (b.momPct ?? 0) },
            { title: 'نسبت به سال قبل', dataIndex: 'yoyPct', render: (v: number | null) => pctTag(v) },
          ]} />
        </Loading>
      </Card>

      <Card title="نقشه‌ی حرارتی پشتیبان × ماه" extra={<Segmented value={metric} onChange={(v) => setMetric(v as typeof metric)}
        options={[{ value: 'amount', label: 'مبلغ' }, { value: 'txCount', label: 'تراکنش' }, { value: 'active', label: 'فعال' }]} />}>
        <Loading loading={heat.loading} error={heat.error}>
          {h && h.rows.length ? <EChart option={heatOpt as never} height={Math.max(220, h.rows.length * 26 + 80)} /> : <NoData />}
        </Loading>
      </Card>

      <Card title="هشدارها">
        <Tabs items={[
          { key: 'd', label: `افت ماه کامل (${fmtNum(dropped.data?.items.length ?? 0)})`, children: (
            <Table size="small" rowKey="id" loading={dropped.loading} dataSource={dropped.data?.items ?? []} pagination={{ pageSize: 10 }} columns={[
              { title: 'ترمینال', dataIndex: 'terminalNo' }, { title: 'فروشگاه', dataIndex: 'shopName' },
              { title: 'پشتیبان', dataIndex: 'supporterId', render: (v: number) => ref.supporterName(v) },
              { title: 'میانگین ۳ ماه', dataIndex: 'avg3Amount', render: fmtMoney }, { title: 'این ماه', dataIndex: 'currentAmount', render: fmtMoney },
              { title: 'افت', dataIndex: 'dropPct', render: (v: number) => <Tag color="red">{fmtPct(v)}</Tag> },
            ]} />) },
          { key: 'p', label: `هشدار مقدماتی ماه جاری (${fmtNum(prelim.data?.items.length ?? 0)})`, children: (
            <Table size="small" rowKey="id" loading={prelim.loading} dataSource={prelim.data?.items ?? []} pagination={{ pageSize: 10 }} columns={[
              { title: 'ترمینال', dataIndex: 'terminalNo' }, { title: 'فروشگاه', dataIndex: 'shopName' },
              { title: 'پشتیبان', dataIndex: 'supporterId', render: (v: number) => ref.supporterName(v) },
              { title: 'میانگین ۳ ماه', dataIndex: 'avg3Amount', render: fmtMoney }, { title: 'پیش‌بینی ماه', dataIndex: 'projectedAmount', render: fmtMoney },
              { title: 'افت', dataIndex: 'dropPct', render: (v: number) => <Tag color="orange">{fmtPct(v)}</Tag> },
            ]} />) },
        ]} />
      </Card>
    </Space>
  );
}
