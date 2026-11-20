import { PlusOutlined, SearchOutlined, SwapOutlined } from '@ant-design/icons';
import { Alert, Button, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import type { AuditDto, BulkResultDto, Page, TerminalDto, TerminalLookupDto, TerminalHistoryDto, TerminalMonthDto } from '@pos/shared';
import { ChangeLog } from '../components/ChangeLog';
import { Loading } from '../components/common';
import { EChart } from '../components/EChart';
import { JalaliDateField } from '../components/JalaliDateField';
import { useAuth } from '../auth';
import { ApiError, api } from '../lib/api';
import { fmtMoney, fmtNum, jalaliDateTime, jalaliText, periodLabel } from '../lib/format';
import { errMsg, useApi } from '../lib/hooks';
import { useRef2 } from '../refdata';

const CLASS_FA: Record<number, string> = { 0: 'نامشخص', 1: 'فعال', 2: 'کم‌تراکنش', 3: 'برگشتی', 4: 'نوپا' };

/** پیام خطای عملیات گروهی همراه فهرست اولین ترمینال‌های ناموفق */
function bulkError(e: unknown): string {
  if (e instanceof ApiError && e.code === 'BULK_FAILED') {
    const d = e.details as { failures?: Array<{ terminalId: number; message: string }> } | undefined;
    return `${e.message} — نمونه: ${(d?.failures ?? []).slice(0, 3).map((f) => `#${f.terminalId}: ${f.message}`).join('؛ ')}`;
  }
  return errMsg(e);
}

export default function Terminals(): JSX.Element {
  const { user, can } = useAuth();
  const ref = useRef2();
  const canManage = can('terminals.edit');
  const [lookupOpen, setLookupOpen] = useState(false);
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<{ unitId?: number; supporterId?: number; bankId?: number; status?: 'active' | 'returned' }>({});
  const [items, setItems] = useState<TerminalDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async (more: boolean, after: string | null) => {
    setLoading(true);
    try {
      const p = await api.get<Page<TerminalDto>>('/terminals', { ...filters, q: q || undefined, limit: 50, cursor: more ? after : undefined });
      setItems((prev) => (more ? [...prev, ...p.items] : p.items));
      setCursor(p.nextCursor);
      setErr(null);
    } catch (e) { setErr(errMsg(e)); } finally { setLoading(false); }
  }, [filters, q]);

  useEffect(() => {
    const t = setTimeout(() => { void load(false, null); }, 300); // debounce جستجو
    return () => clearTimeout(t);
  }, [load]);

  const refresh = (): void => { setSelected([]); void load(false, null); };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        <Input.Search placeholder="شماره ترمینال، فروشگاه، مالک، تلفن" allowClear style={{ width: 280 }} onSearch={setQ} />
        {user?.role === 'office_manager' || user?.role === 'data_admin' ? (
          <Select allowClear placeholder="ستاد" style={{ width: 140 }} onChange={(v) => setFilters((f) => ({ ...f, unitId: v }))} options={ref.units.map((u) => ({ value: u.id, label: u.name }))} />
        ) : null}
        {user?.role !== 'supporter' && (
          <Select allowClear showSearch optionFilterProp="label" placeholder="پشتیبان" style={{ width: 160 }} onChange={(v) => setFilters((f) => ({ ...f, supporterId: v }))} options={ref.supporters.map((s) => ({ value: s.id, label: s.fullName }))} />
        )}
        <Select allowClear placeholder="بانک" style={{ width: 130 }} onChange={(v) => setFilters((f) => ({ ...f, bankId: v }))} options={ref.banks.map((b) => ({ value: b.id, label: b.name }))} />
        <Select allowClear placeholder="وضعیت" style={{ width: 120 }} onChange={(v) => setFilters((f) => ({ ...f, status: v }))} options={[{ value: 'active', label: 'فعال' }, { value: 'returned', label: 'برگشتی' }]} />
        <Button icon={<SearchOutlined />} onClick={() => setLookupOpen(true)}>جستجوی گروهی</Button>
        {canManage && <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>ترمینال جدید</Button>}
        {canManage && <Button icon={<SwapOutlined />} disabled={selected.length === 0} onClick={() => setBulkOpen(true)}>تعویض گروهی ({fmtNum(selected.length)})</Button>}
      </Space>
      {err && <Alert type="error" showIcon message={err} />}
      <Table size="small" rowKey="id" loading={loading} dataSource={items} pagination={false}
        rowSelection={canManage ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as number[]) } : undefined}
        onRow={(r) => ({ onClick: () => setOpen(r.id), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'شماره ترمینال', dataIndex: 'terminalNo' }, { title: 'فروشگاه', dataIndex: 'shopName' }, { title: 'مالک', dataIndex: 'ownerName' },
          { title: 'پشتیبان', dataIndex: 'supporterId', render: (v: number) => ref.supporterName(v) },
          { title: 'بانک', dataIndex: 'bankId', render: (v: number | null) => ref.bankName(v) },
          { title: 'مسیر', dataIndex: 'routeGroupId', render: (v: number | null) => ref.routeName(v) },
          { title: 'وضعیت', dataIndex: 'status', render: (s: string) => (s === 'returned' ? <Tag color="red">برگشتی</Tag> : <Tag color="green">فعال</Tag>) },
        ]}
        footer={() => (cursor ? <Button onClick={() => { void load(true, cursor); }}>نمایش بیشتر</Button> : <span>{fmtNum(items.length)} مورد</span>)}
      />
      <LookupModal open={lookupOpen} canEdit={canManage} onClose={() => setLookupOpen(false)} onOpenTerminal={setOpen} onChanged={refresh} />
      <TerminalDrawer id={open} onClose={() => setOpen(null)} onChanged={refresh} />
      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); refresh(); }} />
      <BulkModal open={bulkOpen} ids={selected} onClose={() => setBulkOpen(false)} onDone={() => { setBulkOpen(false); refresh(); }} />
    </Space>
  );
}

function CreateModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }): JSX.Element {
  const ref = useRef2();
  const [form] = Form.useForm();
  const [installedAt, setInstalledAt] = useState<string | undefined>();
  return (
    <Modal title="ثبت ترمینال جدید" open={open} onCancel={onClose} okText="ثبت" cancelText="انصراف" destroyOnClose
      onOk={async () => {
        const v = await form.validateFields();
        try {
          await api.post('/terminals', { ...v, installedAt: installedAt ?? null });
          message.success('ثبت شد'); form.resetFields(); onDone();
        } catch (e) { message.error(errMsg(e)); }
      }}>
      <Form form={form} layout="vertical">
        <Form.Item name="terminalNo" label="شماره ترمینال" rules={[{ required: true }]}><Input style={{ direction: 'ltr' }} /></Form.Item>
        <Form.Item name="shopName" label="نام فروشگاه"><Input /></Form.Item>
        <Form.Item name="ownerName" label="مالک"><Input /></Form.Item>
        <Form.Item name="phone" label="تلفن"><Input style={{ direction: 'ltr' }} /></Form.Item>
        <Form.Item name="supporterId" label="پشتیبان" rules={[{ required: true }]}>
          <Select showSearch optionFilterProp="label" options={ref.supporters.filter((s) => s.isActive).map((s) => ({ value: s.id, label: s.fullName }))} />
        </Form.Item>
        <Form.Item name="bankId" label="بانک"><Select allowClear options={ref.banks.map((b) => ({ value: b.id, label: b.name }))} /></Form.Item>
        <Form.Item name="routeGroupId" label="مسیر"><Select allowClear options={ref.routes.map((r) => ({ value: r.id, label: r.name }))} /></Form.Item>
        <Form.Item label="تاریخ نصب"><JalaliDateField value={installedAt} onChange={setInstalledAt} /></Form.Item>
      </Form>
    </Modal>
  );
}

