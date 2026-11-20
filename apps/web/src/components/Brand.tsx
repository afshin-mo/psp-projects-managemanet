import { COLORS } from '../theme';

/** نشان برنامه: ترمینال پوز با لبه‌ی زعفرانی */
export function BrandMark({ size = 38 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="1" y="1" width="38" height="38" rx="11" fill={COLORS.saffron} />
      <rect x="10" y="7" width="20" height="26" rx="4" fill={COLORS.ink} />
      <rect x="13" y="10" width="14" height="6" rx="1.5" fill="#f3c875" />
      <g fill="#8fb9b4">
        <circle cx="15" cy="21" r="1.5" /><circle cx="20" cy="21" r="1.5" /><circle cx="25" cy="21" r="1.5" />
        <circle cx="15" cy="26" r="1.5" /><circle cx="20" cy="26" r="1.5" /><circle cx="25" cy="26" r="1.5" />
      </g>
    </svg>
  );
}

/** الگوی هندسی هشت‌پر برای پس‌زمینه‌ی ورود (خطوط بسیار کم‌رنگ) */
export function GeoPattern(): JSX.Element {
  return (
    <svg className="pattern" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <pattern id="khatam" width="88" height="88" patternUnits="userSpaceOnUse">
          <g fill="none" stroke="#f3c875" strokeWidth="1" opacity=".16">
            <rect x="24" y="24" width="40" height="40" />
            <rect x="24" y="24" width="40" height="40" transform="rotate(45 44 44)" />
            <circle cx="44" cy="44" r="9" />
          </g>
          <g fill="none" stroke="#7fc4bb" strokeWidth="1" opacity=".1"><path d="M0 0L22 22M88 0L66 22M0 88L22 66M88 88L66 66" /></g>
        </pattern>
        <linearGradient id="fade" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#10242b" stopOpacity="0" /><stop offset="1" stopColor="#10242b" stopOpacity=".85" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#khatam)" />
      <rect width="100%" height="100%" fill="url(#fade)" />
    </svg>
  );
}
