import { describe, expect, it } from 'vitest';
import { certErrorMessage, sslOptions } from './pools';

describe('sslOptions', () => {
  it('disable → false', () => expect(sslOptions('disable', null)).toBe(false));
  it('require → без проверки', () =>
    expect(sslOptions('require', null)).toEqual({ rejectUnauthorized: false }));
  it('verify без CA → проверка по системным корням', () =>
    expect(sslOptions('verify', null)).toEqual({ rejectUnauthorized: true }));
  it('verify с CA → ca передаётся', () =>
    expect(sslOptions('verify', 'PEM')).toEqual({ rejectUnauthorized: true, ca: 'PEM' }));
});

describe('certErrorMessage', () => {
  it('ошибка сертификата получает понятный префикс', () => {
    const e = Object.assign(new Error('self-signed certificate'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    expect(certErrorMessage(e)).toBe('сертификат не прошёл проверку: self-signed certificate');
  });
  it('прочие ошибки — как есть', () => {
    expect(certErrorMessage(new Error('connection refused'))).toBe('connection refused');
  });
});
