import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { createFastify } from '../../app';
import { loadConfig } from '../../config';
import { createDb, migrateDb } from '../../db/client';
import { oidcIdentities, oidcSessions, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { registerErrorHandler } from '../../lib/errors';
import { makeGuards } from './guards';
import { registerAuthRoutes } from './routes';
import { registerOidcRoutes } from './oidc-routes';
import { hashPassword } from './password';
import { signSession } from './session';
import type { OidcClient, OidcFlow } from './oidc-client';

const databaseEnabled = process.env.OIDC_DB_TEST === 'true';
describe.skipIf(!databaseEnabled)('OIDC routes with isolated PostgreSQL database and Redis', () => {
  const databaseName = 'oidc_test_' + randomUUID().replaceAll('-', '');
  let admin: pg.Client;
  let db: ReturnType<typeof createDb>;
  let redis: Redis;
  let deps: AppDeps;
  let app: ReturnType<typeof createFastify>;
  let disabled: ReturnType<typeof createFastify>;
  let mock: OidcClient;
  let loginFlow: OidcFlow;
  let adminCookie: string;
  let knownUserId: string;
  let actualSubject = 'subject-new';
  let actualName = 'new-person';
  beforeAll(async () => {
    const original = loadConfig({ ...process.env, OIDC_ENABLED: 'false' });
    admin = new pg.Client({ connectionString: original.databaseUrl });
    await admin.connect();
    await admin.query('CREATE DATABASE ' + databaseName);
    const url = new URL(original.databaseUrl);
    url.pathname = '/' + databaseName;
    db = createDb(url.href);
    await migrateDb(db.db);
    redis = new Redis(original.redisUrl);
    const config = {
      ...original,
      databaseUrl: url.href,
      adminLogin: 'recovery-admin',
      oidc: {
        issuer: 'https://keycloak.test/realms/yg',
        clientId: 'carbone',
        clientSecret: 'test-secret',
        redirectUri: 'https://reports.test/api/auth/oidc/callback',
        postLogoutRedirectUri: 'https://reports.test/login',
      },
    };
    deps = { config, db: db.db, redis, backupAgent: null } as unknown as AppDeps;
    mock = {
      begin: vi.fn(async (f: OidcFlow) => {
        loginFlow = f;
        return 'https://keycloak.test/auth?state=' + f.state;
      }),
      complete: vi.fn(async () => ({
        issuer: config.oidc.issuer,
        subject: actualSubject,
        username: actualName,
        sid: 'provider-sid',
        expiresAt: new Date(Date.now() + 300000),
      })),
      logoutUrl: vi.fn(async () => 'https://keycloak.test/logout'),
      verifyLogout: vi.fn(async () => ({ issuer: config.oidc.issuer, sid: 'provider-sid' })),
    };
    async function setup(d: AppDeps) {
      const a = createFastify();
      registerErrorHandler(a);
      await a.register(cookie);
      await a.register(rateLimit, { global: false });
      const guards = makeGuards(d);
      registerAuthRoutes(a, d, guards);
      registerOidcRoutes(a, d, guards, mock);
      await a.ready();
      return a;
    }
    app = await setup(deps);
    disabled = await setup({ ...deps, config: { ...config, oidc: null } });
    const [a] = await db.db
      .insert(users)
      .values({
        login: config.adminLogin,
        role: 'admin',
        passwordHash: await hashPassword('test-local-password'),
      })
      .returning();
    const [u] = await db.db
      .insert(users)
      .values({
        login: 'existing-ldap-user',
        role: 'user',
        passwordHash: await hashPassword('test-local-password'),
      })
      .returning();
    knownUserId = u!.id;
    adminCookie =
      'session=' +
      (await signSession({ id: a!.id, login: a!.login, role: a!.role }, 0, config.appSecret));
  }, 120000);
  afterAll(async () => {
    await app?.close();
    await disabled?.close();
    await redis?.quit();
    await db?.pool.end();
    if (admin) {
      await admin.query('DROP DATABASE ' + databaseName + ' WITH (FORCE)');
      await admin.end();
    }
  });
  beforeEach(() => {
    actualSubject = 'subject-' + randomUUID();
    actualName = 'new-' + randomUUID();
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
    expect(r.statusCode).toBe(409);
    const ids = await db.db
      .select()
      .from(oidcIdentities)
      .where(eq(oidcIdentities.subject, actualSubject));
    expect(ids).toHaveLength(0);
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
    expect((await finish(await begin())).statusCode).toBe(403);
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
    await db.db.update(users).set({ blocked: true }).where(eq(users.id, me.json().id));
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
    await db.db
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
    expect((await finish(await begin())).statusCode).toBe(409);
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
});
