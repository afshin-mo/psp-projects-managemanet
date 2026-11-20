import { ArrowDownOutlined, ArrowRightOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Alert, Card, Col, Descriptions, Drawer, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import { useMemo, useState } from 'react';
import {
  SCORE_BAND_FA, SCORE_COMPONENTS, SCORE_COMPONENT_FA, buildScoreComments, type ScoreComponent, type ScoreboardDto, type SupporterScoreDto,
} from '@pos/shared';
import { Loading, NoData } from '../components/common';
import { EChart } from '../components/EChart';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { fmtMoney, fmtNum, fmtPct, periodLabel } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useRef2 } from '../refdata';

const BAND_COLOR: Record<string, string> = { excellent: '#389e0d', good: '#13a8a8', average: '#d4b106', weak: '#d46b08', poor: '#cf1322' };
const sc = (v: number | null): string => (v === null ? '—' : new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(v));

function Trend({ t }: { t: SupporterScoreDto['trend'] }): JSX.Element {
  if (t === 'up') return <Tag color="green" icon={<ArrowUpOutlined />}>صعودی</Tag>;
  if (t === 'down') return <Tag color="red" icon={<ArrowDownOutlined />}>نزولی</Tag>;
  if (t === 'flat') return <Tag icon={<ArrowRightOutlined />}>ثابت</Tag>;
  return <>—</>;
}

