import { DownloadOutlined, InboxOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Drawer, Form, Input, Modal, Progress, Radio, Select, Space, Table, Tabs, Tag, Upload, message } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  IMPORT_REGISTRY, IMPORT_TYPES, periodIdOfDate, shiftPeriod, type ImportBatchDto, type ImportErrorDto, type ImportStatus, type ImportType,
  type MappingInfoDto, type Page, type UnknownTerminalDto,
} from '@pos/shared';
import { JalaliDateField } from '../components/JalaliDateField';
import { api } from '../lib/api';
import { fmtNum, jalaliText, periodLabel, todayIso } from '../lib/format';
import { errMsg, useApi } from '../lib/hooks';

const STATUS_FA: Record<ImportStatus, { text: string; color: string }> = {
  uploaded: { text: 'آپلود شد', color: 'default' }, needs_mapping: { text: 'نیازمند نگاشت ستون', color: 'gold' },
  validating: { text: 'در حال اعتبارسنجی', color: 'processing' }, validated: { text: 'آماده‌ی تأیید', color: 'cyan' },
  committing: { text: 'در حال ثبت', color: 'processing' }, merged: { text: 'ثبت شد', color: 'blue' },
  aggregating: { text: 'در حال تجمیع آمار', color: 'processing' }, completed: { text: 'تکمیل', color: 'green' },
  failed: { text: 'ناموفق', color: 'red' }, cancelled: { text: 'لغو شد', color: 'default' },
};
const BUSY: ImportStatus[] = ['uploaded', 'validating', 'committing', 'merged', 'aggregating'];

export default function Imports(): JSX.Element {
  const [type, setType] = useState<ImportType>('transactions_cumulative');
  const [asOf, setAsOf] = useState<string | undefined>();
  const [effective, setEffective] = useState<string | undefined>();
  const [source, setSource] = useState<'daily' | 'monthly'>('daily');
  const [period, setPeriod] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [mapping, setMapping] = useState<{ batch: ImportBatchDto; info: MappingInfoDto } | null>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const list = useApi(() => api.get<Page<ImportBatchDto>>('/imports', { limit: 30 }), [], 4000);
  const nowPeriod = periodIdOfDate(todayIso());

  const upload = async (file: File): Promise<void> => {
    if (source === 'monthly' && type === 'transactions_cumulative' && !period) { message.error('برای فایل پایان ماه، دوره را انتخاب کنید'); return; }
    setBusy(true);
    try {
      const options: Record<string, unknown> = {};
      if (type === 'transactions_cumulative') {
        if (asOf) options.asOfDate = asOf;
        options.source = source;
        if (source === 'monthly' && period) options.periodId = period;
      } else if (effective) options.effectiveDate = effective;
      const r = await api.upload<{ batch: ImportBatchDto; mapping: MappingInfoDto }>('/imports', { type, options: JSON.stringify(options) }, file);
      list.reload();
      if (r.batch.status === 'needs_mapping') setMapping({ batch: r.batch, info: r.mapping });
      else { message.success('فایل دریافت شد و اعتبارسنجی شروع شد'); setDetail(r.batch.id); }
    } catch (e) { message.error(errMsg(e), 6); } finally { setBusy(false); }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="ایمپورت فایل">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Select style={{ width: 320 }} value={type} onChange={setType} options={IMPORT_TYPES.map((t) => ({ value: t, label: IMPORT_REGISTRY[t].title }))} />
            <Button icon={<DownloadOutlined />} onClick={() => { void api.download(`/imports/templates/${type}`, undefined, `${type}-template.xlsx`); }}>دانلود قالب</Button>
          </Space>
          {type === 'transactions_cumulative' ? (
            <Space wrap>
              <Radio.Group value={source} onChange={(e) => setSource(e.target.value as typeof source)}
                options={[{ value: 'daily', label: 'فایل روزانه' }, { value: 'monthly', label: 'فایل پایان ماه' }]} optionType="button" />
              {source === 'daily'
                ? <JalaliDateField value={asOf} onChange={setAsOf} placeholder="تاریخ فایل (اگر ستون تاریخ ندارد)" />
                : <Select placeholder="دوره‌ی فایل پایان ماه" style={{ width: 180 }} value={period} onChange={setPeriod}
                    options={Array.from({ length: 24 }, (_, i) => shiftPeriod(nowPeriod, -i - 1)).map((p) => ({ value: p, label: periodLabel(p) }))} />}
            </Space>
          ) : <JalaliDateField value={effective} onChange={setEffective} placeholder="تاریخ اعمال تغییر پشتیبان/مسیر/بانک (پیش‌فرض: امروز)" />}
          <Upload.Dragger accept=".xlsx,.csv" maxCount={1} showUploadList={false} disabled={busy} beforeUpload={(f) => { void upload(f); return false; }}>
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p>فایل xlsx یا csv را اینجا رها کنید یا کلیک کنید</p>
          </Upload.Dragger>
        </Space>
      </Card>

      <Card title="دسته‌های اخیر">
        <Table size="small" rowKey="id" loading={list.loading && !list.data} dataSource={list.data?.items ?? []} pagination={false} columns={[
          { title: '#', dataIndex: 'id', width: 60 }, { title: 'فایل', dataIndex: 'fileName', ellipsis: true },
          { title: 'نوع', dataIndex: 'type', render: (t: string) => IMPORT_REGISTRY[t as ImportType]?.title.split(' ')[0] ?? t },
          { title: 'وضعیت', dataIndex: 'status', render: (s: ImportStatus) => <Tag color={STATUS_FA[s].color}>{STATUS_FA[s].text}</Tag> },
          { title: 'پیشرفت', render: (_: unknown, r: ImportBatchDto) => (BUSY.includes(r.status) ? <Progress percent={Math.round(r.progress)} size="small" /> : '—') },
          { title: 'ردیف (معتبر/خطا)', render: (_: unknown, r: ImportBatchDto) => (r.totalRows === null ? '—' : `${fmtNum(r.totalRows)} (${fmtNum(r.validRows)}/${fmtNum(r.errorRows)})`) },
          { title: 'زمان', dataIndex: 'createdAt', render: jalaliText },
          { title: '', render: (_: unknown, r: ImportBatchDto) => <Button size="small" onClick={() => setDetail(r.id)}>جزئیات</Button> },
        ]} />
      </Card>

      {mapping && <MappingModal data={mapping} onClose={() => setMapping(null)} onDone={(id) => { setMapping(null); list.reload(); setDetail(id); }} />}
      <BatchDrawer id={detail} onClose={() => setDetail(null)} onChanged={list.reload} />
    </Space>
  );
}

