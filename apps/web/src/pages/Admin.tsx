import { Alert, Button, Card, Divider, Form, InputNumber, Input, Modal, Popconfirm, Radio, Select, Space, Switch, Table, Tabs, Tag, message } from 'antd';
import { useState } from 'react';
import {
  periodIdOfDate, shiftPeriod, type ActivityRuleDto, type AutoProjectRunResultDto, type AutoProjectsStatusDto, type BulkBanksResultDto, type BulkResultDto, type BulkRoutesResultDto, type OfficeSettingsDto, type TransferUnitResultDto, type UserDto,
} from '@pos/shared';
import { AccessModal } from '../components/AccessModal';
import { BulkAddModal } from '../components/BulkAddModal';
import { JalaliDateField } from '../components/JalaliDateField';
import { Loading } from '../components/common';
import { useAuth } from '../auth';
import { api } from '../lib/api';
import { ROLE_FA, fmtNum, jalaliDateTime, jalaliText, periodLabel, todayIso } from '../lib/format';
import { errMsg, useApi } from '../lib/hooks';
import { useRef2 } from '../refdata';

export default function Admin(): JSX.Element {
  const { can } = useAuth();
  return (
    <Tabs items={[
      ...(can('masterdata.manage') ? [
        { key: 'master', label: 'ستاد و پشتیبان', children: <UnitsSupporters /> },
        { key: 'banks', label: 'بانک و مسیر', children: <BanksRoutes /> },
      ] : []),
      ...(can('settings.view') ? [{ key: 'settings', label: 'تنظیمات و قوانین فعالیت', children: <Settings /> }] : []),
      ...(can('users.manage') ? [{ key: 'users', label: 'کاربران و سطح دسترسی', children: <Users /> }] : []),
    ]} />
  );
}

/** نام جدید را می‌پرسد و مقدار را با callback ثبت می‌کند */
function usePrompt(): { ask: (title: string, onOk: (v: string) => Promise<void>, initial?: string) => void; holder: JSX.Element } {
  const [state, setState] = useState<{ title: string; onOk: (v: string) => Promise<void>; value: string } | null>(null);
  return {
    ask: (title, onOk, initial = '') => setState({ title, onOk, value: initial }),
    holder: (
      <Modal open={state !== null} title={state?.title} onCancel={() => setState(null)} okText="ثبت" cancelText="انصراف" destroyOnClose
        onOk={async () => { if (!state?.value.trim()) return; try { await state.onOk(state.value.trim()); setState(null); } catch (e) { message.error(errMsg(e)); } }}>
        <Input autoFocus value={state?.value ?? ''} onChange={(e) => setState((s) => (s ? { ...s, value: e.target.value } : s))} />
      </Modal>
    ),
  };
}

