import { describe, expect, it } from 'vitest';
import { fillByteRange, insertCms, signedRanges } from './embed';

/** Фрагмент PDF с заглушками в том виде, как их пишет pdf-lib. */
const sample = (n: number) =>
  Buffer.from(
    `%PDF-1.7\n1 0 obj\n<< /ByteRange [ 0 /********** /********** /********** ] /Contents <${'0'.repeat(n * 2)}> >>\nendobj\n%%EOF\n`,
    'latin1',
  );

describe('ByteRange и /Contents (§39.4)', () => {
  it('ByteRange покрывает весь файл, кроме значения /Contents; длина файла не меняется', () => {
    const pdf = sample(16);
    const len = pdf.length;
    const hole = fillByteRange(pdf, 16);
    expect(pdf.length).toBe(len);
    expect(pdf.subarray(hole.start, hole.end).toString('latin1')).toBe(`<${'0'.repeat(32)}>`);
    const m = /\/ByteRange \[(0 \d+ \d+ \d+)\] *\/Contents/.exec(pdf.toString('latin1'))!;
    expect(m[1]).toBe(`0 ${hole.start} ${hole.end} ${len - hole.end}`);
    const [a, b] = signedRanges(pdf, hole);
    expect(a.length + b.length).toBe(len - (hole.end - hole.start));
  });

  it('CMS вписывается шестнадцатерично с дополнением нулями', () => {
    const pdf = sample(8);
    const hole = fillByteRange(pdf, 8);
    insertCms(pdf, hole, Uint8Array.from([0xab, 0xcd]));
    expect(pdf.subarray(hole.start, hole.end).toString('latin1')).toBe(`<ABCD${'0'.repeat(12)}>`);
  });

  it('CMS больше места — ошибка, файл не тронут', () => {
    const pdf = sample(2);
    const hole = fillByteRange(pdf, 2);
    const before = Buffer.from(pdf);
    expect(() => insertCms(pdf, hole, new Uint8Array(3))).toThrow('CMS не помещается в /Contents');
    expect(pdf.equals(before)).toBe(true);
  });

  it('нет заглушки или две — ошибка', () => {
    expect(() => fillByteRange(Buffer.from('%PDF-1.7'), 4)).toThrow();
    const two = Buffer.concat([sample(4), sample(4)]);
    expect(() => fillByteRange(two, 4)).toThrow();
  });
});