function MappingModal({ data, onClose, onDone }: { data: { batch: ImportBatchDto; info: MappingInfoDto }; onClose: () => void; onDone: (id: number) => void }): JSX.Element {
  const type = data.batch.type as ImportType;
  const [map, setMap] = useState<Record<string, string>>({ ...data.info.columnMap });
  const [save, setSave] = useState('');
  const fields = IMPORT_REGISTRY[type].fields;
  const missing = fields.filter((f) => f.required && !map[f.key]);
  return (
    <Modal open title="نگاشت ستون‌های فایل" onCancel={onClose} okText="تأیید نگاشت و اعتبارسنجی" cancelText="بستن" okButtonProps={{ disabled: missing.length > 0 }}
      onOk={async () => {
        try {
          await api.post(`/imports/${data.batch.id}/mapping`, { columnMap: Object.fromEntries(Object.entries(map).filter(([, v]) => v)), ...(save ? { saveProfileName: save } : {}) });
          onDone(data.batch.id);
        } catch (e) { message.error(errMsg(e)); }
      }}>
      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="عنوان ستون‌های فایل با قالب شناخته‌شده نمی‌خواند؛ هر فیلد را به ستون مربوط وصل کنید." />
      <Form layout="vertical">
        {fields.map((f) => (
          <Form.Item key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} style={{ marginBottom: 8 }}>
            <Select allowClear value={map[f.key]} onChange={(v) => setMap((m) => ({ ...m, [f.key]: v ?? '' }))} options={data.info.headers.filter(Boolean).map((h) => ({ value: h, label: h }))} />
          </Form.Item>
        ))}
        <Input placeholder="ذخیره به‌عنوان پروفایل برای دفعات بعد (نام اختیاری)" value={save} onChange={(e) => setSave(e.target.value)} maxLength={100} />
      </Form>
    </Modal>
  );
}

