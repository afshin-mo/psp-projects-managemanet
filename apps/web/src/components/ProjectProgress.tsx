import { Card, Col, Row, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { ProjectDto, ProjectProgressDto, ProjectTrendDto } from '@pos/shared';
import { api } from '../lib/api';
import { fmtNum, fmtPct, jalaliText } from '../lib/format';
import { useApi } from '../lib/hooks';
import { COLORS } from '../theme';
import { LagTag, Loading, NoData } from './common';
import { EChart } from './EChart';

/**
 * پیشرفت پروژه‌ها در داشبورد: انتخاب پروژه، روند پیشرفت هر پشتیبان در گذر زمان (در برابر خط برنامه)
 * و وضعیت فعلی ترمینال‌ها به تفکیک پشتیبان. داده‌ها فقط در دامنه‌ی نقش کاربر هستند.
 */
export function ProjectProgress(): JSX.Element {
  const projects = useApi(() => api.get<ProjectDto[]>('/projects'), []);
  const [id, setId] = useState<number | undefined>();
  useEffect(() => { if (id === undefined && projects.data?.[0]) setId(projects.data[0].id); }, [projects.data, id]);

  const trend = useApi(() => (id ? api.get<ProjectTrendDto>(`/projects/${id}/trend`) : Promise.resolve(null)), [id]);
  const prog = useApi(() => (id ? api.get<ProjectProgressDto>(`/projects/${id}/progress`) : Promise.resolve(null)), [id]);
  const p = prog.data?.project;

  const lineOpt = useMemo(() => {
    const t = trend.data;
    if (!t) return {};
    // اگر پشتیبان‌ها زیاد باشند، فقط ۶ مورد عقب‌تر پیش‌فرض نمایش داده می‌شود (بقیه با legend قابل روشن شدن است)
    const worst = new Set([...t.supporters].sort((a, b) => (a.values[a.values.length - 1] ?? 0) - (b.values[b.values.length - 1] ?? 0)).slice(0, 6).map((s) => s.name));
    const selected = Object.fromEntries(t.supporters.map((s) => [s.name, t.supporters.length <= 8 || worst.has(s.name)]));
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${fmtNum(v)}٪` },
      legend: { type: 'scroll', top: 0, selected: { ...selected, 'برنامه': true } },
      grid: { left: 48, right: 20, top: 48, bottom: 30 },
      xAxis: { type: 'category', data: t.dates.map(jalaliText) },
      yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}٪' }, splitLine: { lineStyle: { color: '#ece6d6' } } },
      series: [
        { name: 'برنامه', type: 'line', symbol: 'none', data: t.expectedPct, lineStyle: { type: 'dashed', width: 2.5, color: COLORS.ink }, itemStyle: { color: COLORS.ink }, z: 1 },
        ...t.supporters.map((s) => ({ name: s.name, type: 'line', smooth: true, symbolSize: 5, data: s.values })),
      ],
    };
  }, [trend.data]);

  const barOpt = useMemo(() => {
    const rows = [...(prog.data?.bySupporter ?? [])].sort((a, b) => a.lag.actualPct - b.lag.actualPct);
    const mk = (name: string, key: 'done' | 'failed' | 'inProgress' | 'notStarted', color: string) => ({
      name, type: 'bar', stack: 'st', itemStyle: { color }, barMaxWidth: 20, data: rows.map((r) => r[key]),
    });
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } }, legend: { top: 0 },
      grid: { left: 110, right: 20, top: 34, bottom: 10 },
      xAxis: { type: 'value' }, yAxis: { type: 'category', data: rows.map((r) => r.name) },
      series: [mk('انجام‌شده', 'done', COLORS.teal), mk('در حال انجام', 'inProgress', COLORS.saffron), mk('ناموفق', 'failed', COLORS.brick), mk('شروع‌نشده', 'notStarted', '#d8d0bd')],
    };
  }, [prog.data]);

  return (
    <Card title="پیشرفت پروژه‌ها" extra={(
      <Select showSearch optionFilterProp="label" style={{ width: 300 }} placeholder="انتخاب پروژه" loading={projects.loading} value={id} onChange={setId}
        options={(projects.data ?? []).map((x) => ({ value: x.id, label: `${x.name}${x.status === 'active' ? '' : x.status === 'closed' ? ' (بسته)' : ' (لغو)'}` }))} />
    )}>
      {projects.data && projects.data.length === 0 ? <NoData /> : (
        <Space direction="vertical" style={{ width: '100%' }} size={14}>
          {p && (
            <Space wrap>
              {p.status === 'active' ? <LagTag level={p.lag.level} /> : <Tag>{p.status === 'closed' ? 'بسته' : 'لغو شده'}</Tag>}
              <Typography.Text>پیشرفت کل <b>{fmtPct(p.lag.actualPct)}</b> از مورد انتظار <b>{fmtPct(p.lag.expectedPct)}</b></Typography.Text>
              <Typography.Text type="secondary">{fmtNum(p.total)} ترمینال · {jalaliText(p.startDate)} تا {jalaliText(p.dueDate)}</Typography.Text>
            </Space>
          )}
          <Row gutter={[16, 16]}>
            <Col xs={24} xl={14}>
              <Typography.Text strong>روند پیشرفت پشتیبان‌ها (درصد ترمینال‌های بسته‌شده)</Typography.Text>
              <Loading loading={trend.loading} error={trend.error}>
                {trend.data && trend.data.supporters.length > 0 ? <EChart option={lineOpt} height={340} /> : <NoData />}
              </Loading>
            </Col>
            <Col xs={24} xl={10}>
              <Typography.Text strong>وضعیت فعلی به تفکیک پشتیبان</Typography.Text>
              <Loading loading={prog.loading} error={prog.error}>
                {(prog.data?.bySupporter.length ?? 0) > 0 ? <EChart option={barOpt} height={Math.max(340, (prog.data?.bySupporter.length ?? 0) * 30 + 60)} /> : <NoData />}
              </Loading>
            </Col>
          </Row>
        </Space>
      )}
    </Card>
  );
}
