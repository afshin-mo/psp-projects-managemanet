import { PlusOutlined } from '@ant-design/icons';
import { Button, Form, Input, Modal, Progress, Space, Table, Tabs, Tag, message } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectAlertDto, ProjectDto, ProjectMatrixDto } from '@pos/shared';
import { LAG_FA, LagTag, Loading, NoData } from '../components/common';
import { JalaliDateField } from '../components/JalaliDateField';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { fmtNum, fmtPct, jalaliText } from '../lib/format';
import { errMsg, useApi } from '../lib/hooks';
import { useRef2 } from '../refdata';

const STATUS_FA = { active: 'فعال', closed: 'بسته', cancelled: 'لغو شده' } as const;

export default function Projects(): JSX.Element {
  const { can } = useAuth();
  const isManager = can('projects.manage');
  const nav = useNavigate();
  const list = useApi(() => api.get<ProjectDto[]>('/projects'), []);
  const matrix = useApi(() => api.get<ProjectMatrixDto>('/projects/matrix'), []);
  const alerts = useApi(() => api.get<ProjectAlertDto[]>('/projects/alerts'), []);
  const [open, setOpen] = useState(false);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Tabs tabBarExtraContent={isManager && <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>پروژه‌ی جدید</Button>} items={[
        { key: 'list', label: 'پروژه‌ها', children: (
          <Loading loading={list.loading} error={list.error}>
            <Table size="small" rowKey="id" dataSource={list.data ?? []} pagination={{ pageSize: 15 }} onRow={(r) => ({ onClick: () => nav(`/projects/${r.id}`), style: { cursor: 'pointer' } })} columns={[
              { title: 'نام پروژه', dataIndex: 'name', render: (v: string, r: ProjectDto) => <>{v}{r.autoKind && <Tag color="geekblue" style={{ marginInlineStart: 6 }}>خودکار</Tag>}</> },
              { title: 'بازه', render: (_: unknown, r: ProjectDto) => `${jalaliText(r.startDate)} تا ${jalaliText(r.dueDate)}` },
              { title: 'ترمینال', dataIndex: 'total', render: fmtNum },
              { title: 'پیشرفت', render: (_: unknown, r: ProjectDto) => <Progress percent={Math.round(r.lag.actualPct)} size="small" status={r.lag.level === 'overdue' || r.lag.level === 'behind' ? 'exception' : 'normal'} /> },
              { title: 'وضعیت زمان‌بندی', render: (_: unknown, r: ProjectDto) => (r.status === 'active' ? <LagTag level={r.lag.level} /> : <Tag>{STATUS_FA[r.status]}</Tag>) },
            ]} />
          </Loading>) },
        { key: 'alerts', label: `هشدار عقب‌افتادگی (${fmtNum(alerts.data?.length ?? 0)})`, children: (
          <Loading loading={alerts.loading} error={alerts.error}>
            <Table size="small" rowKey={(r) => `${r.projectId}:${r.supporterId}`} dataSource={alerts.data ?? []} pagination={{ pageSize: 15 }} columns={[
              { title: 'پروژه', dataIndex: 'projectName', render: (v: string, r: ProjectAlertDto) => <a onClick={() => nav(`/projects/${r.projectId}`)}>{v}</a> },
              { title: 'پشتیبان', dataIndex: 'supporterName' },
              { title: 'باقی‌مانده', dataIndex: 'remaining', render: (v: number, r: ProjectAlertDto) => `${fmtNum(v)} از ${fmtNum(r.total)}` },
              { title: 'پیشرفت واقعی', dataIndex: 'actualPct', render: fmtPct }, { title: 'مورد انتظار', dataIndex: 'expectedPct', render: fmtPct },
              { title: 'روز تا سررسید', dataIndex: 'daysLeft', render: (v: number) => (v < 0 ? <Tag color="red">{fmtNum(-v)} روز تأخیر</Tag> : fmtNum(v)) },
              { title: 'وضعیت', dataIndex: 'level', render: (l: ProjectAlertDto['level']) => <LagTag level={l} /> },
            ]} />
          </Loading>) },
        { key: 'matrix', label: 'ماتریس پروژه × پشتیبان', children: <MatrixView m={matrix.data} loading={matrix.loading} error={matrix.error} /> },
      ]} />
      <CreateProject open={open} onClose={() => setOpen(false)} onDone={(id) => { setOpen(false); nav(`/projects/${id}`); }} />
    </Space>
  );
}

function MatrixView({ m, loading, error }: { m: ProjectMatrixDto | null; loading: boolean; error: string | null }): JSX.Element {
  const nav = useNavigate();
  const ref = useRef2();
  return (
    <Loading loading={loading} error={error}>
      {!m || m.projects.length === 0 || m.rows.length === 0 ? <NoData /> : (
        <Table size="small" rowKey="supporterId" pagination={false} scroll={{ x: 'max-content' }} dataSource={m.rows} columns={[
          { title: 'پشتیبان', dataIndex: 'name', fixed: 'right' as const, render: (v: string, r: ProjectMatrixDto['rows'][number]) => `${v} (${ref.unitName(r.unitId)})` },
          ...m.projects.map((p, i) => ({
            title: <a onClick={() => nav(`/projects/${p.id}`)}>{p.name}</a>, key: p.id,
            render: (_: unknown, r: ProjectMatrixDto['rows'][number]) => {
              const c = r.cells[i];
              return c ? <Tag color={LAG_FA[c.level].color}>{fmtNum(c.done + c.failed)}/{fmtNum(c.total)} — {fmtPct(c.pct)}</Tag> : '—';
            },
          })),
        ]} />
      )}
    </Loading>
  );
}

function CreateProject({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: number) => void }): JSX.Element {
  const [form] = Form.useForm<{ name: string; description?: string }>();
  const [start, setStart] = useState<string | undefined>();
  const [due, setDue] = useState<string | undefined>();
  return (
    <Modal title="پروژه‌ی جدید" open={open} onCancel={onClose} okText="ایجاد" cancelText="انصراف" destroyOnClose
      onOk={async () => {
        const v = await form.validateFields();
        if (!start || !due) { message.error('تاریخ شروع و سررسید را وارد کنید'); return; }
        try { const p = await api.post<ProjectDto>('/projects', { ...v, description: v.description || null, startDate: start, dueDate: due }); onDone(p.id); } catch (e) { message.error(errMsg(e)); }
      }}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label="نام پروژه" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="description" label="توضیح"><Input.TextArea rows={2} /></Form.Item>
        <Form.Item label="تاریخ شروع" required><JalaliDateField value={start} onChange={setStart} /></Form.Item>
        <Form.Item label="تاریخ سررسید" required><JalaliDateField value={due} onChange={setDue} /></Form.Item>
      </Form>
    </Modal>
  );
}
