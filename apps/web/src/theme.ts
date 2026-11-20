import type { ThemeConfig } from 'antd';

/**
 * تم «مرکب و فیروزه»: سایدبار مرکبی تیره، رنگ اصلی فیروزه‌ای عمیق، تأکید زعفرانی و زمینه‌ی کاغذی گرم.
 * همه‌ی رنگ‌های نمودارها هم از همین‌جا می‌آید تا صفحه‌ها یکدست بمانند.
 */
export const COLORS = {
  ink: '#10242b',
  inkSoft: '#17333b',
  teal: '#0b7a75',
  tealLight: '#d9efec',
  saffron: '#d9962b',
  saffronLight: '#fbefd5',
  paper: '#f4f1ea',
  card: '#fffefb',
  line: '#e6dfd0',
  text: '#1f2d30',
  muted: '#6b7a7d',
  indigo: '#2f4b7c',
  brick: '#c4553d',
  sage: '#7a9e6f',
} as const;

/** پالت سری‌های نمودار */
export const PALETTE = [COLORS.teal, COLORS.saffron, COLORS.indigo, COLORS.brick, COLORS.sage, '#8a6fa8', '#5aa9b8'];
/** طیف نقشه‌ی حرارتی (کم ← زیاد) */
export const HEAT = ['#f4efe2', '#bfe0d8', '#4fa79d', '#0b7a75', '#10303a'];

export const FONT = "'Vazirmatn Variable', Vazirmatn, Tahoma, 'Segoe UI', sans-serif";

export const theme: ThemeConfig = {
  token: {
    fontFamily: FONT,
    colorPrimary: COLORS.teal,
    colorInfo: COLORS.teal,
    colorWarning: COLORS.saffron,
    colorError: COLORS.brick,
    colorSuccess: '#3f8f5f',
    colorTextBase: COLORS.text,
    colorBgLayout: COLORS.paper,
    colorBgContainer: COLORS.card,
    colorBorder: '#d8d0bd',
    colorBorderSecondary: COLORS.line,
    borderRadius: 10,
    borderRadiusLG: 14,
    boxShadowTertiary: '0 1px 2px rgba(16,36,43,.05), 0 4px 14px rgba(16,36,43,.05)',
    controlHeight: 36,
  },
  components: {
    Layout: { siderBg: COLORS.ink, headerBg: 'transparent', bodyBg: COLORS.paper, headerPadding: '0 24px' },
    Menu: {
      darkItemBg: 'transparent', darkSubMenuItemBg: 'transparent', darkItemColor: '#aebfc2', darkItemHoverColor: '#ffffff',
      darkItemHoverBg: 'rgba(255,255,255,.06)', darkItemSelectedBg: 'rgba(217,150,43,.16)', darkItemSelectedColor: '#f3c875',
      itemMarginInline: 10, itemBorderRadius: 10, itemHeight: 44,
    },
    Card: { headerFontSize: 15, headerBg: 'transparent', paddingLG: 20 },
    Table: { headerBg: '#f1ecde', headerColor: '#34464a', rowHoverBg: '#faf5e6', borderColor: COLORS.line, headerSplitColor: 'transparent' },
    Tabs: { inkBarColor: COLORS.saffron, itemSelectedColor: COLORS.teal, itemHoverColor: COLORS.teal },
    Button: { primaryShadow: 'none', defaultShadow: 'none', fontWeight: 500 },
    Tag: { defaultBg: '#f1ecde' },
    Drawer: { colorBgElevated: COLORS.card },
    Segmented: { itemSelectedBg: COLORS.teal, itemSelectedColor: '#fff', trackBg: '#ece6d6' },
  },
};
