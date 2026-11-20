import { describe, expect, it } from 'vitest';
import { buildTerminalSearchNorm, escapeLike, normalizeSearchText, normalizeTerminalNo, toEnglishDigits } from './text';
import { isValidIsoDate, todayInTehran } from '../dates';

describe('نرمال‌سازی', () => {
  it('ارقام فارسی و عربی → انگلیسی', () => {
    expect(toEnglishDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(toEnglishDigits('٠١٢٣٤٥٦٧٨٩ab')).toBe('0123456789ab');
  });

  it('شماره ترمینال: صفر اول، فاصله و نیم‌فاصله', () => {
    expect(normalizeTerminalNo(' ۰۰۱۲ ۳\u200c۴ ')).toBe('00123' + '4');
    expect(normalizeTerminalNo('0012')).toBe('0012');
  });

  it('متن جستجو: ی/ک عربی، نیم‌فاصله، اعراب، فاصله‌ی تکراری', () => {
    expect(normalizeSearchText('عليرضا')).toBe(normalizeSearchText('علیرضا'));
    expect(normalizeSearchText('كوروش')).toBe('کوروش');
    expect(normalizeSearchText('فروشگاه\u200cها   مرکزی')).toBe('فروشگاه ها مرکزی');
    expect(normalizeSearchText('محمَّد')).toBe('محمد');
  });

  it('search_norm شامل شماره، فروشگاه و مالک است', () => {
    const n = buildTerminalSearchNorm({ terminalNo: '۰۱۲', shopName: 'فروشگاه كوروش', ownerName: null });
    expect(n).toBe('012 فروشگاه کوروش');
  });

  it('escapeLike کاراکترهای ویژه را escape می‌کند', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });
});

describe('تاریخ', () => {
  it('اعتبار تاریخ ISO', () => {
    expect(isValidIsoDate('2025-02-28')).toBe(true);
    expect(isValidIsoDate('2025-02-30')).toBe(false);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('25-1-1')).toBe(false);
  });

  it('امروز به وقت تهران مستقل از UTC است', () => {
    // 20:45 UTC = 00:15 تهران روز بعد
    expect(todayInTehran(new Date('2025-06-21T20:45:00Z'))).toBe('2025-06-22');
    expect(todayInTehran(new Date('2025-06-21T10:00:00Z'))).toBe('2025-06-21');
  });
});
