import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input } from 'antd';
import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BrandMark, GeoPattern } from '../components/Brand';
import { useAuth } from '../auth';
import { ApiError } from '../lib/api';
import { errMsg } from '../lib/hooks';

/** ورود با نام کاربری و رمز. «کد دفتر» فقط اگر یک نام کاربری در چند دفتر باشد از کاربر خواسته می‌شود. */
export default function Login(): JSX.Element {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needOffice, setNeedOffice] = useState(false);
  if (user) return <Navigate to="/" replace />;
  return (
    <div className="login-wrap">
      <section className="login-brand">
        <GeoPattern />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><BrandMark size={44} /><b style={{ fontSize: 18 }}>پشتیبانی پوز</b></div>
        <div>
          <h2>هر ترمینال،<br /><span>یک تصویر روشن</span> از وضعیت.</h2>
          <p>روند تراکنش‌ها، افت فعالیت، پیشرفت پروژه‌ها و پیش‌بینی ماه‌های آینده را برای هر ستاد و هر پشتیبان در یک‌جا ببینید.</p>
          <div className="login-points">
            <div><i />آمار ماهانه با تفکیک ستاد، پشتیبان، بانک و مسیر</div>
            <div><i />هشدار زودهنگام افت تراکنش و عقب‌افتادگی پروژه</div>
            <div><i />پیش‌بینی فروش با بازه‌ی اطمینان</div>
          </div>
        </div>
        <small style={{ color: '#7e969a' }}>نسخه‌ی سازمانی · داده‌ها فقط در شبکه‌ی داخلی شما می‌ماند</small>
      </section>

      <section className="login-form-side">
        <div className="login-card">
          <h3>خوش آمدید</h3>
          <div className="sub">برای ورود، نام کاربری و رمز عبور را وارد کنید.</div>
          {err && <Alert type={needOffice ? 'warning' : 'error'} message={err} showIcon style={{ marginBottom: 16 }} />}
          <Form layout="vertical" requiredMark={false} size="large" onFinish={async (v: { username: string; password: string; office?: string }) => {
            setBusy(true); setErr(null);
            try {
              await login(v.office?.trim() || undefined, v.username.trim(), v.password);
              nav('/');
            } catch (e) {
              if (e instanceof ApiError && e.code === 'OFFICE_REQUIRED') setNeedOffice(true);
              setErr(errMsg(e));
            } finally { setBusy(false); }
          }}>
            <Form.Item name="username" label="نام کاربری" rules={[{ required: true, message: 'نام کاربری را وارد کنید' }]}>
              <Input prefix={<UserOutlined />} style={{ direction: 'ltr', textAlign: 'right' }} autoFocus autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="رمز عبور" rules={[{ required: true, message: 'رمز عبور را وارد کنید' }]}>
              <Input.Password prefix={<LockOutlined />} style={{ direction: 'ltr' }} autoComplete="current-password" />
            </Form.Item>
            {needOffice && (
              <Form.Item name="office" label="کد دفتر" rules={[{ required: true, message: 'کد دفتر را وارد کنید' }]}>
                <Input style={{ direction: 'ltr', textAlign: 'right' }} />
              </Form.Item>
            )}
            <Button type="primary" htmlType="submit" block loading={busy} style={{ height: 44, marginTop: 6, fontWeight: 700 }}>ورود</Button>
          </Form>
        </div>
      </section>
    </div>
  );
}