function BulkModal({ open, ids, onClose, onDone }: { open: boolean; ids: number[]; onClose: () => void; onDone: () => void }): JSX.Element {
  const ref = useRef2();
  const [supporterId, setSupporterId] = useState<number | undefined>();
  const [bankId, setBankId] = useState<number | undefined>();
  const [routeGroupId, setRouteGroupId] = useState<number | undefined>();
  const [date, setDate] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const none = supporterId === undefined && bankId === undefined && routeGroupId === undefined;
  return (
    <Modal title={`تعویض گروهی برای ${fmtNum(ids.length)} ترمینال`} open={open} onCancel={onClose} okText="اعمال" cancelText="انصراف"
      okButtonProps={{ disabled: none, loading: busy }} destroyOnClose
      onOk={async () => {
        setBusy(true);
        try {
          const r = await api.post<BulkResultDto>('/terminals/bulk/assign', {
            terminalIds: ids, ...(supporterId !== undefined ? { supporterId } : {}), ...(bankId !== undefined ? { bankId } : {}),
            ...(routeGroupId !== undefined ? { routeGroupId } : {}), ...(date ? { effectiveDate: date } : {}),
          });
          message.success(`${fmtNum(r.updated)} ترمینال تغییر کرد (${fmtNum(r.unchanged)} بدون تغییر)`);
          onDone();
        } catch (e) { message.error(bulkError(e), 8); } finally { setBusy(false); }
      }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="عملیات «همه یا هیچ» است؛ اگر برای یک ترمینال خطا باشد هیچ تغییری اعمال نمی‌شود. فیلد خالی = بدون تغییر." />
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select allowClear showSearch optionFilterProp="label" placeholder="پشتیبان جدید" style={{ width: '100%' }} value={supporterId} onChange={setSupporterId}
          options={ref.supporters.filter((s) => s.isActive).map((s) => ({ value: s.id, label: s.fullName }))} />
        <Select allowClear placeholder="بانک جدید" style={{ width: '100%' }} value={bankId} onChange={setBankId} options={ref.banks.map((b) => ({ value: b.id, label: b.name }))} />
        <Select allowClear placeholder="مسیر جدید" style={{ width: '100%' }} value={routeGroupId} onChange={setRouteGroupId} options={ref.routes.map((r) => ({ value: r.id, label: r.name }))} />
        <JalaliDateField value={date} onChange={setDate} placeholder="تاریخ اعمال (پیش‌فرض: امروز)" />
      </Space>
    </Modal>
  );
}

function TerminalDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }): JSX.Element {
  const { can } = useAuth();
  const ref = useRef2();
  const canManage = can('terminals.edit');
  const canAudit = can('terminals.audit');
  const t = useApi(() => (id ? api.get<TerminalDto>(`/terminals/${id}`) : Promise.resolve(null)), [id]);
  const hist = useApi(() => (id ? api.get<TerminalHistoryDto[]>(`/terminals/${id}/history`) : Promise.resolve([])), [id]);
  const monthly = useApi(() => (id ? api.get<TerminalMonthDto[]>(`/terminals/${id}/monthly`) : Promise.resolve([])), [id]);
  const audit = useApi(() => (id && canAudit ? api.get<Page<AuditDto>>(`/terminals/${id}/audit`, { limit: 50 }) : Promise.resolve(null)), [id]);
  const [retOpen, setRetOpen] = useState(false);
  const [asgOpen, setAsgOpen] = useState(false);
  const d = t.data;

  const reload = (): void => { t.reload(); hist.reload(); monthly.reload(); onChanged(); };

  const chart = {
    tooltip: { trigger: 'axis' }, grid: { left: 60, right: 10, top: 20, bottom: 30 },
    xAxis: { type: 'category', data: (monthly.data ?? []).map((m) => periodLabel(m.periodId)) },
    yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtMoney(v) } },
    series: [{ type: 'bar', data: (monthly.data ?? []).map((m) => ({ value: m.amount, itemStyle: m.isComplete ? undefined : { opacity: 0.45 } })) }],
  };

  return (
    <Drawer title={d ? `ترمینال ${d.terminalNo}` : '...'} open={id !== null} onClose={onClose} width={640} destroyOnClose
      extra={d && canManage && (
        <Space>
          <Button onClick={() => setAsgOpen(true)}>تعویض پشتیبان/مسیر/بانک</Button>
          {d.status === 'active' ? <Button danger onClick={() => setRetOpen(true)}>ثبت انصراف</Button> : (
            <Button onClick={() => {
              Modal.confirm({ title: 'لغو انصراف؟', content: 'ترمینال دوباره فعال می‌شود و آمار از ماه انصراف بازمحاسبه می‌گردد.', okText: 'لغو انصراف', cancelText: 'بستن',
                onOk: async () => { try { await api.post(`/terminals/${d.id}/reactivate`, {}); reload(); } catch (e) { message.error(errMsg(e)); } } });
            }}>لغو انصراف</Button>
          )}
        </Space>
      )}>
      <Loading loading={t.loading} error={t.error}>
        {d && (
          <Tabs items={[
            { key: 'i', label: 'مشخصات', children: (
              <Descriptions column={1} size="small" bordered>
                <Descriptions.Item label="فروشگاه">{d.shopName ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="مالک">{d.ownerName ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="تلفن">{d.phone ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="آدرس">{d.address ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="پشتیبان">{ref.supporterName(d.supporterId)} ({ref.unitName(d.unitId)})</Descriptions.Item>
                <Descriptions.Item label="بانک">{ref.bankName(d.bankId)}</Descriptions.Item>
                <Descriptions.Item label="مسیر">{ref.routeName(d.routeGroupId)}</Descriptions.Item>
                <Descriptions.Item label="تاریخ نصب">{jalaliText(d.installedAt)}</Descriptions.Item>
                <Descriptions.Item label="وضعیت">{d.status === 'returned' ? `برگشتی از ${jalaliText(d.returnedAt)}${d.returnReason ? ` — ${d.returnReason}` : ''}` : 'فعال'}</Descriptions.Item>
              </Descriptions>) },
            { key: 'm', label: 'ماهانه', children: (
              <>
                <EChart option={chart} height={240} />
                <Table size="small" rowKey="periodId" pagination={false} dataSource={[...(monthly.data ?? [])].reverse()} columns={[
                  { title: 'ماه', dataIndex: 'periodId', render: periodLabel },
                  { title: 'مبلغ خرید', dataIndex: 'amount', render: fmtMoney }, { title: 'مبلغ کل', dataIndex: 'totalAmount', render: fmtMoney },
                  { title: 'تراکنش', dataIndex: 'txCount', render: fmtNum }, { title: 'طبقه', dataIndex: 'activityClass', render: (c: number) => CLASS_FA[c] ?? c },
                  { title: 'کامل', dataIndex: 'isComplete', render: (v: boolean) => (v ? '✓' : 'ناقص') },
                ]} />
              </>) },
            { key: 'h', label: 'تاریخچه‌ی تخصیص', children: (
              <Table size="small" rowKey="id" pagination={false} dataSource={hist.data ?? []} columns={[
                { title: 'پشتیبان', dataIndex: 'supporterId', render: (v: number) => ref.supporterName(v) }, { title: 'ستاد', dataIndex: 'unitId', render: (v: number) => ref.unitName(v) },
                { title: 'مسیر', dataIndex: 'routeGroupId', render: (v: number) => ref.routeName(v || null) }, { title: 'بانک', dataIndex: 'bankId', render: (v: number) => ref.bankName(v || null) },
                { title: 'از', dataIndex: 'startDate', render: jalaliText }, { title: 'تا', dataIndex: 'endDate', render: (v: string | null) => (v ? jalaliText(v) : 'جاری') },
                { title: 'ثبت‌کننده', dataIndex: 'changedByName', render: (v: string | null) => v ?? 'سیستم' },
                { title: 'زمان ثبت', dataIndex: 'createdAt', render: jalaliDateTime },
              ]} />) },
            ...(canAudit ? [{ key: 'a', label: 'تاریخچه‌ی تغییرات', children: (
              <ChangeLog items={audit.data?.items ?? []} />) }] : []),
          ]} />
        )}
      </Loading>
      {d && <ReturnModal open={retOpen} terminal={d} onClose={() => setRetOpen(false)} onDone={() => { setRetOpen(false); reload(); }} />}
      {d && <AssignModal open={asgOpen} terminal={d} onClose={() => setAsgOpen(false)} onDone={() => { setAsgOpen(false); reload(); }} />}
    </Drawer>
  );
}

function ReturnModal({ open, terminal, onClose, onDone }: { open: boolean; terminal: TerminalDto; onClose: () => void; onDone: () => void }): JSX.Element {
  const [date, setDate] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  return (
    <Modal title={`ثبت انصراف ترمینال ${terminal.terminalNo}`} open={open} onCancel={onClose} okText="ثبت انصراف" okButtonProps={{ danger: true }} cancelText="انصراف" destroyOnClose
      onOk={async () => {
        try { await api.post(`/terminals/${terminal.id}/return`, { ...(date ? { returnedAt: date } : {}), reason: reason || null }); message.success('انصراف ثبت شد'); onDone(); } catch (e) { message.error(errMsg(e)); }
      }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message="ترمینال از ماه انصراف «برگشتی» حساب می‌شود و بعد از آن در آمار نمی‌آید." />
        <JalaliDateField value={date} onChange={setDate} placeholder="تاریخ انصراف (پیش‌فرض: امروز)" />
        <Input.TextArea rows={2} placeholder="دلیل (اختیاری)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Space>
    </Modal>
  );
}

function AssignModal({ open, terminal, onClose, onDone }: { open: boolean; terminal: TerminalDto; onClose: () => void; onDone: () => void }): JSX.Element {
  const ref = useRef2();
  const [supporterId, setSupporterId] = useState<number | undefined>();
  const [bankId, setBankId] = useState<number | null | undefined>();
  const [routeGroupId, setRouteGroupId] = useState<number | null | undefined>();
  const [date, setDate] = useState<string | undefined>();
  const none = supporterId === undefined && bankId === undefined && routeGroupId === undefined;
  return (
    <Modal title={`تعویض برای ترمینال ${terminal.terminalNo}`} open={open} onCancel={onClose} okText="اعمال" cancelText="انصراف" okButtonProps={{ disabled: none }} destroyOnClose
      onOk={async () => {
        try {
          await api.post(`/terminals/${terminal.id}/assignments`, {
            ...(supporterId !== undefined ? { supporterId } : {}), ...(bankId !== undefined ? { bankId } : {}),
            ...(routeGroupId !== undefined ? { routeGroupId } : {}), ...(date ? { effectiveDate: date } : {}),
          });
          message.success('تغییر اعمال شد'); onDone();
        } catch (e) { message.error(errMsg(e)); }
      }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select allowClear showSearch optionFilterProp="label" placeholder="پشتیبان جدید" style={{ width: '100%' }} value={supporterId} onChange={setSupporterId}
          options={ref.supporters.filter((s) => s.isActive).map((s) => ({ value: s.id, label: s.fullName }))} />
        <Select allowClear placeholder="بانک جدید" style={{ width: '100%' }} value={bankId ?? undefined} onChange={(v) => setBankId(v ?? null)} options={ref.banks.map((b) => ({ value: b.id, label: b.name }))} />
        <Select allowClear placeholder="مسیر جدید" style={{ width: '100%' }} value={routeGroupId ?? undefined} onChange={(v) => setRouteGroupId(v ?? null)} options={ref.routes.map((r) => ({ value: r.id, label: r.name }))} />
        <JalaliDateField value={date} onChange={setDate} placeholder="تاریخ اعمال (پیش‌فرض: امروز)" />
      </Space>
    </Modal>
  );
}


/** شماره‌ها را از هر جداکننده‌ای (خط جدید، فاصله، Tab، کاما، ؛) جدا می‌کند و تکراری‌ها را حذف می‌کند. */
export function parseTerminalNos(text: string): string[] {
  return [...new Set(text.split(/[\s,;،؛]+/).map((x) => x.trim()).filter(Boolean))];
}

/**
 * جستجوی هم‌زمان چند شماره ترمینال (چسباندن از اکسل): پیداشده‌ها در جدول، ناموجودها جدا؛
 * روی پیداشده‌ها می‌توان ویرایش گروهی (پشتیبان/مسیر/بانک) انجام داد یا یک ترمینال را باز کرد.
 */
function LookupModal({ open, canEdit, onClose, onOpenTerminal, onChanged }: {
  open: boolean; canEdit: boolean; onClose: () => void; onOpenTerminal: (id: number) => void; onChanged: () => void;
}): JSX.Element {
  const ref = useRef2();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TerminalLookupDto | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const nos = parseTerminalNos(text);

  const search = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<TerminalLookupDto>('/terminals/lookup', { terminalNos: nos });
      setRes(r);
      setSelected(r.items.map((t) => t.id));
    } catch (e) { message.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} title="جستجوی گروهی ترمینال" width={920} onCancel={onClose} footer={null} destroyOnClose>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Input.TextArea rows={5} value={text} onChange={(e) => { setText(e.target.value); setRes(null); }}
          placeholder="شماره‌ی ترمینال‌ها را بچسبانید (هر خط یکی، یا با فاصله/کاما جدا شده). حداکثر ۵۰۰۰ شماره." style={{ direction: 'ltr' }} />
        <Space>
          <Button type="primary" icon={<SearchOutlined />} loading={busy} disabled={nos.length === 0} onClick={() => { void search(); }}>
            جستجو ({fmtNum(nos.length)} شماره)
          </Button>
          {res && canEdit && (
            <Button icon={<SwapOutlined />} disabled={selected.length === 0} onClick={() => setBulkOpen(true)}>
              تعویض گروهی پشتیبان/مسیر/بانک ({fmtNum(selected.length)})
            </Button>
          )}
        </Space>
        {res && (
          <>
            <Alert type={res.notFound.length ? 'warning' : 'success'} showIcon
              message={`${fmtNum(res.items.length)} از ${fmtNum(res.requested)} ترمینال پیدا شد`}
              description={res.notFound.length > 0 ? (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <span>{fmtNum(res.notFound.length)} شماره در سامانه (یا در دامنه‌ی دسترسی شما) نیست:</span>
                  <Input.TextArea readOnly rows={2} value={res.notFound.join('\n')} style={{ direction: 'ltr' }} />
                  <Button size="small" onClick={() => { void navigator.clipboard?.writeText(res.notFound.join('\n')); message.success('کپی شد'); }}>کپی شماره‌های ناموجود</Button>
                </Space>
              ) : undefined} />
            <Table size="small" rowKey="id" dataSource={res.items} pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }}
              rowSelection={canEdit ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as number[]) } : undefined}
              onRow={(r) => ({ onClick: () => onOpenTerminal(r.id), style: { cursor: 'pointer' } })}
              columns={[
                { title: 'شماره ترمینال', dataIndex: 'terminalNo' }, { title: 'فروشگاه', dataIndex: 'shopName' },
                { title: 'پشتیبان', dataIndex: 'supporterId', render: (v: number) => ref.supporterName(v) },
                { title: 'بانک', dataIndex: 'bankId', render: (v: number | null) => ref.bankName(v) },
                { title: 'مسیر', dataIndex: 'routeGroupId', render: (v: number | null) => ref.routeName(v) },
                { title: 'وضعیت', dataIndex: 'status', render: (st: string) => (st === 'returned' ? <Tag color="red">برگشتی</Tag> : <Tag color="green">فعال</Tag>) },
              ]} />
          </>
        )}
      </Space>
      <BulkModal open={bulkOpen} ids={selected} onClose={() => setBulkOpen(false)}
        onDone={() => { setBulkOpen(false); onChanged(); void search(); }} />
    </Modal>
  );
}
