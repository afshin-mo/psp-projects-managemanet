import { Alert, Empty, Spin, Tag } from 'antd';
import type { ReactNode } from 'react';
import type { LagLevel, ProjectTerminalStatus } from '@pos/shared';
import { PROJECT_TERMINAL_STATUS_FA } from '@pos/shared';

export function Loading({ loading, error, children }: { loading: boolean; error: string | null; children: ReactNode }): JSX.Element {
  if (error) return <Alert type="error" showIcon message={error} />;
  return <Spin spinning={loading}>{children}</Spin>;
}

export const NoData = (): JSX.Element => <Empty description="داده‌ای نیست" image={Empty.PRESENTED_IMAGE_SIMPLE} />;

export const LAG_FA: Record<LagLevel, { text: string; color: string }> = {
  completed: { text: 'تکمیل', color: 'green' },
  on_track: { text: 'طبق برنامه', color: 'blue' },
  at_risk: { text: 'در معرض عقب‌افتادگی', color: 'gold' },
  behind: { text: 'عقب‌افتاده', color: 'orange' },
  overdue: { text: 'گذشته از سررسید', color: 'red' },
  not_started_yet: { text: 'هنوز شروع نشده', color: 'default' },
};
export const LagTag = ({ level }: { level: LagLevel }): JSX.Element => <Tag color={LAG_FA[level].color}>{LAG_FA[level].text}</Tag>;

const ST_COLOR: Record<ProjectTerminalStatus, string> = { not_started: 'default', in_progress: 'processing', done: 'success', failed: 'error' };
export const StatusTag = ({ status }: { status: ProjectTerminalStatus }): JSX.Element =>
  <Tag color={ST_COLOR[status]}>{PROJECT_TERMINAL_STATUS_FA[status]}</Tag>;
