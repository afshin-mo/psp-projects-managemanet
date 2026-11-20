import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { csvLine, csvRows, detectDelimiter } from './csv';

async function parse(chunks: Array<string | Buffer>): Promise<string[][]> {
  const out: string[][] = [];
  for await (const r of csvRows(Readable.from(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c, 'utf8') : c))))) out.push(r);
  return out;
}

describe('CSV', () => {
  it('ساده، CRLF، بدون خط جدید پایانی', async () => {
    expect(await parse(['a,b,c\n1,2,3\n'])).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(await parse(['a,b\r\n1,2'])).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('CRLF بین دو chunk', async () => {
    expect(await parse(['a,b\r', '\n1,2\r\n'])).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('نقل‌قول، "" و خط جدید داخل فیلد', async () => {
    expect(await parse(['x,"he said ""hi""",\n"l1\nl2",,z\n'])).toEqual([['x', 'he said "hi"', ''], ['l1\nl2', '', 'z']]);
  });
  it('BOM و جداکننده‌ی ; و TAB', async () => {
    expect(await parse(['\uFEFFشماره;مبلغ\n01;100\n'])).toEqual([['شماره', 'مبلغ'], ['01', '100']]);
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
  });
  it('کاراکتر چندبایتی بین دو chunk نمی‌شکند', async () => {
    const b = Buffer.from('نام,مبلغ\nعلی,5\n');
    expect(await parse([b.subarray(0, 5), b.subarray(5)])).toEqual([['نام', 'مبلغ'], ['علی', '5']]);
  });
  it('صفر اول حفظ می‌شود', async () => {
    expect((await parse(['no\n00123\n']))[1]).toEqual(['00123']);
  });
  it('csvLine: NULL، escape، NUL', () => {
    expect(csvLine([1, 'a"b', null, '', true, 'x\u0000y', 5n])).toBe('1,"a""b",,,t,"xy",5\n');
  });
});