function UnitsSupporters(): JSX.Element {
  const ref = useRef2();
  const p = usePrompt();
  const [transfer, setTransfer] = useState<{ kind: 'unit' | 'terminals'; id: number } | null>(null);
  const [toUnit, setToUnit] = useState<number | undefined>();
  const [toSup, setToSup] = useState<number | undefined>();
  const [date, setDate] = useState<string | undefined>();
  const [newSup, setNewSup] = useState<{ name: string; unitId: number | undefined } | null>(null);

  const doTransfer = async (): Promise<void> => {
    if (!transfer) return;
    try {
      if (transfer.kind === 'unit' && toUnit) {
        const r = await api.post<TransferUnitResultDto>(`/supporters/${transfer.id}/transfer-unit`, { toUnitId: toUnit, ...(date ? { effectiveDate: date } : {}) });
        message.success(`پشتیبان منتقل شد (${fmtNum(r.terminals)} ترمینال همراه او)`);
      } else if (transfer.kind === 'terminals' && toSup) {
        const r = await api.post<BulkResultDto>(`/supporters/${transfer.id}/transfer-terminals`, { toSupporterId: toSup, ...(date ? { effectiveDate: date } : {}) });
        message.success(`${fmtNum(r.updated)} ترمینال منتقل شد`);
      } else return;
      setTransfer(null); setToUnit(undefined); setToSup(undefined); setDate(undefined); ref.reload();
    } catch (e) { message.error(errMsg(e), 6); }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card title="ستادها" extra={<Button type="primary" onClick={() => p.ask('نام ستاد جدید', async (v) => { await api.post('/staff-units', { name: v }); ref.reload(); })}>ستاد جدید</Button>}>
        <Table size="small" rowKey="id" pagination={false} dataSource={ref.units} columns={[
          { title: 'نام', dataIndex: 'name' }, { title: 'مسئول', dataIndex: 'managerName' },
          { title: 'فعال', dataIndex: 'isActive', render: (v: boolean, r) => <Switch checked={v} onChange={async (c) => { try { await api.patch(`/staff-units/${r.id}`, { isActive: c }); ref.reload(); } catch (e) { message.error(errMsg(e)); } }} /> },
        ]} />
      </Card>
      <Card title="پشتیبان‌ها" extra={<Button type="primary" onClick={() => setNewSup({ name: '', unitId: undefined })}>پشتیبان جدید</Button>}>
        <Table size="small" rowKey="id" pagination={{ pageSize: 15 }} dataSource={ref.supporters} columns={[
          { title: 'نام', dataIndex: 'fullName' }, { title: 'ستاد', dataIndex: 'staffUnitId', render: (v: number) => ref.unitName(v) },
          { title: 'فعال', dataIndex: 'isActive', render: (v: boolean, r) => <Switch checked={v} onChange={async (c) => { try { await api.patch(`/supporters/${r.id}`, { isActive: c }); ref.reload(); } catch (e) { message.error(errMsg(e)); } }} /> },
          { title: 'انتقال', render: (_: unknown, r) => (
            <Space>
              <Button size="small" onClick={() => setTransfer({ kind: 'unit', id: r.id })}>به ستاد دیگر</Button>
              <Button size="small" onClick={() => setTransfer({ kind: 'terminals', id: r.id })}>ترمینال‌ها به پشتیبان دیگر</Button>
            </Space>) },
        ]} />
      </Card>
      {p.holder}
      <Modal open={newSup !== null} title="پشتیبان جدید" okText="ثبت" cancelText="انصراف" destroyOnClose onCancel={() => setNewSup(null)}
        okButtonProps={{ disabled: !newSup?.name.trim() || !newSup.unitId }}
        onOk={async () => {
          if (!newSup?.unitId) return;
          try { await api.post('/supporters', { fullName: newSup.name.trim(), staffUnitId: newSup.unitId }); setNewSup(null); ref.reload(); } catch (e) { message.error(errMsg(e)); }
        }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="نام و نام خانوادگی" value={newSup?.name ?? ''} onChange={(e) => setNewSup((s) => (s ? { ...s, name: e.target.value } : s))} />
          <Select placeholder="ستاد" style={{ width: '100%' }} value={newSup?.unitId} onChange={(v) => setNewSup((s) => (s ? { ...s, unitId: v } : s))}
            options={ref.units.filter((u) => u.isActive).map((u) => ({ value: u.id, label: u.name }))} />
        </Space>
      </Modal>
      <Modal open={transfer !== null} destroyOnClose onCancel={() => setTransfer(null)} okText="انتقال" cancelText="انصراف" onOk={() => { void doTransfer(); }}
        title={transfer?.kind === 'unit' ? `انتقال ${ref.supporterName(transfer.id)} به ستاد دیگر` : `انتقال ترمینال‌های ${ref.supporterName(transfer?.id)}`}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="info" showIcon message={transfer?.kind === 'unit'
            ? 'از تاریخ اعمال به بعد، آمار ترمینال‌های این پشتیبان به ستاد جدید می‌رود؛ ماه‌های قبل تغییر نمی‌کند.'
            : 'همه‌ی ترمینال‌های فعلی به پشتیبان مقصد منتقل می‌شود (ستاد ترمینال‌ها با ستاد پشتیبان مقصد هم‌خوان می‌شود).'} />
          {transfer?.kind === 'unit'
            ? <Select placeholder="ستاد مقصد" style={{ width: '100%' }} value={toUnit} onChange={setToUnit} options={ref.units.filter((u) => u.isActive).map((u) => ({ value: u.id, label: u.name }))} />
            : <Select showSearch optionFilterProp="label" placeholder="پشتیبان مقصد" style={{ width: '100%' }} value={toSup} onChange={setToSup}
                options={ref.supporters.filter((s) => s.isActive && s.id !== transfer?.id).map((s) => ({ value: s.id, label: `${s.fullName} (${ref.unitName(s.staffUnitId)})` }))} />}
          <JalaliDateField value={date} onChange={setDate} placeholder="تاریخ اعمال (پیش‌فرض: امروز)" />
        </Space>
      </Modal>
    </Space>
  );
}

function BanksRoutes(): JSX.Element {
  const ref = useRef2();
  const p = usePrompt();
  const [bulk, setBulk] = useState<'banks' | 'routes' | null>(null);
  const report = (r: { created: number; skipped: Array<{ name: string; reason: string }> }): void => {
    message.success(`${fmtNum(r.created)} مورد ثبت شد${r.skipped.length ? ` (${fmtNum(r.skipped.length)} مورد رد شد)` : ''}`);
    ref.reload();
    setBulk(null);
  };
  const del = async (path: string): Promise<void> => { try { await api.del(path); ref.reload(); } catch (e) { message.error(errMsg(e)); } };
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card title="بانک‌ها" extra={<Space><Button onClick={() => setBulk('banks')}>افزودن گروهی</Button><Button type="primary" onClick={() => p.ask('نام بانک', async (v) => { await api.post('/banks', { name: v }); ref.reload(); })}>بانک جدید</Button></Space>}>
        <Table size="small" rowKey="id" pagination={false} dataSource={ref.banks} columns={[
          { title: 'نام', dataIndex: 'name' },
          { title: '', render: (_: unknown, r) => <Popconfirm title="حذف شود؟" onConfirm={() => { void del(`/banks/${r.id}`); }}><Button size="small" danger>حذف</Button></Popconfirm> },
        ]} />
      </Card>
      <Card title="مسیرها" extra={<Space><Button onClick={() => setBulk('routes')}>افزودن گروهی</Button><Button type="primary" onClick={() => p.ask('نام مسیر', async (v) => { await api.post('/route-groups', { name: v }); ref.reload(); })}>مسیر جدید</Button></Space>}>
        <Table size="small" rowKey="id" pagination={{ pageSize: 15 }} dataSource={ref.routes} columns={[
          { title: 'نام', dataIndex: 'name' },
          { title: '', render: (_: unknown, r) => <Popconfirm title="حذف شود؟" onConfirm={() => { void del(`/route-groups/${r.id}`); }}><Button size="small" danger>حذف</Button></Popconfirm> },
        ]} />
      </Card>
      {p.holder}
      <BulkAddModal open={bulk === 'banks'} title="افزودن گروهی بانک" withCode existing={ref.banks.map((b) => b.name)} onClose={() => setBulk(null)}
        onSubmit={async (lines) => {
          try { report(await api.post<BulkBanksResultDto>('/banks/bulk', { items: lines.map((l) => ({ name: l.name, ...(l.code ? { code: l.code } : {}) })) })); } catch (e) { message.error(errMsg(e)); }
        }} />
      <BulkAddModal open={bulk === 'routes'} title="افزودن گروهی مسیر" existing={ref.routes.map((r) => r.name)} onClose={() => setBulk(null)}
        onSubmit={async (lines) => {
          try { report(await api.post<BulkRoutesResultDto>('/route-groups/bulk', { names: lines.map((l) => l.name) })); } catch (e) { message.error(errMsg(e)); }
        }} />
    </Space>
  );
}

