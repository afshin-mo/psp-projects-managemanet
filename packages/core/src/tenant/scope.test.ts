import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SqlParams } from '../db/sql';
import { scopeWhere, type TenantContext } from './scope';

const base: TenantContext = { userId: 1, officeId: 7, role: 'office_manager', unitId: null, supporterId: null };
const cols = { office: 't.office_id', unit: 't.unit', supporter: 't.sup' };

function run(ctx: TenantContext, c: Parameters<typeof scopeWhere>[2] = cols) {
  const p = new SqlParams();
  return { where: scopeWhere(ctx, p, c), values: p.values };
}

describe('scopeWhere (فیلتر مرکزی tenant و نقش)', () => {
  it('مدیر دفتر و ادمین داده: فقط دفتر', () => {
    for (const role of ['office_manager', 'data_admin'] as const) {
      expect(run({ ...base, role })).toEqual({ where: ['t.office_id = $1'], values: [7] });
    }
  });

  it('مسئول ستاد: دفتر + ستاد خودش', () => {
    expect(run({ ...base, role: 'unit_head', unitId: 3 })).toEqual({
      where: ['t.office_id = $1', 't.unit = $2'], values: [7, 3],
    });
  });

  it('پشتیبان: دفتر + پشتیبان خودش', () => {
    expect(run({ ...base, role: 'supporter', unitId: 3, supporterId: 9 })).toEqual({
      where: ['t.office_id = $1', 't.sup = $2'], values: [7, 9],
    });
  });

  it('پشتیبان روی جدول بدون ستون پشتیبان، ستاد خودش را می‌بیند', () => {
    expect(run({ ...base, role: 'supporter', unitId: 3, supporterId: 9 }, { office: 'u.office_id', unit: 'u.id' }).where)
      .toEqual(['u.office_id = $1', 'u.id = $2']);
  });

  it('نقش بدون شناسه‌ی ستاد/پشتیبان هیچ ردیفی نمی‌بیند (fail-closed)', () => {
    expect(run({ ...base, role: 'unit_head', unitId: null }).where).toContain('FALSE');
    expect(run({ ...base, role: 'supporter', supporterId: null }).where).toContain('FALSE');
  });

  it('نبود ستون لازم برای نقش محدود، خطا می‌دهد نه افشای داده', () => {
    expect(() => run({ ...base, role: 'unit_head', unitId: 3 }, { office: 't.office_id' })).toThrow();
  });

  it('داده‌ی مرجع (officeWide) برای همه‌ی نقش‌ها فقط به دفتر محدود است', () => {
    expect(run({ ...base, role: 'supporter', supporterId: 9 }, { office: 'b.office_id', officeWide: true }).where)
      .toEqual(['b.office_id = $1']);
  });
});

describe('قاعده‌ی معماری: همه‌ی Repositoryها ctx می‌گیرند', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../repos');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('پوشه‌ی repos خالی نیست', () => expect(files.length).toBeGreaterThan(0));

  for (const file of files) {
    it(`${file}: پارامتر اول هر تابع export شده «ctx: TenantContext» است`, () => {
      const src = readFileSync(path.join(dir, file), 'utf8');
      const re = /export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\(\s*([^,)]*)/g;
      const bad: string[] = [];
      let count = 0;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        count += 1;
        if (!/^ctx:\s*TenantContext$/.test((m[2] ?? '').trim())) bad.push(m[1] ?? '?');
      }
      expect(count).toBeGreaterThan(0);
      expect(bad).toEqual([]);
    });
  }
});
