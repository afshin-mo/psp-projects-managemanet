import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Col, Descriptions, Input, Modal, Row, Select, Space, Table, Tag, Upload, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  PROJECT_TERMINAL_STATUS_FA, PROJECT_TERMINAL_STATUSES, type BulkResultDto, type Page, type ProjectImportResultDto,
  type ProjectProgressDto, type ProjectTerminalDto, type ProjectTerminalStatus,
} from '@pos/shared';
import { LagTag, Loading, StatusTag } from '../components/common';
import { EChart } from '../components/EChart';
import { PickTerminalsModal } from '../components/PickTerminals';
import { useAuth } from '../auth';
import { ApiError, api } from '../lib/api';
import { fmtNum, fmtPct, jalaliText } from '../lib/format';
import { errMsg, useApi } from '../lib/hooks';
import { useRef2 } from '../refdata';

export default function ProjectDetail(): JSX.Element {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const { can } = useAuth();
  const isManager = can('projects.manage');
  const ref = useRef2();
  const prog = useApi(() => api.get<ProjectProgressDto>(`/projects/${pid}/progress`), [pid]);

  const [status, setStatus] = useState<ProjectTerminalStatus | undefined>();
  const [supporterId, setSupporterId] = useState<number | undefined>();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ProjectTerminalDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [newStatus, setNewStatus] = useState<ProjectTerminalStatus>('done');
  const [note, setNote] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [addText, setAddText] = useState('');
  const [importRes, setImportRes] = useState<ProjectImportResultDto | null>(null);

  const load = useCallback(async (more: boolean, after: string | null) => {
    setLoading(true);
    try {
      const p = await api.get<Page<ProjectTerminalDto>>(`/projects/${pid}/terminals`, { status, supporterId, q: q || undefined, limit: 100, cursor: more ? after : undefined });
      setItems((prev) => (more ? [...prev, ...p.items] : p.items)); setCursor(p.nextCursor);
    } catch (e) { message.error(errMsg(e)); } finally { setLoading(false); }
  }, [pid, status, supporterId, q]);
  useEffect(() => { void load(false, null); }, [load]);

  const refresh = (): void => { setSelected([]); prog.reload(); void load(false, null); };
  const p = prog.data?.project;
  const active = p?.status === 'active';

  const applyStatus = async (): Promise<void> => {
    try {
      const r = await api.post<BulkResultDto>(`/projects/${pid}/terminals/status`, { terminalIds: selected, status: newStatus, note: note || undefined });
      message.success(`${fmtNum(r.updated)} ترمینال به‌روز شد`); setNote(''); refresh();
    } catch (e) { message.error(errMsg(e), 6); }
  };

  const doImport = async (file: File): Promise<void> => {
    try {
      const r = await api.upload<ProjectImportResultDto>(`/projects/${pid}/terminals/import`, { type: 'project_terminals' }, file);
      setImportRes(r); refresh();
    } catch (e) {
      if (e instanceof ApiError) message.error(e.message, 6); else message.error(errMsg(e));
    }
  };

  const funnel = prog.data && {
    tooltip: { trigger: 'item' }, series: [{ type: 'funnel', left: '10%', width: '80%', sort: 'none', label: { formatter: '{b}: {c}' },
      data: prog.data.funnel.map((f) => ({ name: { total: 'کل ترمینال‌ها', started: 'شروع‌شده', done: 'انجام‌شده' }[f.key], value: f.count })) }],
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Loading loading={prog.loading} error={prog.error}>
        {p && (
          <Card title={p.name} extra={<Space><Button onClick={() => nav('/projects')}>بازگشت</Button>
            {isManager && p.status === 'active' && <Button onClick={() => { Modal.confirm({ title: 'بستن پروژه؟', content: 'بعد از بستن، وضعیت ترمینال‌ها قابل تغییر نیست.', okText: 'بستن', cancelText: 'انصراف',
              onOk: async () => { try { await api.patch(`/projects/${pid}`, { status: 'closed' }); prog.reload(); } catch (e) { message.error(errMsg(e)); } } }); }}>بستن پروژه</Button>}</Space>}>
            <Descriptions size="small" column={{ xs: 1, md: 3 }}>
              <Descriptions.Item label="بازه">{jalaliText(p.startDate)} تا {jalaliText(p.dueDate)}</Descriptions.Item>
              <Descriptions.Item label="وضعیت">{p.status === 'active' ? <LagTag level={p.lag.level} /> : <Tag>{p.status === 'closed' ? 'بسته' : 'لغو شده'}</Tag>}</Descriptions.Item>
              <Descriptions.Item label="پیشرفت">{fmtPct(p.lag.actualPct)} از مورد انتظار {fmtPct(p.lag.expectedPct)}</Descriptions.Item>
              <Descriptions.Item label="ترمینال‌ها">{fmtNum(p.total)} (انجام: {fmtNum(p.done)}، در حال انجام: {fmtNum(p.inProgress)}، ناموفق: {fmtNum(p.failed)})</Descriptions.Item>
              {p.description && <Descriptions.Item label="توضیح" span={3}>{p.description}</Descriptions.Item>}
            </Descriptions>
          </Card>
        )}
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={8}><Card title="قیف پیشرفت">{funnel && <EChart option={funnel} height={240} />}</Card></Col>
          <Col xs={24} lg={16}><Card title="پیشرفت به تفکیک پشتیبان">
            <Table size="small" rowKey="supporterId" pagination={{ pageSize: 8 }} dataSource={prog.data?.bySupporter ?? []} columns={[
              { title: 'پشتیبان', dataIndex: 'name' }, { title: 'کل', dataIndex: 'total', render: fmtNum },
              { title: 'انجام', dataIndex: 'done', render: fmtNum }, { title: 'در حال انجام', dataIndex: 'inProgress', render: fmtNum },
              { title: 'شروع‌نشده', dataIndex: 'notStarted', render: fmtNum }, { title: 'ناموفق', dataIndex: 'failed', render: fmtNum },
              { title: 'پیشرفت', render: (_: unknown, r: ProjectProgressDto['bySupporter'][number]) => fmtPct(r.lag.actualPct) },
              { title: 'وضعیت', render: (_: unknown, r: ProjectProgressDto['bySupporter'][number]) => (active ? <LagTag level={r.lag.level} /> : '—') },
            ]} />
          </Card></Col>
        </Row>
      </Loading>

      <Card title="ترمینال‌های پروژه" extra={<Space>
        {isManager && active && <Button type="primary" onClick={() => setPickOpen(true)}>افزودن از فهرست ترمینال‌ها</Button>}
        {isManager && active && <Button onClick={() => setAddOpen(true)}>افزودن با شماره</Button>}
        {isManager && active && <Upload accept=".xlsx,.csv" showUploadList={false} beforeUpload={(f) => { void doImport(f); return false; }}><Button icon={<UploadOutlined />}>ایمپورت اکسل</Button></Upload>}
        <Button icon={<DownloadOutlined />} onClick={() => { void api.download(`/projects/${pid}/export`, undefined, `project-${pid}.xlsx`); }}>خروجی اکسل</Button>
      </Space>}>
        {importRes && (
          <Alert closable onClose={() => setImportRes(null)} style={{ marginBottom: 12 }} type={importRes.unknownCount + importRes.invalidCount > 0 ? 'warning' : 'success'} showIcon
            message={`افزوده: ${fmtNum(importRes.added)} — قبلاً در پروژه: ${fmtNum(importRes.alreadyInProject)} — تغییر وضعیت: ${fmtNum(importRes.statusUpdated)}`}
            description={<>
              {importRes.unknownCount > 0 && <div>ترمینال ناشناخته ({fmtNum(importRes.unknownCount)}): {importRes.unknown.slice(0, 20).join('، ')}</div>}
              {importRes.invalidCount > 0 && <div>ردیف نامعتبر ({fmtNum(importRes.invalidCount)}): {importRes.invalid.slice(0, 5).map((x) => `ردیف ${x.rowNo}: ${x.message}`).join('؛ ')}</div>}
              <div style={{ opacity: 0.7 }}>ستون‌های فایل: «شماره ترمینال» (الزامی)، «وضعیت» و «توضیح» (اختیاری)</div></>} />
        )}
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search allowClear placeholder="جستجوی ترمینال" style={{ width: 220 }} onSearch={setQ} />
          <Select allowClear placeholder="وضعیت" style={{ width: 140 }} value={status} onChange={setStatus} options={PROJECT_TERMINAL_STATUSES.map((s) => ({ value: s, label: PROJECT_TERMINAL_STATUS_FA[s] }))} />
          <Select allowClear showSearch optionFilterProp="label" placeholder="پشتیبان" style={{ width: 160 }} value={supporterId} onChange={setSupporterId} options={ref.supporters.map((s) => ({ value: s.id, label: s.fullName }))} />
        </Space>
        {active && selected.length > 0 && (
          <Space wrap style={{ marginBottom: 12 }}>
            <Tag color="blue">{fmtNum(selected.length)} انتخاب شده</Tag>
            <Select style={{ width: 150 }} value={newStatus} onChange={setNewStatus} options={PROJECT_TERMINAL_STATUSES.map((s) => ({ value: s, label: PROJECT_TERMINAL_STATUS_FA[s] }))} />
            <Input placeholder="توضیح (اختیاری)" style={{ width: 200 }} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            <Button type="primary" onClick={() => { void applyStatus(); }}>اعمال وضعیت</Button>
          </Space>
        )}
        <Table size="small" rowKey="terminalId" loading={loading} dataSource={items} pagination={false}
          rowSelection={active ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as number[]) } : undefined}
          columns={[
            { title: 'شماره ترمینال', dataIndex: 'terminalNo' }, { title: 'فروشگاه', dataIndex: 'shopName' },
            { title: 'پشتیبان', dataIndex: 'supporterId', render: (v: number) => ref.supporterName(v) },
            { title: 'وضعیت', dataIndex: 'status', render: (s: ProjectTerminalStatus) => <StatusTag status={s} /> },
            { title: 'توضیح', dataIndex: 'note' }, { title: 'آخرین تغییر', dataIndex: 'statusChangedAt', render: (v: string | null) => (v ? jalaliText(v) : '—') },
          ]}
          footer={() => (cursor ? <Button onClick={() => { void load(true, cursor); }}>نمایش بیشتر</Button> : <span>{fmtNum(items.length)} مورد</span>)} />
      </Card>

      <PickTerminalsModal open={pickOpen} projectId={pid} onClose={() => setPickOpen(false)} onDone={(r) => { setPickOpen(false); setImportRes(r); refresh(); }} />

      <Modal title="افزودن ترمینال با شماره" open={addOpen} onCancel={() => setAddOpen(false)} okText="افزودن" cancelText="انصراف" destroyOnClose
        onOk={async () => {
          const nos = addText.split(/[\s,؛;]+/).map((x) => x.trim()).filter(Boolean);
          if (nos.length === 0) return;
          try { setImportRes(await api.post<ProjectImportResultDto>(`/projects/${pid}/terminals`, { terminalNos: nos.slice(0, 5000) })); setAddOpen(false); setAddText(''); refresh(); } catch (e) { message.error(errMsg(e)); }
        }}>
        <Input.TextArea rows={8} placeholder="هر شماره در یک خط (یا با ویرگول جدا شود)؛ حداکثر ۵۰۰۰ مورد" value={addText} onChange={(e) => setAddText(e.target.value)} style={{ direction: 'ltr' }} />
      </Modal>
    </Space>
  );
}
