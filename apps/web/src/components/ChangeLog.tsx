import { Empty, Space, Tag, Timeline } from 'antd';
import type { AuditDto } from '@pos/shared';
import { jalaliDateTime, jalaliText } from '../lib/format';
import { useRef2 } from '../refdata';

const FIELD_FA: Record<string, string> = {
  terminalNo: 'شماره ترمینال', shopName: 'نام فروشگاه', ownerName: 'نام مالک', phone: 'موبایل/تلفن', address: 'آدرس',
  installedAt: 'تاریخ نصب', returnedAt: 'تاریخ انصراف', returnReason: 'دلیل انصراف', status: 'وضعیت',
  supporterId: 'پشتیبان', unitId: 'ستاد', routeGroupId: 'مسیر', bankId: 'بانک', effectiveDate: 'تاریخ اعمال',
};
const ACTION_FA: Record<string, { text: string; color: string }> = {
  create: { text: 'ایجاد', color: 'green' }, update: { text: 'ویرایش', color: 'blue' }, assign: { text: 'تعویض تخصیص', color: 'purple' },
  import: { text: 'ایمپورت فایل', color: 'cyan' }, delete: { text: 'حذف', color: 'red' }, setting: { text: 'تنظیم', color: 'default' },
};
const HIDDEN = new Set(['source']);

/** نمایش یک مقدار تغییر؛ شناسه‌ها به نام و تاریخ‌ها شمسی می‌شوند */
function useFormat(): (key: string, v: unknown) => string {
  const ref = useRef2();
  return (key, v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (key === 'supporterId') return ref.supporterName(Number(v));
    if (key === 'unitId') return ref.unitName(Number(v));
    if (key === 'routeGroupId') return Number(v) ? ref.routeName(Number(v)) : '—';
    if (key === 'bankId') return Number(v) ? ref.bankName(Number(v)) : '—';
    if (key === 'status') return v === 'returned' ? 'برگشتی' : v === 'active' ? 'فعال' : String(v);
    if (['installedAt', 'returnedAt', 'effectiveDate'].includes(key) && typeof v === 'string') return jalaliText(v);
    return String(v);
  };
}

/** تاریخچه‌ی تغییرات یک ترمینال: چه چیزی، از چه به چه، چه کسی، کِی و از کدام فایل/منبع */
export function ChangeLog({ items }: { items: AuditDto[] }): JSX.Element {
  const fmt = useFormat();
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="تغییری ثبت نشده است" />;
  return (
    <Timeline items={items.map((r) => {
      const act = ACTION_FA[r.action] ?? { text: r.action, color: 'default' };
      const keys = Object.keys(r.after ?? r.before ?? {}).filter((k) => !HIDDEN.has(k));
      return {
        color: act.color === 'default' ? 'gray' : act.color,
        children: (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Space wrap size={6}>
              <Tag color={act.color}>{act.text}</Tag>
              <b>{r.userName ?? 'سیستم'}</b>
              <span style={{ color: '#888', fontSize: 12 }}>{jalaliDateTime(r.createdAt)}</span>
              {r.batchId && <Tag bordered={false}>فایل: {r.batchFileName ?? `#${r.batchId}`}</Tag>}
            </Space>
            {keys.map((k) => (
              <div key={k} style={{ fontSize: 13 }}>
                <span style={{ color: '#666' }}>{FIELD_FA[k] ?? k}: </span>
                {r.before && k in r.before ? <><s style={{ color: '#a33' }}>{fmt(k, r.before[k])}</s> ← </> : null}
                <b>{fmt(k, (r.after ?? {})[k])}</b>
              </div>
            ))}
          </Space>
        ),
      };
    })} />
  );
}
