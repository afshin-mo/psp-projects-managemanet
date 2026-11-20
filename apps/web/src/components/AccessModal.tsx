import { Alert, Button, Checkbox, Divider, Modal, Space, Tag, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import {
  ACCESS_PRESETS, PERMISSIONS, PERMISSION_GROUPS, effectivePermissions, permissionCeiling, type UserDto,
} from '@pos/shared';
import { api } from '../lib/api';
import { ROLE_FA } from '../lib/format';
import { errMsg } from '../lib/hooks';

/**
 * سطح دسترسی یک کاربر. «پیش‌فرض نقش» = رفتار قبلی؛ در غیر این صورت فقط مجوزهای تیک‌خورده (در سقف نقش).
 * مدیر دفتر همیشه دسترسی کامل دارد. تغییر در چند ثانیه اعمال می‌شود (نیازی به ورود مجدد نیست).
 */
export function AccessModal({ user, onClose, onSaved }: { user: UserDto | null; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [custom, setCustom] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    setCustom(user.permissions !== null);
    setSelected(effectivePermissions(user.role, user.permissions));
  }, [user]);

  if (!user) return <Modal open={false} />;
  const ceiling = new Set<string>(permissionCeiling(user.role));
  const locked = user.role === 'office_manager';

  const applyPreset = (key: string): void => {
    const p = ACCESS_PRESETS.find((x) => x.key === key);
    if (!p) return;
    if (p.permissions === null) { setCustom(false); setSelected([...ceiling]); return; }
    setCustom(true);
    setSelected(p.permissions.filter((x) => ceiling.has(x)));
  };

  return (
    <Modal open title={`سطح دسترسی — ${user.fullName} (${ROLE_FA[user.role] ?? user.role})`} width={640} onCancel={onClose} destroyOnClose
      okText="ذخیره" cancelText="انصراف" okButtonProps={{ disabled: locked, loading: busy }}
      onOk={async () => {
        setBusy(true);
        try {
          await api.patch(`/users/${user.id}`, { permissions: custom ? selected : null });
          message.success('سطح دسترسی ذخیره شد');
          onSaved();
        } catch (e) { message.error(errMsg(e), 6); } finally { setBusy(false); }
      }}>
      {locked ? (
        <Alert type="info" showIcon message="مدیر دفتر همیشه به همه‌ی بخش‌ها دسترسی دارد و قابل محدودسازی نیست." />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          <Space wrap>
            <Typography.Text>سطح‌های آماده:</Typography.Text>
            {ACCESS_PRESETS.map((p) => <Button key={p.key} size="small" onClick={() => applyPreset(p.key)}>{p.label}</Button>)}
            <Tag color={custom ? 'orange' : 'green'}>{custom ? 'دسترسی سفارشی' : 'پیش‌فرض نقش'}</Tag>
          </Space>
          <Typography.Text type="secondary">
            نقش، دامنه‌ی داده را تعیین می‌کند (کل دفتر، یک ستاد یا یک پشتیبان). این مجوزها تعیین می‌کند کاربر چه کارهایی بتواند انجام دهد و
            از سقف نقش بیشتر نمی‌شود. موارد خاکستری برای این نقش قابل‌اعطا نیست.
          </Typography.Text>
          {PERMISSION_GROUPS.map((g) => (
            <div key={g}>
              <Divider orientation="left" style={{ margin: '8px 0' }}>{g}</Divider>
              <Space direction="vertical" size={2}>
                {PERMISSIONS.filter((p) => p.group === g).map((p) => (
                  <Checkbox key={p.key} disabled={!ceiling.has(p.key)} checked={selected.includes(p.key)}
                    onChange={(e) => {
                      setCustom(true);
                      setSelected((s) => (e.target.checked ? [...s, p.key] : s.filter((x) => x !== p.key)));
                    }}>
                    {p.label}{'hint' in p && p.hint ? <Typography.Text type="secondary"> — {p.hint}</Typography.Text> : null}
                  </Checkbox>
                ))}
              </Space>
            </div>
          ))}
        </Space>
      )}
    </Modal>
  );
}