function BatchDrawer({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }): JSX.Element {
  const b = useApi(() => (id ? api.get<ImportBatchDto>(`/imports/${id}`) : Promise.resolve(null)), [id], 3000);
  const errors = useApi(() => (id ? api.get<Page<ImportErrorDto>>(`/imports/${id}/errors`, { limit: 50 }) : Promise.resolve(null)), [id, b.data?.status]);
  const unknown = useApi(() => (id ? api.get<UnknownTerminalDto[]>(`/imports/${id}/unknown-terminals`) : Promise.resolve([])), [id, b.data?.status]);
  const [mode, setMode] = useState<'strict' | 'skip_invalid'>('strict');
  const nav = useNavigate();
  const d = b.data;
  const act = async (path: string, body?: unknown): Promise<void> => {
    try { await api.post(path, body); b.reload(); onChanged(); } catch (e) { message.error(errMsg(e), 6); }
  };
  return (
    <Drawer title={d ? `دسته‌ی ${d.id} — ${d.fileName}` : '...'} open={id !== null} onClose={onClose} width={720} destroyOnClose>
      {d && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space wrap>
            <Tag color={STATUS_FA[d.status].color}>{STATUS_FA[d.status].text}</Tag>
            {d.stage && <Tag>{d.stage}</Tag>}
            {BUSY.includes(d.status) && <Progress percent={Math.round(d.progress)} style={{ width: 200 }} />}
          </Space>
          <Space wrap>
            <Tag>کل: {fmtNum(d.totalRows)}</Tag><Tag color="green">معتبر: {fmtNum(d.validRows)}</Tag><Tag color="red">خطا: {fmtNum(d.errorRows)}</Tag>
            {d.insertedRows !== null && <Tag>جدید: {fmtNum(d.insertedRows)}</Tag>}{d.updatedRows !== null && <Tag>به‌روز: {fmtNum(d.updatedRows)}</Tag>}
            {d.unchangedRows !== null && <Tag>بدون تغییر: {fmtNum(d.unchangedRows)}</Tag>}
            {d.mergeSummary?.infoUpdated ? <Tag color="cyan">اطلاعات ترمینال به‌روز شد: {fmtNum(d.mergeSummary.infoUpdated)}</Tag> : null}
            {d.mergeSummary?.bankChanges ? <Tag color="purple">تغییر بانک: {fmtNum(d.mergeSummary.bankChanges)}</Tag> : null}
            {d.mergeSummary?.banksCreated ? <Tag color="purple">بانک جدید: {fmtNum(d.mergeSummary.banksCreated)}</Tag> : null}
            {d.mergeSummary?.pendingTerminals ? <Tag color="gold" style={{ cursor: 'pointer' }} onClick={() => nav('/pending')}>ترمینال تعریف‌نشده: {fmtNum(d.mergeSummary.pendingTerminals)}</Tag> : null}
          </Space>
          {d.status === 'validated' && (
            <Alert type="info" showIcon message="اعتبارسنجی تمام شد. پس از تأیید، داده ثبت و آمار بازمحاسبه می‌شود."
              action={<Space>
                <Select size="small" value={mode} onChange={setMode} options={[{ value: 'strict', label: 'سخت‌گیرانه (با خطا ثبت نشود)' }, { value: 'skip_invalid', label: 'ردیف‌های خطادار نادیده' }]} />
                <Button type="primary" size="small" onClick={() => { void act(`/imports/${d.id}/commit`, { mode }); }}>تأیید و ثبت</Button></Space>} />
          )}
          <Space>
            {['uploaded', 'needs_mapping', 'validated', 'failed'].includes(d.status) && <Button danger onClick={() => { void act(`/imports/${d.id}/cancel`); }}>لغو</Button>}
            {d.status === 'failed' && <Button onClick={() => { void act(`/imports/${d.id}/retry`); }}>تلاش مجدد</Button>}
            {(d.errorRows ?? 0) > 0 && <Button icon={<DownloadOutlined />} onClick={() => { void api.download(`/imports/${d.id}/errors.xlsx`, undefined, `import-${d.id}-errors.xlsx`); }}>گزارش خطاها (اکسل)</Button>}
          </Space>
          <Tabs items={[
            { key: 'e', label: `خطاها (${fmtNum(errors.data?.items.length ?? 0)})`, children: (
              <Table size="small" rowKey={(r) => `${r.rowNo}:${r.code}:${r.columnName}`} pagination={{ pageSize: 10 }} dataSource={errors.data?.items ?? []} columns={[
                { title: 'ردیف', dataIndex: 'rowNo' }, { title: 'ستون', dataIndex: 'columnName' }, { title: 'پیام', dataIndex: 'message' }]} />) },
            { key: 'u', label: `ترمینال ناشناخته (${fmtNum(unknown.data?.length ?? 0)})`, children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                {(unknown.data?.length ?? 0) > 0 && (
                  <Alert type="warning" showIcon
                    message={`${fmtNum(unknown.data?.filter((u) => u.hasActivity).length ?? 0)} ترمینال دارای تراکنش در سامانه تعریف نشده است`}
                    description="بعد از ثبت نهایی این فایل، این ترمینال‌ها (با تراکنش‌هایشان) در صفحه‌ی «تعریف‌نشده‌ها» نگه داشته می‌شوند تا پشتیبان تعیین کنید."
                    action={<Button size="small" type="primary" onClick={() => nav('/pending')}>رفتن به تعریف‌نشده‌ها</Button>} />
                )}
                <Table size="small" rowKey="terminalNo" pagination={{ pageSize: 10 }} dataSource={unknown.data ?? []} scroll={{ x: 'max-content' }} columns={[
                  { title: 'شماره ترمینال', dataIndex: 'terminalNo' },
                  { title: 'فروشگاه', dataIndex: 'shopName', render: (v: string | null) => v ?? '—' },
                  { title: 'موبایل', dataIndex: 'phone', render: (v: string | null) => v ?? '—' },
                  { title: 'بانک', dataIndex: 'bankName', render: (v: string | null) => v ?? '—' },
                  { title: 'ردیف', dataIndex: 'rowsCount' },
                  { title: 'مبلغ خرید', dataIndex: 'totalAmount', render: fmtNum }, { title: 'مبلغ کل', dataIndex: 'totalAllAmount', render: fmtNum },
                  { title: 'فعال', dataIndex: 'hasActivity', render: (v: boolean) => (v ? <Tag color="red">دارای تراکنش</Tag> : <Tag>بدون تراکنش</Tag>) },
                ]} />
              </Space>) },
          ]} />
        </Space>
      )}
    </Drawer>
  );
}
