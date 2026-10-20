import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../src/app';
import type { Config } from '../src/config';
import { oidcIdentities, oidcSessions, users } from '../src/db/schema';
import type { LdapAuthenticator } from '../src/modules/auth/ldap';
import {
  OidcUnavailableError,
  OidcUsernameError,
  type OidcClient,
  type OidcFlow,
} from '../src/modules/auth/oidc-client';
import { cleanupOidcSessions } from '../src/modules/auth/oidc-users';
import { hashPassword } from '../src/modules/auth/password';
import { signSession } from '../src/modules/auth/session';
import { createTestApp, type TestApp } from './helpers';

const ISSUER = 'https://keycloak.test/realms/yg';
const oidcConfig: NonNullable<Config['oidc']> = {
  issuer: ISSUER,
  clientId: 'carbone',
  clientSecret: 'test-secret',
  redirectUri: 'https://reports.test/api/auth/oidc/callback',
  postLogoutRedirectUri: 'https://reports.test/login',
};
// Каталог LDAP: любой логин с паролем ldap-pass (канонический логин — введённый).
const ldap: LdapAuthenticator = {
  authenticate: async (login, password) => (password === 'ldap-pass' ? login : null),
};

describe('OIDC: маршруты с PostgreSQL и Redis', () => {
  let t: TestApp;
  let app: App;
  let disabled: App;
  let mock: OidcClient;
  let loginFlow: OidcFlow;
  let adminCookie: string;
  let knownUserId: string;
  let actualSubject = 'subject-new';
  let actualName = 'new-person';
  beforeAll(async () => {
    mock = {
      begin: vi.fn(async (f: OidcFlow) => {
        loginFlow = f;
        return 'https://keycloak.test/auth?state=' + f.state;
      }),
      complete: vi.fn(async () => ({
        issuer: ISSUER,
        subject: actualSubject,
        username: actualName,
        sid: 'provider-sid',
        expiresAt: new Date(Date.now() + 300000),
      })),
      logoutUrl: vi.fn(async () => 'https://keycloak.test/logout'),
      verifyLogout: vi.fn(async () => ({ issuer: ISSUER, jti: randomUUID(), sid: 'provider-sid' })),
    };
    t = await createTestApp(
      { oidcClient: mock, ldap },
      {
        adminLogin: 'recovery-admin',
        oidc: oidcConfig,
        ldap: {
          url: '',
          baseDn: '',
          userFilter: '(uid=%s)',
          defaultRole: 'user',
          tlsRejectUnauthorized: true,
        },
      },
    );
    app = t.app;
    // Тот же экземпляр БД и Redis, но OIDC выключен.
    disabled = await buildApp({ ...t.deps, config: { ...t.deps.config, oidc: null } });
    const [a] = await t.deps.db
      .insert(users)
      .values({
        login: 'recovery-admin',
        role: 'admin',
        passwordHash: await hashPassword('test-local-password'),
      })
      .returning();
    const [u] = await t.deps.db
      .insert(users)
      .values({
        login: 'existing-ldap-user',
        role: 'user',
        passwordHash: await hashPassword('test-local-password'),
        authSource: 'ldap',
      })
      .returning();
    knownUserId = u!.id;
    adminCookie =
      'session=' +
      (await signSession(
        { id: a!.id, login: a!.login, role: a!.role },
        0,
        t.deps.config.appSecret,
      ));
  });
  afterAll(async () => {
    await disabled?.close();
    await t?.close();
  });
  beforeEach(() => {
    actualSubject = 'subject-' + randomUUID();
    actualName = 'new-' + randomUUID().slice(0, 8);
  });
  async function begin() {
    const r = await app.inject({ url: '/api/auth/oidc/login?next=/reports' });
    expect(r.statusCode).toBe(302);
    const f = r.cookies.find((x) => x.name === 'oidc_flow')!;
    return 'oidc_flow=' + f.value;
  }
  async function finish(browser: string, state = loginFlow.state) {
    return app.inject({
      url: '/api/auth/oidc/callback?code=test-code&state=' + state,
      headers: { cookie: browser },
    });
  }
  const sessionCookie = (r: Awaited<ReturnType<typeof finish>>) =>
    'session=' + r.cookies.find((x) => x.name === 'session')!.value;
  it('disabled endpoints return 404 and never contact provider', async () => {
    const n = vi.mocked(mock.begin).mock.calls.length;
    expect((await disabled.inject({ url: '/api/auth/oidc/login' })).statusCode).toBe(404);
    expect((await disabled.inject({ url: '/api/auth/oidc/callback' })).statusCode).toBe(404);
    expect(vi.mocked(mock.begin).mock.calls.length).toBe(n);
  });
  it('local administrator login remains available while OIDC is disabled', async () => {
    const r = await disabled.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'recovery-admin', password: 'test-local-password' },
    });
    expect(r.statusCode).toBe(200);
  });
  it('new external user receives ordinary role and a usable session', async () => {
    const r = await finish(await begin());
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/reports');
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: sessionCookie(r) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe('user');
  });
  it('callback cannot be replayed', async () => {
    const browser = await begin();
    expect((await finish(browser)).statusCode).toBe(302);
    expect((await finish(browser)).statusCode).toBe(401);
  });
  it('rejects callback from another browser', async () => {
    await begin();
    expect((await finish('oidc_flow=other-browser')).statusCode).toBe(401);
  });
  it('rejects callback without its browser cookie', async () => {
    await begin();
    expect(
      (await app.inject({ url: '/api/auth/oidc/callback?state=' + loginFlow.state + '&code=code' }))
        .statusCode,
    ).toBe(401);
  });
  it('does not merge an existing LDAP account by login', async () => {
    actualName = 'existing-ldap-user';
    const r = await finish(await begin());
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('OIDC_LOGIN_UNAVAILABLE');
    const ids = await t.deps.db
      .select()
      .from(oidcIdentities)
      .where(eq(oidcIdentities.subject, actualSubject));
    expect(ids).toHaveLength(0);
  });
  it('callback: ADMIN_LOGIN и занятый логин получают одинаковый отказ (без различимых кодов)', async () => {
    actualName = 'RECOVERY-ADMIN';
    const reserved = await finish(await begin());
    actualName = 'existing-ldap-user';
    const taken = await finish(await begin());
    for (const r of [reserved, taken]) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('OIDC_LOGIN_UNAVAILABLE');
    }
    expect(reserved.statusCode).toBe(taken.statusCode);
    expect(reserved.json()).toEqual(taken.json());
  });
  it('сбой БД при отзыве: повторная доставка того же logout token всё же отзывает сессию', async () => {
    const sub = 'subject-' + randomUUID();
    actualSubject = sub;
    const r = await finish(await begin());
    vi.mocked(mock.verifyLogout).mockResolvedValue({
      issuer: ISSUER,
      jti: randomUUID(),
      subject: sub,
    });
    const logout = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/oidc/backchannel-logout',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'logout_token=validated-by-test-provider',
      });
    const spy = vi.spyOn(t.deps.db, 'update').mockImplementationOnce(() => {
      throw new Error('db down');
    });
    try {
      expect((await logout()).statusCode).toBe(500);
      expect((await logout()).statusCode).toBe(200);
      expect(
        (await app.inject({ url: '/api/auth/me', headers: { cookie: sessionCookie(r) } }))
          .statusCode,
      ).toBe(401);
    } finally {
      spy.mockRestore();
      vi.mocked(mock.verifyLogout).mockImplementation(async () => ({
        issuer: ISSUER,
        jti: randomUUID(),
        sid: 'provider-sid',
      }));
    }
  });
  it('повтор того же logout token (jti) пропускается и не отзывает новую сессию', async () => {
    const sub = 'subject-' + randomUUID();
    const logout = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/oidc/backchannel-logout',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'logout_token=validated-by-test-provider',
      });
    const jti = randomUUID();
    vi.mocked(mock.verifyLogout).mockResolvedValue({ issuer: ISSUER, jti, subject: sub });
    try {
      actualSubject = sub;
      const first = await finish(await begin());
      expect((await logout()).statusCode).toBe(200);
      expect(
        (await app.inject({ url: '/api/auth/me', headers: { cookie: sessionCookie(first) } }))
          .statusCode,
      ).toBe(401);
      // Второй вход того же sub; повтор того же токена не должен его отозвать.
      const second = await finish(await begin());
      expect((await logout()).statusCode).toBe(200);
      const rows = await t.deps.db.select().from(oidcSessions).where(eq(oidcSessions.subject, sub));
      expect(rows.filter((x) => x.revokedAt === null)).toHaveLength(1);
      expect(
        (await app.inject({ url: '/api/auth/me', headers: { cookie: sessionCookie(second) } }))
          .statusCode,
      ).toBe(200);
      // Контроль: другой jti с тем же sub отзывает.
      vi.mocked(mock.verifyLogout).mockResolvedValue({
        issuer: ISSUER,
        jti: randomUUID(),
        subject: sub,
      });
      expect((await logout()).statusCode).toBe(200);
      expect(
        (await app.inject({ url: '/api/auth/me', headers: { cookie: sessionCookie(second) } }))
          .statusCode,
      ).toBe(401);
    } finally {
      vi.mocked(mock.verifyLogout).mockImplementation(async () => ({
        issuer: ISSUER,
        jti: randomUUID(),
        sid: 'provider-sid',
      }));
    }
  });
  it('administrator explicitly links existing account preserving its ID', async () => {
    actualName = 'existing-ldap-user';
    const link = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/oidc/identities',
      headers: { cookie: adminCookie },
      payload: { userId: knownUserId, subject: actualSubject },
    });
    expect(link.statusCode).toBe(201);
    const r = await finish(await begin());
    expect(r.statusCode).toBe(302);
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: sessionCookie(r) } });
    expect(me.json().id).toBe(knownUserId);
  });
  it('never links or provisions the recovery administrator', async () => {
    actualName = 'RECOVERY-ADMIN';
    const reserved = await finish(await begin());
    expect(reserved.statusCode).toBe(403);
    expect(reserved.json().error.code).toBe('OIDC_LOGIN_UNAVAILABLE');
    const token = await app.inject({ url: '/api/auth/me', headers: { cookie: adminCookie } });
    const link = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/oidc/identities',
      headers: { cookie: adminCookie },
      payload: { userId: token.json().id, subject: actualSubject },
    });
    expect(link.statusCode).toBe(403);
  });
  it('non-admin cannot link identities', async () => {
    const r = await finish(await begin());
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/auth/oidc/identities',
          headers: { cookie: sessionCookie(r) },
          payload: { userId: knownUserId, subject: 'attacker' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('blocked user cannot sign in and existing sessions stop working', async () => {
    const r = await finish(await begin());
    const sc = sessionCookie(r);
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: sc } });
    await t.deps.db.update(users).set({ blocked: true }).where(eq(users.id, me.json().id));
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: sc } })).statusCode).toBe(
      401,
    );
    expect((await finish(await begin())).statusCode).toBe(401);
  });
  it('revokes sessions immediately on back-channel logout', async () => {
    const r = await finish(await begin());
    const sc = sessionCookie(r);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: sc } })).statusCode).toBe(
      200,
    );
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/oidc/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=validated-by-test-provider',
    });
    expect(logout.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: sc } })).statusCode).toBe(
      401,
    );
  });
  it('rejects unsigned or invalid back-channel logout', async () => {
    vi.mocked(mock.verifyLogout).mockRejectedValueOnce(new Error('bad signature'));
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/oidc/backchannel-logout',
          payload: { logout_token: 'invalid' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('expired OIDC session is rejected', async () => {
    const r = await finish(await begin());
    await t.deps.db
      .update(oidcSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oidcSessions.subject, actualSubject));
    expect(
      (await app.inject({ url: '/api/auth/me', headers: { cookie: sessionCookie(r) } })).statusCode,
    ).toBe(401);
  });
  it('local logout invalidates the old OIDC cookie', async () => {
    const r = await finish(await begin());
    const sc = sessionCookie(r);
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: sc } }))
        .statusCode,
    ).toBe(204);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: sc } })).statusCode).toBe(
      401,
    );
  });
  it('unlink invalidates sessions and prevents use of the detached identity', async () => {
    const r = await finish(await begin());
    const sc = sessionCookie(r);
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: sc } });
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/admin/auth/oidc/identities/' + me.json().id,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(204);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: sc } })).statusCode).toBe(
      401,
    );
    expect((await finish(await begin())).statusCode).toBe(403);
  });
  it('disabling OIDC invalidates OIDC sessions while local admin stays valid', async () => {
    const r = await finish(await begin());
    expect(
      (await disabled.inject({ url: '/api/auth/me', headers: { cookie: sessionCookie(r) } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await disabled.inject({ url: '/api/auth/me', headers: { cookie: adminCookie } })).statusCode,
    ).toBe(200);
  });
  it('аккаунт, заведённый через Keycloak, получает auth_source = oidc и не открывается через LDAP', async () => {
    actualName = 'ivanov';
    const r = await finish(await begin());
    expect(r.statusCode).toBe(302);
    const [row] = await t.deps.db.select().from(users).where(eq(users.login, 'ivanov'));
    expect(row?.authSource).toBe('oidc');
    // Запись каталога с тем же логином и верным паролем — 401, сессии нет.
    const viaLdap = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'ivanov', password: 'ldap-pass' },
    });
    expect(viaLdap.statusCode).toBe(401);
    expect(viaLdap.cookies.some((c) => c.name === 'session')).toBe(false);
  });
  it('явная привязка администратором не меняет auth_source аккаунта LDAP', async () => {
    const link = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/oidc/identities',
      headers: { cookie: adminCookie },
      payload: { userId: knownUserId, subject: actualSubject },
    });
    expect(link.statusCode).toBe(201);
    const [row] = await t.deps.db.select().from(users).where(eq(users.id, knownUserId));
    expect(row?.authSource).toBe('ldap');
    const viaLdap = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'existing-ldap-user', password: 'ldap-pass' },
    });
    expect(viaLdap.statusCode).toBe(200);
  });
  it('неподходящий preferred_username — понятная ошибка, аккаунт не заводится', async () => {
    vi.mocked(mock.complete).mockRejectedValueOnce(new OidcUsernameError());
    const r = await finish(await begin());
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('OIDC_INVALID_USERNAME');
    const ids = await t.deps.db
      .select()
      .from(oidcIdentities)
      .where(eq(oidcIdentities.subject, actualSubject));
    expect(ids).toHaveLength(0);
  });
  it('провайдер недоступен при back-channel logout — 503, а не молчаливый отказ', async () => {
    vi.mocked(mock.verifyLogout).mockRejectedValueOnce(new OidcUnavailableError('JWKS недоступен'));
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/oidc/backchannel-logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'logout_token=any',
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('OIDC_UNAVAILABLE');
  });
  it('лимит back-channel logout — 600 запросов в минуту с адреса', async () => {
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/oidc/backchannel-logout',
        remoteAddress: '198.51.100.77',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'logout_token=validated-by-test-provider',
      });
    for (let i = 0; i < 600; i++) expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(429);
  });
  it('очистка удаляет истёкшие и отозванные больше суток назад OIDC-сессии', async () => {
    const r = await finish(await begin());
    expect(r.statusCode).toBe(302);
    const [own] = await t.deps.db
      .select()
      .from(oidcSessions)
      .where(eq(oidcSessions.subject, actualSubject));
    const base = { issuer: ISSUER, subject: actualSubject, userId: own!.userId };
    const now = Date.now();
    const expired = randomUUID();
    const oldRevoked = randomUUID();
    const freshRevoked = randomUUID();
    await t.deps.db.insert(oidcSessions).values([
      { ...base, id: expired, expiresAt: new Date(now - 1000) },
      {
        ...base,
        id: oldRevoked,
        expiresAt: new Date(now + 3600_000),
        revokedAt: new Date(now - 2 * 86_400_000),
      },
      {
        ...base,
        id: freshRevoked,
        expiresAt: new Date(now + 3600_000),
        revokedAt: new Date(now - 3600_000),
      },
    ]);
    expect(await cleanupOidcSessions(t.deps)).toBeGreaterThanOrEqual(2);
    const left = (
      await t.deps.db.select().from(oidcSessions).where(eq(oidcSessions.subject, actualSubject))
    ).map((x) => x.id);
    expect(left.sort()).toEqual([own!.id, freshRevoked].sort());
  });

  it('при cookieSecure cookie потока называется __Secure-oidc_flow, сессия — __Host-session, выход чистит обе сессионные', async () => {
    const secure = await buildApp({ ...t.deps, config: { ...t.deps.config, cookieSecure: true } });
    try {
      const r = await secure.inject({ url: '/api/auth/oidc/login?next=/reports' });
      expect(r.statusCode).toBe(302);
      const flow = r.cookies.find((x) => x.name === '__Secure-oidc_flow')!;
      expect(flow).toBeDefined();
      expect(r.cookies.some((x) => x.name === 'oidc_flow')).toBe(false);
      const cb = await secure.inject({
        url: '/api/auth/oidc/callback?code=test-code&state=' + loginFlow.state,
        headers: { cookie: '__Secure-oidc_flow=' + flow.value },
      });
      expect(cb.statusCode).toBe(302);
      const session = cb.cookies.find((x) => x.name === '__Host-session')!;
      expect(session).toBeDefined();
      expect(cb.cookies.some((x) => x.name === 'session')).toBe(false);
      const out = await secure.inject({
        method: 'POST',
        url: '/api/auth/oidc/logout',
        headers: { cookie: '__Host-session=' + session.value },
      });
      expect(out.statusCode).toBe(200);
      const cleared = out.cookies.map((c) => c.name);
      expect(cleared).toContain('__Host-session');
      expect(cleared).toContain('session');
    } finally {
      await secure.close();
    }
  });
});