function Settings(): JSX.Element {
  const ref = useRef2();
  const { can } = useAuth();
  const canEdit = can('settings.manage');
  const s = useApi(() => api.get<OfficeSettingsDto>('/settings/office'), []);
  const rules = useApi(() => api.get<ActivityRuleDto[]>('/settings/activity-rules'), []);
  const [form] = Form.useForm<OfficeSettingsDto>();
  const [rule, setRule] = useState<{ bankId: number; period: number; amount: number | null }>({ bankId: 0, period: periodIdOfDate(todayIso()), amount: null });
  const nowP = periodIdOfDate(todayIso());

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card title="تنظیمات دفتر">
        <Loading loading={s.loading} error={s.error}>
          {s.data && (
            <Form form={form} layout="vertical" disabled={!canEdit} initialValues={s.data} onFinish={async (v) => {
              try { await api.put('/settings/office', v); message.success('ذخیره شد؛ بازطبقه‌بندی در پس‌زمینه انجام می‌شود'); s.reload(); } catch (e) { message.error(errMsg(e)); }
            }}>
              <Space wrap size={24} align="start">
                <Form.Item name="newTerminalCutoffDay" label="روز نوپا"><InputNumber min={1} max={31} /></Form.Item>
                <Form.Item name="preliminaryAlertMinDay" label="شروع هشدار مقدماتی (روز ماه)"><InputNumber min={1} max={31} /></Form.Item>
                <Form.Item name="dropAlertThresholdPct" label="آستانه‌ی افت (٪)"><InputNumber min={1} max={99} /></Form.Item>
              </Space>

              <Divider orientation="left">مبنای مبلغ برای «کم‌تراکنش / فاقد درآمد»</Divider>
              <Form.Item name="incomeBasis" extra="هر ترمینال دو مبلغ دارد: «مبلغ خرید» (مجموع تراکنش‌های خرید که به حساب پذیرنده واریز شده) و «مبلغ کل» (خرید + شارژ + قبض و ...). فعال‌بودن، کم‌تراکنش‌بودن و پروژه‌های فاقد درآمد بر پایه‌ی مبنای انتخابی سنجیده می‌شود. داشبوردها و رشد، همیشه مبلغ خرید را نشان می‌دهند.">
                <Radio.Group>
                  <Radio value="purchase">مبلغ خرید (پیشنهادی)</Radio>
                  <Radio value="total">مبلغ کل</Radio>
                </Radio.Group>
              </Form.Item>

              <Divider orientation="left">پروژه‌های خودکار «فاقد درآمد»</Divider>
              <Space wrap size={24} align="start">
                <Form.Item name="autoNoIncomePrev" label="پروژه‌ی ماه قبل" valuePropName="checked"><Switch checkedChildren="فعال" unCheckedChildren="غیرفعال" /></Form.Item>
                <Form.Item name="autoPrevDeadlineDay" label="مهلت: تا این روزِ ماه جاری" extra="ترمینال‌های کم‌تراکنش ماه قبل"><InputNumber min={1} max={29} /></Form.Item>
                <Form.Item name="autoNoIncomeCurr" label="پروژه‌ی ماه جاری" valuePropName="checked"><Switch checkedChildren="فعال" unCheckedChildren="غیرفعال" /></Form.Item>
                <Form.Item name="autoCurrCheckDay" label="ارزیابی از این روزِ ماه" extra="مهلت: پایان همان ماه"><InputNumber min={1} max={29} /></Form.Item>
              </Space>

              <Divider orientation="left">همگام‌سازی اطلاعات ترمینال با فایل تراکنش</Divider>
              <Space wrap size={24} align="start">
                <Form.Item name="syncTerminalInfo" label="به‌روزرسانی خودکار نام فروشگاه، مالک، موبایل، آدرس و بانک در صورت مغایرت" valuePropName="checked"
                  extra="هر تغییر با نام کاربر، زمان و فایل مبدأ در «تاریخچه‌ی تغییرات» ثبت می‌شود؛ سلول خالی فایل چیزی را پاک نمی‌کند."><Switch /></Form.Item>
                <Form.Item name="syncCreateBanks" label="ساخت خودکار بانکِ ناشناخته‌ی فایل" valuePropName="checked"><Switch /></Form.Item>
              </Space>

              <Divider orientation="left">وزن مؤلفه‌های امتیاز پشتیبان</Divider>
              <Space wrap size={24} align="start">
                <Form.Item name={['scoreWeights', 'amount']} label="رشد مبلغ خرید"><InputNumber min={0} max={100} /></Form.Item>
                <Form.Item name={['scoreWeights', 'count']} label="رشد تعداد تراکنش"><InputNumber min={0} max={100} /></Form.Item>
                <Form.Item name={['scoreWeights', 'devices']} label="رشد و سلامت دستگاه‌ها"><InputNumber min={0} max={100} /></Form.Item>
                <Form.Item name={['scoreWeights', 'projects']} label="عملکرد در پروژه‌ها"><InputNumber min={0} max={100} /></Form.Item>
              </Space>
              <div><Button type="primary" htmlType="submit">ذخیره</Button></div>
            </Form>
          )}
        </Loading>
      </Card>
      {canEdit && <AutoProjectsCard />}
      <Card title="قوانین حداقل مبلغ فعالیت (کم‌تراکنش)">
        <Table size="small" rowKey={(r) => `${r.bankId}:${r.validFromPeriod}`} pagination={false} dataSource={rules.data ?? []} columns={[
          { title: 'بانک', dataIndex: 'bankId', render: (v: number) => (v === 0 ? 'پیش‌فرض دفتر' : ref.bankName(v)) },
          { title: 'از ماه', dataIndex: 'validFromPeriod', render: periodLabel }, { title: 'حداقل مبلغ ماهانه', dataIndex: 'minMonthlyAmount', render: fmtNum },
        ]} />
        {canEdit && (
          <Space wrap style={{ marginTop: 12 }}>
            <Select style={{ width: 160 }} value={rule.bankId} onChange={(v) => setRule((r) => ({ ...r, bankId: v }))} options={[{ value: 0, label: 'پیش‌فرض دفتر' }, ...ref.banks.map((b) => ({ value: b.id, label: b.name }))]} />
            <Select style={{ width: 140 }} value={rule.period} onChange={(v) => setRule((r) => ({ ...r, period: v }))} options={Array.from({ length: 36 }, (_, i) => shiftPeriod(nowP, -i)).map((p) => ({ value: p, label: periodLabel(p) }))} />
            <InputNumber style={{ width: 200 }} placeholder="حداقل مبلغ (ریال)" min={0} value={rule.amount} onChange={(v) => setRule((r) => ({ ...r, amount: v }))} />
            <Button type="primary" disabled={rule.amount === null} onClick={async () => {
              try { await api.put('/settings/activity-rules', { bankId: rule.bankId, validFromPeriod: rule.period, minMonthlyAmount: rule.amount }); message.success('قانون ثبت شد؛ بازطبقه‌بندی در پس‌زمینه'); rules.reload(); } catch (e) { message.error(errMsg(e)); }
            }}>افزودن قانون</Button>
          </Space>
        )}
      </Card>
      {can('settings.maintenance') && (
        <Card title="نگهداری">
          <Popconfirm title="بازسازی کامل آمار از snapshotها؟ ممکن است چند دقیقه طول بکشد." onConfirm={async () => {
            try { await api.post('/admin/aggregates/rebuild', {}); message.success('بازسازی در صف قرار گرفت'); } catch (e) { message.error(errMsg(e)); }
          }}><Button>بازسازی آمار تجمیعی</Button></Popconfirm>
        </Card>
      )}
    </Space>
  );
}

