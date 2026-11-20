import {
  AlertOutlined, CloudUploadOutlined, DashboardOutlined, FundProjectionScreenOutlined,
  LogoutOutlined, ProjectOutlined, SettingOutlined, TableOutlined, TrophyOutlined, WarningOutlined,
} from '@ant-design/icons';
import { Badge, Button, Layout, Menu, Spin, Tag } from 'antd';
import { useEffect, useState } from 'react';
import type { PendingSummaryDto } from '@pos/shared';
import { api } from './lib/api';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BrandMark } from './components/Brand';
import { useAuth } from './auth';
import { RefDataProvider } from './refdata';
import { ROLE_FA } from './lib/format';
import Admin from './pages/Admin';
import Dashboard from './pages/Dashboard';
import Forecast from './pages/Forecast';
import Imports from './pages/Imports';
import Login from './pages/Login';
import Pending from './pages/Pending';
import Scores from './pages/Scores';
import ProjectDetail from './pages/ProjectDetail';
import Projects from './pages/Projects';
import Terminals from './pages/Terminals';

const { Sider, Header, Content } = Layout;

const TITLES: Array<[string, string]> = [
  ['/terminals', 'ترمینال‌ها'], ['/projects', 'پروژه‌ها'], ['/forecast', 'پیش‌بینی فروش'],
  ['/scores', 'امتیاز پشتیبان‌ها'], ['/pending', 'ترمینال‌های تعریف‌نشده'], ['/imports', 'ایمپورت داده'], ['/admin', 'مدیریت و تنظیمات'],
];

function Shell(): JSX.Element {
  const { user, logout, can } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [pendingCount, setPendingCount] = useState(0);
  // تعداد ترمینال‌های فعالِ تعریف‌نشده برای نشان کنار منو (فقط مدیران)
  useEffect(() => {
    if (!can('pending.manage')) return;
    api.get<PendingSummaryDto>('/pending-terminals/summary').then((s) => setPendingCount(s.pendingActive)).catch(() => undefined);
  }, [can, loc.pathname]);
  const items = [
    ...(can('analytics.view') ? [{ key: '/', icon: <DashboardOutlined />, label: 'داشبورد' }] : []),
    { key: '/terminals', icon: <TableOutlined />, label: 'ترمینال‌ها' },
    ...(can('projects.work') ? [{ key: '/projects', icon: <ProjectOutlined />, label: 'پروژه‌ها' }] : []),
    ...(can('forecast.view') ? [{ key: '/forecast', icon: <FundProjectionScreenOutlined />, label: 'پیش‌بینی' }] : []),
    ...(can('scores.view') ? [{ key: '/scores', icon: <TrophyOutlined />, label: 'امتیاز پشتیبان‌ها' }] : []),
    ...(can('pending.manage') ? [{ key: '/pending', icon: <WarningOutlined />, label: <Badge count={pendingCount} size="small" offset={[14, 0]}>تعریف‌نشده‌ها</Badge> }] : []),
    ...(can('imports.manage') ? [{ key: '/imports', icon: <CloudUploadOutlined />, label: 'ایمپورت' }] : []),
    ...((can('masterdata.manage') || can('settings.manage') || can('users.manage')) ? [{ key: '/admin', icon: <SettingOutlined />, label: 'مدیریت' }] : []),
  ];
  const selected = items.map((i) => i.key).filter((k) => (k === '/' ? loc.pathname === '/' : loc.pathname.startsWith(k)));
  const title = TITLES.find(([p]) => loc.pathname.startsWith(p))?.[1] ?? 'داشبورد تحلیلی';
  return (
    <Layout style={{ minHeight: '100%' }}>
      <Sider breakpoint="lg" collapsedWidth={64} theme="dark" width={228} style={{ position: 'relative' }}>
        <div className="pos-sider-brand">
          <BrandMark />
          <span><b>پشتیبانی پوز</b><small>تحلیل و مدیریت ترمینال</small></span>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={selected} items={items} onClick={(e) => nav(e.key)} style={{ border: 'none' }} />
        <div className="pos-sider-foot">{ROLE_FA[user?.role ?? ''] ?? ''}</div>
      </Sider>
      <Layout>
        <Header className="pos-header">
          <h1>{title}</h1>
          <div className="pos-user">
            <span className="pos-avatar">{(user?.fullName ?? '؟').trim().charAt(0)}</span>
            <span style={{ lineHeight: 1.3 }}>
              <b style={{ display: 'block', fontSize: 13 }}>{user?.fullName}</b>
              <Tag bordered={false} color="gold" style={{ margin: 0 }}>{ROLE_FA[user?.role ?? ''] ?? user?.role}</Tag>
            </span>
            <Button type="text" icon={<LogoutOutlined />} onClick={() => { void logout().then(() => nav('/login')); }}>خروج</Button>
          </div>
        </Header>
        <Content className="pos-content"><Outlet /></Content>
      </Layout>
    </Layout>
  );
}

function Protected(): JSX.Element {
  const { user, ready } = useAuth();
  if (!ready) return <Spin style={{ display: 'block', margin: '30vh auto' }} />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'system_admin') {
    return <div style={{ padding: 32 }}><AlertOutlined /> مدیر سامانه به داده‌ی دفترها دسترسی ندارد؛ از اسکریپت‌های مدیریتی استفاده کنید.</div>;
  }
  return <RefDataProvider><Shell /></RefDataProvider>;
}

/** صفحه‌ی اول: داشبورد؛ اگر کاربر مجوز گزارش‌ها را ندارد به ترمینال‌ها می‌رود */
function Home(): JSX.Element {
  const { can } = useAuth();
  return can('analytics.view') ? <Dashboard /> : <Navigate to="/terminals" replace />;
}

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected />}>
        <Route index element={<Home />} />
        <Route path="terminals" element={<Terminals />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:id" element={<ProjectDetail />} />
        <Route path="forecast" element={<Forecast />} />
        <Route path="scores" element={<Scores />} />
        <Route path="pending" element={<Pending />} />
        <Route path="imports" element={<Imports />} />
        <Route path="admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
