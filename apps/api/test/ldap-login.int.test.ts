import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import type { LdapAuthenticator } from '../src/modules/auth/ldap';
import { hashPassword } from '../src/modules/auth/password';
import { createTestApp, type TestApp } from './helpers';

/** canonicalLogin по умолчанию — login (как в большинстве тестов: находят себя же). */
function fakeLdap(
  allow: (login: string, password: string) => string | boolean | null,
): LdapAuthenticator {
  return {
    authenticate: async (login, password) => {
      const r = allow(login, password);
      if (r === true) return login;
      if (r === false || r == null) return null;
      return r;
    },
  };
}

const ldapConfigDefaults = {
  url: '',
  baseDn: '',
  userFilter: '(uid=%s)',
  loginAttribute: 'uid',
  defaultRole: 'user' as const,
  tlsRejectUnauthorized: true,
};

const login = (t: TestApp, body: { login: string; password: string }) =>
  t.app.inject({ method: 'POST', url: '/api/auth/login', payload: body });

describe('вход через LDAP', () => {
  let t: TestApp;
  afterEach(() => t?.close());

  it('успешный bind без локального пользователя — заводит его с LDAP_DEFAULT_ROLE', async () => {
    t = await createTestApp(
      { ldap: fakeLdap(() => true) },
      {
        ldap: ldapConfigDefaults,
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
        ldap: ldapConfigDefaults,
      },
    );
    await t.deps.db.insert(users).values({
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
        ldap: ldapConfigDefaults,
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
        ldap: ldapConfigDefaults,
      },
    );
    await t.deps.db.insert(users).values({
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

  it('ADMIN_LOGIN не входит через LDAP — только по локальному паролю', async () => {
    const calls: string[] = [];
    t = await createTestApp(
      {
        ldap: {
          authenticate: async (l) => {
            calls.push(l);
            return l;
          },
        },
      },
      {
        adminLogin: 'admin',
        ldap: ldapConfigDefaults,
      },
    );
    await t.deps.db
      .insert(users)
      .values({ login: 'admin', passwordHash: await hashPassword('local-secret'), role: 'admin' });
    // Пользователь каталога с логином admin не получает встроенную учётную запись.
    const viaLdap = await login(t, { login: 'admin', password: 'пароль-из-каталога' });
    expect(viaLdap.statusCode).toBe(401);
    expect(calls).toEqual([]);
    const local = await login(t, { login: 'admin', password: 'local-secret' });
    expect(local.statusCode).toBe(200);
    expect(calls).toEqual([]);
  });

  it('канонический логин из LDAP отличается от введённого (вход по почте) — заводит и находит один аккаунт', async () => {
    // LDAP_USER_FILTER вправе искать и по почте, но локальный логин — атрибут LDAP_LOGIN_ATTRIBUTE
    // (здесь — uid), а не то, что ввёл пользователь.
    t = await createTestApp({ ldap: fakeLdap(() => 'ivanov') }, { ldap: ldapConfigDefaults });
    const first = await login(t, { login: 'ivanov@example.com', password: 'что-угодно' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ login: 'ivanov' });

    const second = await login(t, { login: 'ivanov', password: 'другой-пароль-тоже-ок' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ login: 'ivanov', id: first.json().id });

    const rows = await t.deps.db.select().from(users).where(eq(users.login, 'ivanov'));
    expect(rows).toHaveLength(1);
    const byEmail = await t.deps.db
      .select()
      .from(users)
      .where(eq(users.login, 'ivanov@example.com'));
    expect(byEmail).toHaveLength(0);
  });

  it('канонический логин из LDAP отличается регистром от уже заведённого аккаунта — не дублирует его', async () => {
    // Старый локальный аккаунт мог завестись в другом регистре (например, раньше каталог
    // отдавал «petrov», теперь — «Petrov»): это по-прежнему один и тот же человек.
    t = await createTestApp({ ldap: fakeLdap(() => 'Petrov') }, { ldap: ldapConfigDefaults });
    const existing = await t.deps.db
      .insert(users)
      .values({ login: 'petrov', passwordHash: await hashPassword(randomUUID()), role: 'admin' })
      .returning();
    const res = await login(t, { login: 'petrov', password: 'что-угодно' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ login: 'petrov', role: 'admin', id: existing[0]!.id });

    const rows = await t.deps.db
      .select()
      .from(users)
      .where(sql`lower(${users.login}) = lower('petrov')`);
    expect(rows).toHaveLength(1);
  });
});