function Users(): JSX.Element {
  const ref = useRef2();
  const users = useApi(() => api.get<UserDto[]>('/users'), []);
  const [open, setOpen] = useState(false);
  const [access, setAccess] = useState<UserDto | null>(null);
  const [form] = Form.useForm();
  const role = Form.useWatch('role', form) as UserDto['role'] | undefined;
  return (
    <Card title="کاربران" extra={<Button type="primary" onClick={() => setOpen(true)}>کاربر جدید</Button>}>
      <Loading loading={users.loading} error={users.error}>
        <Table size="small" rowKey="id" pagination={{ pageSize: 15 }} dataSource={users.data ?? []} columns={[
          { title: 'نام کاربری', dataIndex: 'username' }, { title: 'نام', dataIndex: 'fullName' },
          { title: 'نقش', dataIndex: 'role', render: (r: string) => <Tag>{ROLE_FA[r] ?? r}</Tag> },
          { title: 'ستاد/پشتیبان', render: (_: unknown, r: UserDto) => (r.staffUnitId ? ref.unitName(r.staffUnitId) : r.supporterId ? ref.supporterName(r.supporterId) : '—') },
          { title: 'سطح دسترسی', render: (_: unknown, r: UserDto) => (
            <Space>
              {r.role === 'office_manager' ? <Tag color="gold">کامل</Tag> : r.permissions === null ? <Tag color="green">پیش‌فرض نقش</Tag>
                : <Tag color="orange">سفارشی ({fmtNum(r.effectivePermissions.length)} مجوز)</Tag>}
              <Button size="small" onClick={() => setAccess(r)}>ویرایش</Button>
            </Space>) },
          { title: 'فعال', dataIndex: 'isActive', render: (v: boolean, r: UserDto) => <Switch checked={v} onChange={async (c) => { try { await api.patch(`/users/${r.id}`, { isActive: c }); users.reload(); } catch (e) { message.error(errMsg(e)); } }} /> },
        ]} />
      </Loading>
      <AccessModal user={access} onClose={() => setAccess(null)} onSaved={() => { setAccess(null); users.reload(); }} />
      <Modal title="کاربر جدید" open={open} onCancel={() => setOpen(false)} okText="ایجاد" cancelText="انصراف" destroyOnClose
        onOk={async () => {
          const v = await form.validateFields();
          try { await api.post('/users', v); setOpen(false); form.resetFields(); users.reload(); } catch (e) { message.error(errMsg(e)); }
        }}>
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="نام کاربری" rules={[{ required: true }]}><Input style={{ direction: 'ltr' }} /></Form.Item>
          <Form.Item name="fullName" label="نام کامل" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="password" label="رمز عبور (حداقل ۸ نویسه)" rules={[{ required: true, min: 8 }]}><Input.Password style={{ direction: 'ltr' }} /></Form.Item>
          <Form.Item name="role" label="نقش" rules={[{ required: true }]}>
            <Select options={['office_manager', 'data_admin', 'unit_head', 'supporter'].map((r) => ({ value: r, label: ROLE_FA[r] }))} />
          </Form.Item>
          {role === 'unit_head' && <Form.Item name="staffUnitId" label="ستاد" rules={[{ required: true }]}><Select options={ref.units.map((u) => ({ value: u.id, label: u.name }))} /></Form.Item>}
          {role === 'supporter' && <Form.Item name="supporterId" label="پشتیبان" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={ref.supporters.map((s) => ({ value: s.id, label: s.fullName }))} /></Form.Item>}
        </Form>
      </Modal>
    </Card>
  );
}

