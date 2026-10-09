import { Redis } from 'ioredis';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withPassword } from './url-password';

const NASTY = 'p@ss/w:rd#%?&=+ пароль';

describe('withPassword', () => {
  it('без пароля URL не меняется', () => {
    expect(withPassword('postgres://app@db:5432/app', undefined)).toBe(
      'postgres://app@db:5432/app',
    );
    expect(withPassword('postgres://app@db:5432/app', '')).toBe('postgres://app@db:5432/app');
  });

  it('pg получает пароль со спецсимволами без искажений, остальное — как было', () => {
    const url = withPassword('postgres://app@db.example:6432/app?sslmode=disable', NASTY);
    const p = (
      new pg.Client({ connectionString: url }) as unknown as {
        connectionParameters: {
          password: string;
          user: string;
          host: string;
          port: number;
          database: string;
        };
      }
    ).connectionParameters;
    expect(p).toMatchObject({
      password: NASTY,
      user: 'app',
      host: 'db.example',
      port: 6432,
      database: 'app',
    });
  });

  it('ioredis получает пароль со спецсимволами без искажений', () => {
    const r = new Redis(withPassword('redis://redis.example:6380/2', NASTY), { lazyConnect: true });
    expect(r.options).toMatchObject({ password: NASTY, host: 'redis.example', port: 6380, db: 2 });
    r.disconnect();
  });

  it('пароль из переменной заменяет пароль в URL', () => {
    const url = withPassword('redis://:old@redis:6379', 'new');
    const r = new Redis(url, { lazyConnect: true });
    expect(r.options.password).toBe('new');
    r.disconnect();
  });

  it('не URL — ошибка без пароля в тексте', () => {
    expect(() => withPassword('not a url', 'secret-value')).toThrow('нужен URL');
    try {
      withPassword('not a url', 'secret-value');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-value');
    }
  });

  it('URL без хоста (db:5432 разбирается как схема db:) — ошибка без пароля в тексте', () => {
    expect(() => withPassword('db:5432', 'secret-value')).toThrow('нужен URL');
    try {
      withPassword('db:5432', 'secret-value');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-value');
    }
  });
});
