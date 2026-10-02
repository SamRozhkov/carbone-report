import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './crypto';

const key = Buffer.alloc(32, 7);

describe('crypto', () => {
  it('шифрует и расшифровывает', () => {
    const enc = encryptSecret('пароль-123', key);
    expect(enc).not.toContain('пароль');
    expect(decryptSecret(enc, key)).toBe('пароль-123');
  });
  it('каждый раз даёт разный шифротекст', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
  });
  it('падает при подмене шифротекста', () => {
    const buf = Buffer.from(encryptSecret('secret', key), 'base64');
    buf[buf.length - 1]! ^= 0xff;
    expect(() => decryptSecret(buf.toString('base64'), key)).toThrow();
  });
  it('падает на чужом ключе', () => {
    expect(() => decryptSecret(encryptSecret('s', key), Buffer.alloc(32, 8))).toThrow();
  });
});
