import { describe, expect, it } from 'vitest';
import { ACCESS_PRESETS, PERMISSION_KEYS, ROLE_DEFAULT_PERMISSIONS, effectivePermissions, permissionCeiling } from './permissions';
import { lookupTerminalsSchema } from './schemas/terminal';
import { patchUserSchema } from './schemas/users';

describe('سطح دسترسی', () => {
  it('مدیر دفتر همیشه همه‌ی مجوزها را دارد، حتی اگر چیزی ذخیره شده باشد', () => {
    expect(effectivePermissions('office_manager', null)).toEqual(PERMISSION_KEYS);
    expect(effectivePermissions('office_manager', [])).toEqual(PERMISSION_KEYS);
  });
  it('null = پیش‌فرض نقش', () => {
    expect(effectivePermissions('supporter', null)).toEqual([...ROLE_DEFAULT_PERMISSIONS.supporter]);
  });
  it('مجوز ذخیره‌شده فقط در سقف نقش اثر دارد', () => {
    const eff = effectivePermissions('supporter', ['analytics.view', 'users.manage', 'imports.manage']);
    expect(eff).toEqual(['analytics.view']);
  });
  it('آرایه‌ی خالی = بدون هیچ دسترسی (غیر مدیر)', () => {
    expect(effectivePermissions('data_admin', [])).toEqual([]);
  });
  it('نقش ناشناخته (ستاد مرکزی) هیچ مجوزی ندارد', () => {
    expect(permissionCeiling('system_admin')).toEqual([]);
    expect(effectivePermissions('system_admin', null)).toEqual([]);
  });
  it('فقط مدیر دفتر مدیریت کاربران دارد و همه‌ی پیش‌فرض‌ها کلید معتبرند', () => {
    for (const [role, perms] of Object.entries(ROLE_DEFAULT_PERMISSIONS)) {
      for (const p of perms) expect(PERMISSION_KEYS).toContain(p);
      expect(perms.includes('users.manage')).toBe(role === 'office_manager');
    }
  });
  it('سطح‌های آماده در سقف پشتیبان معتبرند', () => {
    for (const preset of ACCESS_PRESETS) for (const p of preset.permissions ?? []) expect(PERMISSION_KEYS).toContain(p);
  });
});

describe('اسکیماها', () => {
  it('patchUser کلید ناشناخته را رد و null را می‌پذیرد', () => {
    expect(patchUserSchema.safeParse({ permissions: ['nope'] }).success).toBe(false);
    expect(patchUserSchema.safeParse({ permissions: null }).success).toBe(true);
    expect(patchUserSchema.safeParse({ permissions: ['scores.view'] }).success).toBe(true);
  });
  it('lookupTerminals شماره‌ها را نرمال و یکتا می‌کند', () => {
    const r = lookupTerminalsSchema.parse({ terminalNos: ['۱۲۳', '123', ' 456 ', ''] });
    expect(r.terminalNos).toEqual(['123', '456']);
    expect(lookupTerminalsSchema.safeParse({ terminalNos: [''] }).success).toBe(false);
  });
});