const KIND_FA = { no_income_prev: 'فاقد درآمد ماه قبل', no_income_curr: 'فاقد درآمد ماه جاری' } as const;
const OUTCOME_FA: Record<string, { text: string; color: string }> = {
  created: { text: 'ساخته شد', color: 'green' }, updated: { text: 'تکمیل شد', color: 'blue' },
  unchanged: { text: 'بدون تغییر', color: 'default' }, skipped: { text: 'انجام نشد', color: 'orange' },
};

/** پروژه‌های خودکار: وضعیت، آخرین اجراها و ایجاد/به‌روزرسانی فوری (بر پایه‌ی تنظیمات ذخیره‌شده) */
function AutoProjectsCard(): JSX.Element {
  const st = useApi(() => api.get<AutoProjectsStatusDto>('/settings/auto-projects'), []);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (kind: 'no_income_prev' | 'no_income_curr'): Promise<void> => {
    setBusy(kind);
    try {
      const r = await api.post<{ results: AutoProjectRunResultDto[] }>('/settings/auto-projects/run', { kind, force: true });
      const x = r.results[0];
      if (x?.outcome === 'skipped') message.warning(x.message ?? 'انجام نشد');
      else message.success(`${OUTCOME_FA[x?.outcome ?? 'unchanged']?.text}: ${fmtNum(x?.added ?? 0)} ترمینال اضافه شد`);
      st.reload();
    } catch (e) { message.error(errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <Card title="وضعیت پروژه‌های خودکار" extra={
      <Space>
        <Button loading={busy === 'no_income_prev'} onClick={() => { void run('no_income_prev'); }}>ایجاد/به‌روزرسانی ماه قبل</Button>
        <Button loading={busy === 'no_income_curr'} onClick={() => { void run('no_income_curr'); }}>ایجاد/به‌روزرسانی ماه جاری</Button>
      </Space>}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="اجرای خودکار هر چند ساعت یک‌بار است و فقط وقتی داده‌ی لازم ایمپورت شده باشد پروژه می‌سازد. دکمه‌ها با تنظیمات ذخیره‌شده کار می‌کنند (حتی اگر نوع آن غیرفعال باشد). ترمینال‌هایی که دستی از پروژه حذف شوند دوباره اضافه نمی‌شوند." />
      <Loading loading={st.loading} error={st.error}>
        <Table size="small" rowKey="id" pagination={false} dataSource={st.data?.projects ?? []} locale={{ emptyText: 'هنوز پروژه‌ی خودکاری ساخته نشده است' }} columns={[
          { title: 'پروژه', dataIndex: 'name' }, { title: 'نوع', dataIndex: 'kind', render: (k: keyof typeof KIND_FA) => KIND_FA[k] },
          { title: 'ترمینال', dataIndex: 'total', render: fmtNum }, { title: 'مهلت', dataIndex: 'dueDate', render: jalaliText },
          { title: 'وضعیت', dataIndex: 'status' },
        ]} />
        <Table size="small" style={{ marginTop: 12 }} rowKey="id" pagination={false} dataSource={st.data?.runs ?? []} columns={[
          { title: 'زمان', dataIndex: 'createdAt', render: jalaliDateTime }, { title: 'نوع', dataIndex: 'kind', render: (k: keyof typeof KIND_FA) => KIND_FA[k] },
          { title: 'ماه', dataIndex: 'periodId', render: periodLabel },
          { title: 'نتیجه', dataIndex: 'outcome', render: (o: string) => <Tag color={OUTCOME_FA[o]?.color}>{OUTCOME_FA[o]?.text ?? o}</Tag> },
          { title: 'افزوده', dataIndex: 'added', render: fmtNum }, { title: 'واجد شرایط', dataIndex: 'eligible', render: fmtNum },
          { title: 'توضیح', dataIndex: 'message', render: (m: string | null) => m ?? '—' },
          { title: 'اجرا', dataIndex: 'trigger', render: (t: string) => (t === 'manual' ? 'دستی' : 'خودکار') },
        ]} />
      </Loading>
    </Card>
  );
}
