import { Alert, Button, Card, Checkbox, Input, Modal, Select, Space, Table, Tabs, Tag, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AssignPendingResultDto, Page, PendingSummaryDto, PendingTerminalDto } from '@pos/shared';
import { api } from '../lib/api';
import { fmtMoney, fmtNum, jalaliText } from '../lib/format';
import { errMsg, useApi } from '../lib/hooks';
import { useRef2 } from '../refdata';

/**
 * ترمینال‌هایی که در فایل تراکنش هستند ولی در دیتابیس تعریف نشده‌اند.
 * کاربر همین‌جا پشتیبان (و در صورت نیاز مسیر/بانک) تعیین می‌کند؛ ترمینال با اطلاعات فایل ساخته می‌شود و
 * تراکنش‌های نگه‌داشته‌شده‌اش وارد آمار می‌شود.
 */
export default function Pending(): JSX.Element {
  const nav = useNavigate();
  const ref = useRef2();
  const summary = useApi(() => api.get<PendingSummaryDto>('/pending-terminals/summary'), []);
  const [status, setStatus] = useState<'pending' | 'dismissed'>('pending');
  const [activeOnly, setActiveOnly] = useState(true);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PendingTerminalDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async (more: boolean, cur: string | null) => {
    setLoading(true);
    try {
      const page = await api.get<Page<PendingTerminalDto>>('/pending-terminals', {
        status, activeOnly, q: q.trim() || undefined, limit: 100, ...(more && cur ? { cursor: cur } : {}),
      });
      setItems((old) => (more ? [...old, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) { message.error(errMsg(e)); } finally { setLoading(false); }
  }, [status, activeOnly, q]);

  useEffect(() => { setSelected([]); void load(false, null); }, [load, tick]);
  const refresh = (): void => { setTick((t) => t + 1); summary.reload(); };

  const dismiss = async (nos: string[], dismissed: boolean): Promise<void> => {
    try { await api.post('/pending-terminals/dismiss', { terminalNos: nos, dismissed }); refresh(); } catch (e) { message.error(errMsg(e)); }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert type="info" showIcon
        message={`${fmtNum(summary.data?.pendingActive ?? 0)} ترمینال فعال در فایل‌های تراکنش هست که در سامانه تعریف نشده است`}
        description="برای هر ترمینال پشتیبان تعیین کنید تا با اطلاعات فایل (نام فروشگاه، مالک، موبایل، بانک) ساخته شود و تراکنش‌هایش وارد آمار گردد. ترمینال‌هایی که مربوط به این دفتر نیستند را «نادیده بگیرید»." />
      <Card>
        <Tabs activeKey={status} onChange={(k) => setStatus(k as typeof status)} items={[
          { key: 'pending', label: `در انتظار تعیین پشتیبان (${fmtNum(summary.data?.pending ?? 0)})` },
          { key: 'dismissed', label: `نادیده‌گرفته‌شده (${fmtNum(summary.data?.dismissed ?? 0)})` },
        ]} />
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search allowClear placeholder="جستجو: شماره ترمینال، فروشگاه، مالک" style={{ width: 280 }} onSearch={setQ} />
          <Checkbox checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)}>فقط ترمینال‌های دارای تراکنش</Checkbox>
          {status === 'pending' ? (
            <>
              <Button type="primary" disabled={selected.length === 0} onClick={() => setAssignOpen(true)}>تعیین پشتیبان ({fmtNum(selected.length)})</Button>
              <Button disabled={selected.length === 0} onClick={() => { void dismiss(selected, true); }}>نادیده گرفتن</Button>
              <Button onClick={() => setSelected(items.map((i) => i.terminalNo))} disabled={items.length === 0}>انتخاب همه‌ی فهرست</Button>
            </>
          ) : <Button disabled={selected.length === 0} onClick={() => { void dismiss(selected, false); }}>بازگرداندن به فهرست</Button>}
        </Space>
        <Table size="small" rowKey="terminalNo" loading={loading} dataSource={items} pagination={false} scroll={{ x: 'max-content' }}
          rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
          columns={[
            { title: 'شماره ترمینال', dataIndex: 'terminalNo' },
            { title: 'فروشگاه', dataIndex: 'shopName', render: (v: string | null) => v ?? '—' },
            { title: 'مالک', dataIndex: 'ownerName', render: (v: string | null) => v ?? '—' },
            { title: 'موبایل', dataIndex: 'phone', render: (v: string | null) => v ?? '—' },
            { title: 'بانک (فایل)', render: (_: unknown, r: PendingTerminalDto) => (r.bankName
              ? <Tag color={r.matchedBankId ? 'green' : 'gold'}>{r.bankName}{r.matchedBankId ? '' : ' (تعریف‌نشده)'}</Tag> : '—') },
            { title: 'مبلغ خرید', dataIndex: 'lastAmount', render: fmtMoney },
            { title: 'مبلغ کل', dataIndex: 'lastTotalAmount', render: (v: number | null) => fmtMoney(v) },
            { title: 'تعداد', dataIndex: 'lastTxCount', render: fmtNum },
            { title: 'آخرین فایل', dataIndex: 'lastAsOfDate', render: jalaliText },
          ]} />
        {cursor && <Button style={{ marginTop: 12 }} loading={loading} onClick={() => { void load(true, cursor); }}>نمایش بیشتر</Button>}
      </Card>
      <AssignModal open={assignOpen} nos={selected} onClose={() => setAssignOpen(false)}
        onDone={(r) => {
          setAssignOpen(false); refresh(); ref.reload(); // بانک‌های تازه‌ساخته‌شده در انتخاب‌گرها دیده شوند
          if (r.skipped.length > 0) message.warning(`${fmtNum(r.skipped.length)} مورد رد شد`);
          message.success(`${fmtNum(r.created)} ترمینال ساخته شد و ${fmtNum(r.snapshotsAdopted)} ردیف تراکنش وارد آمار شد`);
        }} />
      <Button type="link" onClick={() => nav('/imports')}>بازگشت به ایمپورت</Button>
    </Space>
  );
}

