import { Alert, Input, Modal, Space, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { fmtNum } from '../lib/format';

export interface BulkLine { name: string; code?: string }

/** هر خط یک مورد؛ برای بانک می‌توان بعد از نام، با Tab یا «؛» یا «;» کد را هم نوشت. تکراری‌های داخل فهرست حذف می‌شوند. */
export function parseLines(text: string, withCode: boolean): BulkLine[] {
  const seen = new Set<string>();
  const out: BulkLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [name, code] = withCode ? line.split(/\t|؛|;/).map((x) => x.trim()) : [line, undefined];
    if (!name) continue;
    const key = name.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: name.replace(/\s+/g, ' '), ...(code ? { code } : {}) });
  }
  return out;
}

interface Props {
  open: boolean;
  title: string;
  withCode?: boolean;
  existing: string[];
  onClose: () => void;
  onSubmit: (lines: BulkLine[]) => Promise<void>;
}

/** افزودن گروهی: فهرست را (مثلاً از اکسل) در کادر بچسبانید؛ پیش‌نمایش موارد جدید و تکراری را می‌بینید. */
export function BulkAddModal({ open, title, withCode = false, existing, onClose, onSubmit }: Props): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = useMemo(() => parseLines(text, withCode), [text, withCode]);
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const have = useMemo(() => new Set(existing.map(norm)), [existing]);
  const fresh = lines.filter((l) => !have.has(norm(l.name)));
  return (
    <Modal open={open} title={title} onCancel={onClose} okText={`ثبت ${fmtNum(fresh.length)} مورد`} cancelText="انصراف" destroyOnClose
      okButtonProps={{ disabled: fresh.length === 0, loading: busy }}
      onOk={async () => {
        setBusy(true);
        try { await onSubmit(fresh); setText(''); } finally { setBusy(false); }
      }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          هر خط یک مورد{withCode ? ' (در صورت نیاز: نام، سپس Tab یا «؛» و بعد کد)' : ''}. می‌توانید ستونی از اکسل را مستقیم بچسبانید.
        </Typography.Text>
        <Input.TextArea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'مورد اول\nمورد دوم\n...'} />
        {lines.length > 0 && (
          <Alert type={fresh.length > 0 ? 'info' : 'warning'} showIcon
            message={`${fmtNum(fresh.length)} مورد جدید`}
            description={lines.length - fresh.length > 0 ? `${fmtNum(lines.length - fresh.length)} مورد از قبل وجود دارد و رد می‌شود.` : undefined} />
        )}
      </Space>
    </Modal>
  );
}
