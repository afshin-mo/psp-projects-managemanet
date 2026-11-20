import { CloseCircleFilled } from '@ant-design/icons';
import { Input } from 'antd';
import gregorian from 'react-date-object/calendars/gregorian';
import persian from 'react-date-object/calendars/persian';
import gregorian_en from 'react-date-object/locales/gregorian_en';
import persian_fa from 'react-date-object/locales/persian_fa';
import DatePicker, { DateObject } from 'react-multi-date-picker';

/** فیلد نمایشی که تقویم شمسی را باز می‌کند؛ props را خود کتابخانه تزریق می‌کند. */
function AntInput({ value, onFocus, placeholder, hasValue, onClear, allowClear }: {
  value?: string; onFocus?: () => void; placeholder?: string; hasValue?: boolean; onClear?: () => void; allowClear?: boolean;
}): JSX.Element {
  return (
    <Input
      readOnly value={value ?? ''} placeholder={placeholder} onFocus={onFocus} onClick={onFocus} style={{ cursor: 'pointer', direction: 'rtl' }}
      suffix={allowClear && hasValue ? <CloseCircleFilled style={{ color: '#b9b2a2', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); onClear?.(); }} /> : <span />}
    />
  );
}

const toPicker = (iso: string | undefined): DateObject | undefined => {
  if (!iso) return undefined;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new DateObject({ year: y, month: m, day: d, calendar: gregorian, locale: gregorian_en }).convert(persian, persian_fa);
};

/**
 * انتخاب تاریخ با تقویم شمسی (react-multi-date-picker: ماه‌های فارسی، شروع هفته از شنبه، ارقام فارسی).
 * مقدار بیرونی همیشه ISO میلادی (YYYY-MM-DD) است؛ خالی = undefined.
 */
export function JalaliDateField({ value, onChange, placeholder = 'انتخاب تاریخ', allowClear = true }: {
  value?: string | undefined; onChange: (iso: string | undefined) => void; placeholder?: string; allowClear?: boolean;
}): JSX.Element {
  return (
    <DatePicker
      value={toPicker(value) ?? null}
      onChange={(d) => {
        if (!d || Array.isArray(d)) { onChange(undefined); return; }
        onChange((d as DateObject).convert(gregorian, gregorian_en).format('YYYY-MM-DD'));
      }}
      calendar={persian}
      locale={persian_fa}
      format="YYYY/MM/DD"
      weekStartDayIndex={6}
      onOpenPickNewDate={false}
      editable={false}
      portal
      zIndex={2100}
      containerStyle={{ width: '100%' }}
      calendarPosition="bottom-right"
      className="pos-cal"
      render={<AntInput placeholder={placeholder} hasValue={!!value} allowClear={allowClear} onClear={() => onChange(undefined)} />}
    />
  );
}