function AssignModal({ open, nos, onClose, onDone }: { open: boolean; nos: string[]; onClose: () => void; onDone: (r: AssignPendingResultDto) => void }): JSX.Element {
  const ref = useRef2();
  const [supporterId, setSupporterId] = useState<number | undefined>();
  const [routeId, setRouteId] = useState<number | undefined>();
  const [bankId, setBankId] = useState<number | 'file'>('file');
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} title={`تعیین پشتیبان برای ${fmtNum(nos.length)} ترمینال`} onCancel={onClose} destroyOnClose
      okText="ثبت" cancelText="انصراف" okButtonProps={{ disabled: !supporterId, loading: busy }}
      onOk={async () => {
        if (!supporterId) return;
        setBusy(true);
        try {
          const r = await api.post<AssignPendingResultDto>('/pending-terminals/assign', {
            terminalNos: nos, supporterId, ...(routeId ? { routeGroupId: routeId } : {}), ...(bankId === 'file' ? {} : { bankId }),
          });
          onDone(r);
        } catch (e) { message.error(errMsg(e), 6); } finally { setBusy(false); }
      }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select showSearch optionFilterProp="label" placeholder="پشتیبان (الزامی)" style={{ width: '100%' }} value={supporterId} onChange={setSupporterId}
          options={ref.supporters.filter((s) => s.isActive).map((s) => ({ value: s.id, label: `${s.fullName} (${ref.unitName(s.staffUnitId)})` }))} />
        <Select allowClear showSearch optionFilterProp="label" placeholder="مسیر (اختیاری)" style={{ width: '100%' }} value={routeId} onChange={setRouteId}
          options={ref.routes.map((r) => ({ value: r.id, label: r.name }))} />
        <Select style={{ width: '100%' }} value={bankId} onChange={setBankId}
          options={[{ value: 'file', label: 'بانک: طبق نام بانک فایل (در صورت نبودن، طبق تنظیمات ساخته می‌شود)' },
            ...ref.banks.map((b) => ({ value: b.id, label: `بانک: ${b.name}` }))]} />
        <Alert type="warning" showIcon message="ترمینال از ماه‌های قبلِ فایل هم به همین پشتیبان نسبت داده می‌شود؛ تاریخچه‌ی تخصیص از ابتدا ثبت می‌شود و بعداً با «تعویض پشتیبان» قابل تغییر است." />
      </Space>
    </Modal>
  );
}