/** امتیاز پشتیبان‌ها: کلی (میانگین ماه‌های کامل) و ماهانه، بر پایه‌ی رشد مبلغ، تعداد، دستگاه و پروژه‌ها */
export default function Scores(): JSX.Element {
  const { user } = useAuth();
  const ref = useRef2();
  const [months, setMonths] = useState(6);
  const [unitId, setUnitId] = useState<number | undefined>();
  const [picked, setPicked] = useState<number[] | null>(null);
  const [detail, setDetail] = useState<SupporterScoreDto | null>(null);
  const r = useApi(() => api.get<ScoreboardDto>('/analytics/supporter-scores', { months, unitId }), [months, unitId]);
  const d = r.data;

  const top = useMemo(() => (d ? d.supporters.filter((s) => s.overall !== null) : []), [d]);
  const chosen = picked ?? top.slice(0, 5).map((s) => s.supporterId);

  const rankChart = d && {
    grid: { left: 110, right: 40, top: 10, bottom: 20 }, tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'value', min: 0, max: 100 },
    yAxis: { type: 'category', inverse: true, data: top.map((s) => s.name) },
    series: [{ type: 'bar', label: { show: true, position: 'right' },
      data: top.map((s) => ({ value: s.overall, itemStyle: { color: BAND_COLOR[s.band ?? 'average'] } })) }],
  };
  const lineChart = d && {
    tooltip: { trigger: 'axis' }, legend: { top: 0 }, grid: { left: 40, right: 10, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: d.periods.map(periodLabel) }, yAxis: { type: 'value', min: 0, max: 100 },
    series: [
      ...d.supporters.filter((s) => chosen.includes(s.supporterId)).map((s) => ({
        name: s.name, type: 'line', smooth: true, connectNulls: true, data: s.months.map((m) => m.total),
      })),
      { name: 'میانگین دفتر', type: 'line', lineStyle: { type: 'dashed', color: '#999' }, itemStyle: { color: '#999' }, connectNulls: true, data: d.officeAverage },
    ],
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap>
          <span>بازه:</span>
          <Select style={{ width: 150 }} value={months} onChange={setMonths}
            options={[3, 6, 12].map((m) => ({ value: m, label: `${fmtNum(m)} ماه کامل اخیر` }))} />
          {user?.role !== 'supporter' && user?.role !== 'unit_head' && (
            <Select allowClear placeholder="همه‌ی ستادها" style={{ width: 180 }} value={unitId} onChange={setUnitId}
              options={ref.units.map((u) => ({ value: u.id, label: u.name }))} />
          )}
          {d && <Typography.Text type="secondary">ماه‌ها: {periodLabel(d.periods[0] as number)} تا {periodLabel(d.periods[d.periods.length - 1] as number)}</Typography.Text>}
        </Space>
      </Card>

      <Loading loading={r.loading} error={r.error}>
        {!d || d.supporters.length === 0 ? <NoData /> : (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {d.skippedPartialPeriod && (
              <Alert type="info" showIcon message={`${periodLabel(d.skippedPartialPeriod)} هنوز کامل نشده و در امتیازدهی لحاظ نشد.`} />
            )}
            <Row gutter={16}>
              <Col xs={24} md={8}><Card><Statistic title="میانگین امتیاز دفتر" value={sc(d.officeAverage[d.officeAverage.length - 1] ?? null)} suffix="/ ۱۰۰" /></Card></Col>
              <Col xs={24} md={8}><Card><Statistic title="بهترین پشتیبان" value={top[0]?.name ?? '—'} suffix={top[0] ? `(${sc(top[0].overall)})` : ''} /></Card></Col>
              <Col xs={24} md={8}><Card><Statistic title="نیازمند توجه" value={top[top.length - 1]?.name ?? '—'} suffix={top.length > 1 ? `(${sc(top[top.length - 1]?.overall ?? null)})` : ''} /></Card></Col>
            </Row>

            <Card title="روش امتیازدهی" size="small">
              <Typography.Paragraph style={{ marginBottom: 4 }}>
                امتیاز هر ماه (۰ تا ۱۰۰) میانگین وزنی چهار مؤلفه است و امتیاز کلی، میانگین ماه‌های کامل بازه.
                رشد ۰٪ برابر ۵۰ امتیاز، رشد +۲۵٪ یا بیشتر ۱۰۰ و افت −۲۵٪ یا بیشتر ۰ است. مؤلفه‌ای که داده ندارد (مثلاً ماه قبل صفر بوده یا پروژه‌ای نبوده)
                در امتیاز لحاظ نمی‌شود و وزنش بین بقیه پخش می‌شود. مبلغ همیشه «مبلغ خرید» است (مبلغ کل فقط نمایشی).
              </Typography.Paragraph>
              <Space wrap>{SCORE_COMPONENTS.map((k) => <Tag key={k} color="blue">{SCORE_COMPONENT_FA[k]}: {fmtNum(Math.round(d.weights[k] * 10) / 10)}</Tag>)}
                <Typography.Text type="secondary">(وزن‌ها در «مدیریت ← تنظیمات» قابل تغییر است)</Typography.Text></Space>
            </Card>

            <Row gutter={16}>
              <Col xs={24} lg={10}><Card title="رتبه‌بندی کلی"><EChart option={rankChart as Record<string, unknown>} height={Math.max(220, top.length * 28 + 30)} /></Card></Col>
              <Col xs={24} lg={14}>
                <Card title="روند امتیاز ماهانه" extra={
                  <Select mode="multiple" maxTagCount={2} style={{ minWidth: 220 }} value={chosen} onChange={setPicked} optionFilterProp="label"
                    options={d.supporters.map((s) => ({ value: s.supporterId, label: s.name }))} />}>
                  <EChart option={lineChart as Record<string, unknown>} height={300} />
                </Card>
              </Col>
            </Row>

            <Card title="جدول امتیاز پشتیبان‌ها">
              <Table size="small" rowKey="supporterId" pagination={{ pageSize: 15 }} dataSource={d.supporters}
                onRow={(s) => ({ onClick: () => setDetail(s), style: { cursor: 'pointer' } })} columns={[
                  { title: 'رتبه', dataIndex: 'rank', width: 60, render: (v: number | null) => (v === null ? '—' : fmtNum(v)) },
                  { title: 'پشتیبان', dataIndex: 'name' },
                  { title: 'ستاد', dataIndex: 'unitId', render: (v: number) => ref.unitName(v) },
                  { title: 'امتیاز کلی', dataIndex: 'overall', sorter: (a: SupporterScoreDto, b: SupporterScoreDto) => (a.overall ?? -1) - (b.overall ?? -1),
                    render: (v: number | null, s: SupporterScoreDto) => (v === null ? '—' : <Tag color={SCORE_BAND_FA[s.band ?? 'average'].color}>{sc(v)} — {SCORE_BAND_FA[s.band ?? 'average'].text}</Tag>) },
                  { title: 'روند', dataIndex: 'trend', render: (t: SupporterScoreDto['trend']) => <Trend t={t} /> },
                  ...SCORE_COMPONENTS.map((k) => ({ title: SCORE_COMPONENT_FA[k], key: k, render: (_: unknown, s: SupporterScoreDto) => sc(s.componentAverages[k]) })),
                ]} />
            </Card>
          </Space>
        )}
      </Loading>
      <DetailDrawer s={detail} onClose={() => setDetail(null)} />
    </Space>
  );
}

