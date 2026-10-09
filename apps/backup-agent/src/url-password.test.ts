import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { withPassword } from './url-password';

const NASTY = 'p@ss/w:rd#%?&=+ пароль';

describe('withPassword', () => {
  it('без пароля URL не меняется', () => {
    expect(withPassword('redis://:pw@redis:6379', undefined)).toBe('redis://:pw@redis:6379');
  });
  it('ioredis получает пароль со спецсимволами без искажений', () => {
    const r = new Redis(withPassword('redis://redis.example:6380/2', NASTY), { lazyConnect: true });
    expect(r.options).toMatchObject({ password: NASTY, host: 'redis.example', port: 6380, db: 2 });
    r.disconnect();
  });
  it('не URL — ошибка без пароля в тексте', () => {
    expect(() => withPassword('not a url', 'secret-value')).toThrow('нужен URL');
    expect(() => withPassword('not a url', 'secret-value')).not.toThrow(/secret-value/);
  });
});
