import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact';

describe('createRedactor', () => {
  const redact = createRedactor({
    PGPASSWORD: 'pg-pass-123',
    S3_SECRET_ACCESS_KEY: 'secretkey',
    S3_ACCESS_KEY_ID: 'AKIA12',
    BACKUP_AGENT_TOKEN: 'tok'.repeat(11),
    REDIS_URL: 'redis://:redis%2Fpw1@redis:6379',
    SHORT_PASSWORD: 'abc12',
    S3_BUCKET: 'carbone-reports',
    PATH: '/usr/bin',
  });

  it('вырезает значения переменных с PASSWORD, SECRET, TOKEN, KEY в имени от 6 символов', () => {
    expect(redact(`pg_dump: pg-pass-123; rclone: secretkey AKIA12 ${'tok'.repeat(11)}`)).toBe(
      'pg_dump: ***; rclone: *** *** ***',
    );
  });
  it('пароль из REDIS_URL — тоже секрет', () => {
    expect(redact('NOAUTH redis/pw1')).toBe('NOAUTH ***');
  });
  it('короткие значения и несекретные переменные не трогает', () => {
    expect(redact('abc12 carbone-reports /usr/bin')).toBe('abc12 carbone-reports /usr/bin');
  });
  it('сначала длинные значения: секрет, содержащий другой секрет, вырезается целиком', () => {
    const r = createRedactor({ A_PASSWORD: 'secret', B_SECRET: 'secret-long' });
    expect(r('x secret-long y secret')).toBe('x *** y ***');
  });
});