function DetailDrawer({ s, onClose }: { s: SupporterScoreDto | null; onClose: () => void }): JSX.Element {
  const ref = useRef2();
  const [period, setPeriod] = useState<number | undefined>();
  const last = s?.months[s.months.length - 1];
  const month = s?.months.find((m) => m.periodId === (period ?? last?.periodId));
  const comments = month ? buildScoreComments({
    score: {
      total: month.total, components: month.components, amountGrowthPct: month.growth.amount, countGrowthPct: month.growth.count,
      deviceGrowthPct: month.growth.devices, activeRatioPct: month.metrics.activeRatioPct,
    },
    projects: month.projects.map((p) => ({ name: p.name, total: p.total, resolved: p.resolved, expectedPct: p.expectedPct })),
  }) : [];
  const radar = s && {
    tooltip: {}, radar: { indicator: SCORE_COMPONENTS.map((k) => ({ name: SCORE_COMPONENT_FA[k], max: 100 })), radius: '65%' },
    series: [{ type: 'radar', areaStyle: { opacity: 0.2 }, data: [{ name: s.name, value: SCORE_COMPONENTS.map((k: ScoreComponent) => s.componentAverages[k] ?? 0) }] }],
  };
  const bars = s && {
    tooltip: { trigger: 'axis' }, legend: { top: 0 }, grid: { left: 60, right: 40, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: s.months.map((m) => periodLabel(m.periodId)) },
    yAxis: [{ type: 'value', axisLabel: { formatter: (v: number) => fmtMoney(v) } }, { type: 'value', min: 0, max: 100 }],
    series: [
      { name: 'مبلغ خرید', type: 'bar', data: s.months.map((m) => m.metrics.amount) },
      { name: 'امتیاز', type: 'line', yAxisIndex: 1, connectNulls: true, data: s.months.map((m) => m.total) },
    ],
  };
  return (
    <Drawer open={s !== null} onClose={onClose} width={760} destroyOnClose title={s ? `${s.name} — ${ref.unitName(s.unitId)}` : ''}>
      {s && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space wrap>
            <Statistic title="امتیاز کلی" value={sc(s.overall)} suffix={s.band ? `(${SCORE_BAND_FA[s.band].text})` : ''} />
            <Trend t={s.trend} />
          </Space>
          <Row gutter={16}>
            <Col span={10}><EChart option={radar as Record<string, unknown>} height={240} /></Col>
            <Col span={14}><EChart option={bars as Record<string, unknown>} height={240} /></Col>
          </Row>
          <Card size="small" title="توضیح امتیاز یک ماه" extra={
            <Select style={{ width: 150 }} value={month?.periodId} onChange={setPeriod} options={s.months.map((m) => ({ value: m.periodId, label: periodLabel(m.periodId) }))} />}>
            {month && (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Descriptions size="small" column={2} bordered>
                  <Descriptions.Item label="امتیاز ماه">{sc(month.total)}</Descriptions.Item>
                  <Descriptions.Item label="دستگاه فعال / قابل‌سنجش">{fmtNum(month.metrics.activeTerminals)} / {fmtNum(month.metrics.measurableTerminals)}</Descriptions.Item>
                  <Descriptions.Item label="مبلغ خرید">{fmtMoney(month.metrics.amount)}</Descriptions.Item>
                  <Descriptions.Item label="مبلغ کل">{fmtMoney(month.metrics.totalAmount)}</Descriptions.Item>
                </Descriptions>
                <ul style={{ margin: 0, paddingInlineStart: 20 }}>{comments.map((c) => <li key={c}>{c}</li>)}</ul>
                {month.projects.length > 0 && (
                  <Table size="small" rowKey="projectId" pagination={false} dataSource={month.projects} columns={[
                    { title: 'پروژه', dataIndex: 'name' },
                    { title: 'ترمینال', dataIndex: 'total', render: fmtNum },
                    { title: 'پیشرفت واقعی', dataIndex: 'actualPct', render: fmtPct },
                    { title: 'مورد انتظار', dataIndex: 'expectedPct', render: fmtPct },
                    { title: 'امتیاز', dataIndex: 'score', render: sc },
                  ]} />
                )}
              </Space>
            )}
          </Card>
          <Table size="small" rowKey="periodId" pagination={false} dataSource={[...s.months].reverse()} scroll={{ x: 'max-content' }} columns={[
            { title: 'ماه', dataIndex: 'periodId', render: periodLabel },
            { title: 'امتیاز', dataIndex: 'total', render: sc },
            { title: 'رشد مبلغ', render: (_: unknown, m: SupporterScoreDto['months'][number]) => (m.growth.amount === null ? '—' : fmtPct(m.growth.amount)) },
            { title: 'رشد تعداد', render: (_: unknown, m: SupporterScoreDto['months'][number]) => (m.growth.count === null ? '—' : fmtPct(m.growth.count)) },
            { title: 'رشد دستگاه', render: (_: unknown, m: SupporterScoreDto['months'][number]) => (m.growth.devices === null ? '—' : fmtPct(m.growth.devices)) },
            ...SCORE_COMPONENTS.map((k) => ({ title: SCORE_COMPONENT_FA[k], key: k, render: (_: unknown, m: SupporterScoreDto['months'][number]) => sc(m.components[k]) })),
          ]} />
        </Space>
      )}
    </Drawer>
  );
}
