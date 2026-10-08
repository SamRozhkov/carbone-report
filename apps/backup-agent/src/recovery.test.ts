import { describe, expect, it } from 'vitest';
import { codeMatches, generateCode, hashCode } from './recovery';

describe('коды восстановления', () => {
  it('12 символов base32 в виде XXXX-XXXX-XXXX', () => {
    for (let i = 0; i < 50; i++)
      expect(generateCode()).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });
  it('символ — младшие 5 бит байта из randomBytes (256 делится на 32 — без перекоса)', () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 25, 26, 31, 32]);
    expect(generateCode(() => bytes)).toBe('ABCD-EFGH-Z27A');
  });
  it('хранится sha256; ввод сравнивается без учёта регистра, пробелов и дефисов', () => {
    const hash = hashCode('ABCD-EFGH-Z27A');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(codeMatches(' abcd efgh-z27a ', hash)).toBe(true);
    expect(codeMatches('ABCDEFGHZ27A', hash)).toBe(true);
    expect(codeMatches('ABCD-EFGH-Z27B', hash)).toBe(false);
    expect(codeMatches('', hash)).toBe(false);
  });
});
