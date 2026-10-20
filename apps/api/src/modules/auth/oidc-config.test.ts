import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config';
import { safeOidcNext } from './oidc-routes';
const base = {
  DATABASE_URL: 'postgres://u:p@localhost/app',
  APP_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  ONLYOFFICE_JWT_SECRET: 'o'.repeat(32),
};
const oidc = {
  OIDC_ENABLED: 'true',
  OIDC_ISSUER: 'https://sso.test/realms/yg',
  OIDC_CLIENT_ID: 'carbone',
  OIDC_CLIENT_SECRET: 'private-test-value',
  OIDC_REDIRECT_URI: 'https://reports.test/api/auth/oidc/callback',
  OIDC_POST_LOGOUT_REDIRECT_URI: 'https://reports.test/login',
  COOKIE_SECURE: 'true',
};
describe('OIDC config', () => {
  it('disabled by default, no issuer or credentials needed', () =>
    expect(loadConfig(base).oidc).toBeNull());
  it('accepts complete HTTPS configuration', () =>
    expect(loadConfig({ ...base, ...oidc }).oidc?.clientId).toBe('carbone'));
  it.each([
    'OIDC_ISSUER',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
    'OIDC_POST_LOGOUT_REDIRECT_URI',
  ] as const)('rejects missing %s without leaking secret', (key) => {
    try {
      loadConfig({ ...base, ...oidc, [key]: '' });
      throw new Error('should reject');
    } catch (e) {
      expect(String(e)).toContain(key);
      expect(String(e)).not.toContain(oidc.OIDC_CLIENT_SECRET);
    }
  });
  it('requires secure cookie', () =>
    expect(() => loadConfig({ ...base, ...oidc, COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE/,
    ));
  it('rejects an HTTP issuer', () =>
    expect(() =>
      loadConfig({ ...base, ...oidc, OIDC_ISSUER: 'http://sso.test/realms/yg' }),
    ).toThrow(/OIDC_ISSUER/));
  it('rejects foreign logout origin', () =>
    expect(() =>
      loadConfig({ ...base, ...oidc, OIDC_POST_LOGOUT_REDIRECT_URI: 'https://other.test/' }),
    ).toThrow(/OIDC_POST_LOGOUT/));
  it('rejects callback URL pointing at another handler', () =>
    expect(() =>
      loadConfig({ ...base, ...oidc, OIDC_REDIRECT_URI: 'https://reports.test/reports' }),
    ).toThrow(/OIDC_REDIRECT/));
  it.each(['//evil.test', 'https://evil.test', '/\\evil.test', '/\nevil.test'])(
    'rejects unsafe next %s',
    (next) => expect(safeOidcNext(next)).toBe('/reports'),
  );
  it('keeps internal next including query', () =>
    expect(safeOidcNext('/reports?category=test')).toBe('/reports?category=test'));
});
