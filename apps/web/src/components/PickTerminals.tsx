import { Alert, Button, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import type { Page, ProjectImportResultDto, TerminalDto } from '@pos/shared';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { fmtNum } from '../lib/format';
import { errMsg } from '../lib/hooks';
import { useRef2 } from '../refdata';

const MAX = 5000;

/**
 * انتخاب ترمینال از فهرست ترمینال‌های موجود و افزودن به پروژه.
 * جستجو و فیلتر (ستاد، پشتیبان، بانک، مسیر)، انتخاب دستی بین چند صفحه، یا «انتخاب همه‌ی نتایج فیلتر» (تا ۵۰۰۰ مورد).
 * ترمینال‌هایی که از قبل در پروژه‌اند بی‌اثرند و در نتیجه گزارش می‌شوند.
 */
export function PickTerminalsModal({ open, projectId, onClose, onDone }: {
  open: boolean; projectId: number; onClose: () => void; onDone: (r: ProjectImportResultDto) => void;
}): JSX.Element {
  const { isManager } = useAuth();
  const ref = useRef2();
  const [q, setQ] = useState('');
  const [f, setF] = useState<{ unitId?: number; supporterId?: number; bankId?: number; routeGroupId?: number }>({});
  const [items, setItems] = useState<TerminalDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const params = useCallback((after?: string | null, limit = 50) => ({ ...f, q: q || undefined, status: 'active', limit, cursor: after ?? undefined }), [f, q]);

  const load = useCallback(async (more: boolean, after: string | null) => {
    setLoading(true);
    try {
      const p = await api.get<Page<TerminalDto>>('/terminals', params(more ? after : null));
      setItems((prev) => (more ? [...prev, ...p.items] : p.items));
      setCursor(p.nextCursor);
    } catch (e) { message.error(errMsg(e)); } finally { setLoading(false); }
  }, [params]);

  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => { void load(false, null); }, 300);
    return () => clearTimeout(t);
  }, [open, load]);
  useEffect(() => { if (!open) { setSelected([]); setItems([]); } }, [open]);

  /** همه‌ی نتایج فیلتر فعلی را (صفحه‌به‌صفحه، تا سقف) انتخاب می‌کند */
  const selectAllMatching = async (): Promise<void> => {
    setBusy(true);
    try {
      const ids = new Set(selected);
      let after: string | null = null;
      do {
        const p: Page<TerminalDto> = await api.get<Page<TerminalDto>>('/terminals', params(after, 200));
        for (const t of p.items) { if (ids.size < MAX) ids.add(t.id); }
        after = ids.size >= MAX ? null : p.nextCursor;
      } while (after);
      setSelected([...ids]);
      if (ids.size >= MAX) message.warning(`سقف ${fmtNum(MAX)} ترمینال در هر بار افزودن است`);
    } catch (e) { message.error(errMsg(e)); } finally { setBusy(false); }
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<ProjectImportResultDto>(`/projects/${projectId}/terminals`, { terminalIds: selected });
      message.success(`${fmtNum(r.added)} ترمینال اضافه شد${r.alreadyInProject ? ` (${fmtNum(r.alreadyInProject)} از قبل در پروژه بود)` : ''}`);
      onDone(r);
    } catch (e) { message.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onCancel={onClose} width={960} destroyOnClose title="افزودن ترمینال از فهرست ترمینال‌ها"
      footer={(
        <Space>
          <Button onClick={onClose}>بستن</Button>
          <Button type="primary" disabled={selected.length === 0} loading={busy} onClick={() => { void submit(); }}>افزودن {fmtNum(selected.length)} ترمینال به پروژه</Button>
        </Space>
      )}>
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <Space wrap>
          <Input.Search allowClear placeholder="شماره ترمینال، فروشگاه، مالک، تلفن" style={{ width: 260 }} onSearch={setQ} />
          {isManager && <Select allowClear placeholder="ستاد" style={{ width: 130 }} onChange={(v) => setF((x) => ({ ...x, unitId: v }))} options={ref.units.map((u) => ({ value: u.id, label: u.name }))} />}
          <Select allowClear showSearch optionFilterProp="label" placeholder="پشتیبان" style={{ width: 150 }} onChange={(v) => setF((x) => ({ ...x, supporterId: v }))} options={ref.supporters.map((s) => ({ value: s.id, label: s.fullName }))} />
          <Select allowClear placeholder="بانک" style={{ width: 120 }} onChange={(v) => setF((x) => ({ ...x, bankId: v }))} options={ref.banks.map((b) => ({ value: b.id, label: b.name }))} />
          <Select allowClear showSearch optionFilterProp="label" placeholder="مسیر" style={{ width: 130 }} onChange={(v) => setF((x) => ({ ...x, routeGroupId: v }))} options={ref.routes.map((r) => ({ value: r.id, label: r.name }))} />
        </Space>
        <Space wrap>
          <Button size="small" loading={busy} onClick={() => { void selectAllMatching(); }}>انتخاب همه‌ی نتایج این فیلتر</Button>
          {selected.length > 0 && <Button size="small" onClick={() => setSelected([])}>پاک کردن انتخاب</Button>}
          <Tag color="blue">{fmtNum(selected.length)} انتخاب شده</Tag>
        </Space>
        {selected.length >= MAX && <Alert type="warning" showIcon message={`به سقف ${fmtNum(MAX)} ترمینال رسیده‌اید`} />}
        <Table size="small" rowKey="id" loading={loading} dataSource={items} pagination={false} scroll={{ y: 360 }}
          rowSelection={{ selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: (keys) => setSelected((prev) => {
            // انتخاب‌های صفحه‌های دیگر حفظ می‌شود؛ فقط ردیف‌های همین فهرست جایگزین می‌شوند
            const visible = new Set(items.map((t) => t.id));
            return [...prev.filter((id) => !visible.has(id)), ...(keys as number[])];
          }) }}
          columns={[
            { title: 'شماره ترمینال', dataIndex: 'terminalNo', width: 130 }, { title: 'فروشگاه', dataIndex: 'shopName' },
            { title: 'پشتیبان', dataIndex: 'supporterId', render: (v: number) => ref.supporterName(v) },
            { title: 'ستاد', dataIndex: 'unitId', render: (v: number) => ref.unitName(v) },
            { title: 'بانک', dataIndex: 'bankId', render: (v: number | null) => ref.bankName(v) },
            { title: 'مسیر', dataIndex: 'routeGroupId', render: (v: number | null) => ref.routeName(v) },
          ]}
          footer={() => (cursor ? <Button onClick={() => { void load(true, cursor); }}>نمایش بیشتر</Button> : <span>{fmtNum(items.length)} مورد</span>)} />
      </Space>
    </Modal>
  );
}
