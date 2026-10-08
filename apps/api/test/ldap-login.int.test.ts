import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import type { LdapAuthenticator } from '../src/modules/auth/ldap';
import { hashPassword } from '../src/modules/auth/password';
import { createTestApp, type TestApp } from './helpers';

function fakeLdap(allow: (login: string, password: string) => boolean): LdapAuthenticator {
  return { authenticate: async (login, password) => allow(login, password) };
}

const login = (t: TestApp, body: { login: string; password: string }) =>
  t.app.inject({ method: 'POST', url: '/api/auth/login', payload: body });

describe('вход через LDAP', () => {
  let t: TestApp;
  afterEach(() => t?.close());

  it('успешный bind без локального пользователя — заводит его с LDAP_DEFAULT_ROLE', async () => {
    t = await createTestApp(
      { ldap: fakeLdap(() => true) },
      {
        ldap: {
          url: '',
          baseDn: '',
          userFilter: '(uid=%s)',
          defaultRole: 'user',
          tlsRejectUnauthorized: true,
        },
      },
    );
    const res = await login(t, { login: 'novy', password: 'что-угодно' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ login: 'novy', role: 'user' });
    const [row] = await t.deps.db.select().from(users).where(eq(users.login, 'novy'));
    expect(row?.role).toBe('user');
  });

  it('успешный bind существующего пользователя — роль и группы из БД не трогает', async () => {
    t = await createTestApp(
      { ldap: fakeLdap(() => true) },
      {
        ldap: {
          url: '',
          baseDn: '',
          userFilter: '(uid=%s)',
          defaultRole: 'user',
          tlsRejectUnauthorized: true,
        },
      },
    );
    await t.deps.db
      .insert(users)
      .values({
        login: 'suschestvuet',
        passwordHash: await hashPassword('local-pass'),
        role: 'admin',
      });
    const res = await login(t, { login: 'suschestvuet', password: 'любой' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ login: 'suschestvuet', role: 'admin' });
  });

  it('неудачный bind — откат на локальный пароль (например, admin продолжает работать)', async () => {
    t = await createTestApp(
      { ldap: fakeLdap(() => false) },
      {
        ldap: {
          url: '',
          baseDn: '',
          userFilter: '(uid=%s)',
          defaultRole: 'user',
          tlsRejectUnauthorized: true,
        },
      },
    );
    await t.deps.db
      .insert(users)
      .values({ login: 'admin', passwordHash: await hashPassword('local-secret'), role: 'admin' });
    const bad = await login(t, { login: 'admin', password: 'неверный' });
    expect(bad.statusCode).toBe(401);
    const ok = await login(t, { login: 'admin', password: 'local-secret' });
    expect(ok.statusCode).toBe(200);
  });

  it('заблокированный пользователь не входит через LDAP', async () => {
    t = await createTestApp(
      { ldap: fakeLdap(() => true) },
      {
        ldap: {
          url: '',
          baseDn: '',
          userFilter: '(uid=%s)',
          defaultRole: 'user',
          tlsRejectUnauthorized: true,
        },
      },
    );
    await t.deps.db
      .insert(users)
      .values({
        login: 'zabloki',
        passwordHash: await hashPassword('x'),
        role: 'user',
        blocked: true,
      });
    const res = await login(t, { login: 'zabloki', password: 'что угодно' });
    expect(res.statusCode).toBe(401);
  });

  it('LDAP выключен (deps.ldap = null) — обычный локальный вход, как раньше', async () => {
    t = await createTestApp();
    await t.deps.db
      .insert(users)
      .values({ login: 'only-local', passwordHash: await hashPassword('secret123'), role: 'user' });
    const res = await login(t, { login: 'only-local', password: 'secret123' });
    expect(res.statusCode).toBe(200);
  });
});
