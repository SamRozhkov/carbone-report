import { createServer, type Server, type Socket } from 'node:net';
import { eq } from 'drizzle-orm';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LdapConfig } from '../src/config';
import { users } from '../src/db/schema';
import { createLdapAuthenticator } from '../src/modules/auth/ldap';
import { hashPassword } from '../src/modules/auth/password';
import { SESSION_COOKIE } from '../src/modules/auth/session';
import { createTestApp, type TestApp } from './helpers';
import { LDAP_IMAGE } from './images';

// Тестовый каталог образа (dc=planetexpress,dc=com): пароль пользователя совпадает с uid
// (fry/fry, bender/bender); у bender в DN есть не-ASCII символ («Rodríguez»).
const BASE_DN = 'dc=planetexpress,dc=com';
const ADMIN_DN = 'cn=admin,dc=planetexpress,dc=com';
const ADMIN_PASSWORD = 'GoodNewsEveryone';

let ldap: StartedTestContainer;
let url: string;

beforeAll(async () => {
  ldap = await new GenericContainer(LDAP_IMAGE)
    .withExposedPorts(389)
    // «slapd starting» печатается до listen() в потоке демона: на загруженном раннере первые подключения
    // отклонялись. Ждём настоящий ответ каталога изнутри контейнера.
    .withWaitStrategy(
      Wait.forSuccessfulCommand(
        `ldapsearch -x -LLL -H ldap://localhost -b ${BASE_DN} '(uid=fry)' dn | grep -q '^dn:'`,
      ),
    )
    .start();
  url = `ldap://${ldap.getHost()}:${ldap.getMappedPort(389)}`;
}, 120_000);

afterAll(async () => {
  await ldap?.stop();
});

function cfg(over: Partial<LdapConfig> = {}): LdapConfig {
  return {
    url,
    baseDn: BASE_DN,
    userFilter: '(uid=%s)',
    loginAttribute: 'uid',
    defaultRole: 'user',
    tlsRejectUnauthorized: true,
    ...over,
  };
}

function capturingLog() {
  const warnings: string[] = [];
  return { warnings, log: { warn: (msg: string) => warnings.push(msg) } };
}

/**
 * Успешный вход: аутентификатор вернул канонический логин (по умолчанию — введённый);
 * при провале в сообщении видны предупреждения аутентификатора (причина ошибки LDAP).
 */
async function expectLogin(
  over: Partial<LdapConfig>,
  login: string,
  password: string,
  canonical = login,
) {
  const { warnings, log } = capturingLog();
  const got = await createLdapAuthenticator(cfg(over), log).authenticate(login, password);
  expect({ got, warnings }).toEqual({ got: canonical, warnings: [] });
}

describe('LDAP-аутентификатор с настоящим сервером OpenLDAP', () => {
  it('верный пароль — успех; поиск анонимный', async () => {
    await expectLogin({}, 'fry', 'fry');
  });

  it('верный пароль — успех; поиск от сервисной учётной записи', async () => {
    await expectLogin({ bindDn: ADMIN_DN, bindPassword: ADMIN_PASSWORD }, 'fry', 'fry');
  });

  it('DN с не-ASCII символами (bender) — успех', async () => {
    await expectLogin({}, 'bender', 'bender');
  });

  it('неверный пароль, неизвестный логин и пустой пароль — отказ', async () => {
    const auth = createLdapAuthenticator(cfg(), capturingLog().log);
    expect(await auth.authenticate('fry', 'leela')).toBeNull();
    expect(await auth.authenticate('nobody', 'fry')).toBeNull();
    // Пустой пароль на сервере дал бы «unauthenticated bind» — успех без проверки пароля.
    expect(await auth.authenticate('fry', '')).toBeNull();
  });

  it('фильтр с несколькими %s: вход по uid или по почте — оба раза один канонический логин', async () => {
    await expectLogin({ userFilter: '(|(uid=%s)(mail=%s))' }, 'fry', 'fry');
    // Вход по почте находит ту же запись, но канонический логин — всё равно uid (fry),
    // а не введённый адрес: иначе у одного человека завелось бы два локальных аккаунта.
    await expectLogin(
      { userFilter: '(|(uid=%s)(mail=%s))' },
      'fry@planetexpress.com',
      'fry',
      'fry',
    );
  });

  it('LDAP_LOGIN_ATTRIBUTE не задан — канонический логин = введённый (прежнее поведение)', async () => {
    await expectLogin({ loginAttribute: undefined }, 'fry', 'fry');
    // Вход по почте: без атрибута логином остаётся введённая почта, как до LDAP_LOGIN_ATTRIBUTE.
    await expectLogin(
      { loginAttribute: undefined, userFilter: '(|(uid=%s)(mail=%s))' },
      'fry@planetexpress.com',
      'fry',
    );
  });

  it('LDAP_LOGIN_ATTRIBUTE не найден в записи — отказ, а не канонический логин = undefined', async () => {
    const { warnings, log } = capturingLog();
    const auth = createLdapAuthenticator(cfg({ loginAttribute: 'employeeNumber' }), log);
    expect(await auth.authenticate('fry', 'fry')).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('employeeNumber');
  });

  it('фильтр нашёл больше одной записи — отказ', async () => {
    // (uid=user1*) совпадает с user1, user10, user100… из ou=large_ou.
    const auth = createLdapAuthenticator(cfg({ userFilter: '(uid=%s*)' }), capturingLog().log);
    expect(await auth.authenticate('user1', 'user1')).toBeNull();
  });

  it('спецсимволы в логине не расширяют фильтр (LDAP-инъекция)', async () => {
    const auth = createLdapAuthenticator(cfg(), capturingLog().log);
    expect(await auth.authenticate('*', 'fry')).toBeNull();
    expect(await auth.authenticate('fr*', 'fry')).toBeNull();
    expect(await auth.authenticate('fry)(uid=*', 'fry')).toBeNull();
    expect(await auth.authenticate('*)(|(uid=*', 'fry')).toBeNull();
    expect(await auth.authenticate('fry\\', 'fry')).toBeNull();
    expect(await auth.authenticate('$`fry', 'fry')).toBeNull();
  });

  it('неверный пароль сервисной учётной записи — отказ и предупреждение без пароля', async () => {
    const { warnings, log } = capturingLog();
    const auth = createLdapAuthenticator(
      cfg({ bindDn: ADMIN_DN, bindPassword: 'wrong-service-password' }),
      log,
    );
    expect(await auth.authenticate('fry', 'fry')).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^LDAP: поиск пользователя не удался/);
    expect(warnings[0]).not.toContain('wrong-service-password');
  });
});

describe('LDAP-сервер недоступен', () => {
  let silent: Server;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    // Принимает соединение и молчит — как сервер за файрволом, который не отвечает.
    silent = createServer((s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
  });

  it('сервер не отвечает — отказ по тайм-ауту, а не вечное ожидание', async () => {
    const port = (silent.address() as { port: number }).port;
    const { warnings, log } = capturingLog();
    const auth = createLdapAuthenticator(cfg({ url: `ldap://127.0.0.1:${port}` }), log, {
      timeoutMs: 500,
      connectTimeoutMs: 500,
    });
    const started = Date.now();
    expect(await auth.authenticate('fry', 'fry')).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(warnings).toHaveLength(1);
  });

  it('порт закрыт — отказ и предупреждение', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const { warnings, log } = capturingLog();
    const auth = createLdapAuthenticator(cfg({ url: `ldap://127.0.0.1:${port}` }), log);
    expect(await auth.authenticate('fry', 'fry')).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe('POST /api/auth/login с настоящим LDAP', () => {
  let t: TestApp;
  afterEach(() => t?.close());

  async function app(over: Partial<LdapConfig> = {}) {
    const ldapConfig = cfg(over);
    t = await createTestApp(
      { ldap: createLdapAuthenticator(ldapConfig, capturingLog().log) },
      { ldap: ldapConfig, adminLogin: 'admin' },
    );
    return t;
  }
  const login = (body: { login: string; password: string }) =>
    t.app.inject({ method: 'POST', url: '/api/auth/login', payload: body });

  it('первый вход заводит пользователя с LDAP_DEFAULT_ROLE, повторный находит его', async () => {
    await app({ defaultRole: 'admin' });
    const first = await login({ login: 'fry', password: 'fry' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ login: 'fry', role: 'admin' });
    expect(first.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(true);

    const second = await login({ login: 'fry', password: 'fry' });
    expect(second.statusCode).toBe(200);
    const rows = await t.deps.db.select().from(users).where(eq(users.login, 'fry'));
    expect(rows).toHaveLength(1);
  });

  it('логин в пробелах (без loginAttribute) — тот же аккаунт, строки с пробелами не заводятся', async () => {
    await app();
    const padded = await login({ login: ' fry ', password: 'fry' });
    expect(padded.statusCode).toBe(200);
    const plain = await login({ login: 'fry', password: 'fry' });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().id).toBe(padded.json().id);
    const rows = await t.deps.db.select().from(users).where(eq(users.login, ' fry '));
    expect(rows).toHaveLength(0);
  });

  it('неверный пароль — 401, пользователь не заводится', async () => {
    await app();
    const res = await login({ login: 'fry', password: 'leela' });
    expect(res.statusCode).toBe(401);
    const rows = await t.deps.db.select().from(users).where(eq(users.login, 'fry'));
    expect(rows).toHaveLength(0);
  });

  it('вход по uid и по почте — один и тот же локальный аккаунт (fry), не два', async () => {
    await app({ userFilter: '(|(uid=%s)(mail=%s))' });
    const byUid = await login({ login: 'fry', password: 'fry' });
    expect(byUid.statusCode).toBe(200);
    expect(byUid.json()).toMatchObject({ login: 'fry' });

    const byMail = await login({ login: 'fry@planetexpress.com', password: 'fry' });
    expect(byMail.statusCode).toBe(200);
    // Канонический логин из LDAP (uid) — тот же аккаунт, не завёлся второй по адресу почты.
    expect(byMail.json()).toMatchObject({ login: 'fry' });
    expect(byMail.json()).toMatchObject({ id: byUid.json().id });

    const rows = await t.deps.db.select().from(users).where(eq(users.login, 'fry'));
    expect(rows).toHaveLength(1);
    const byEmailLogin = await t.deps.db
      .select()
      .from(users)
      .where(eq(users.login, 'fry@planetexpress.com'));
    expect(byEmailLogin).toHaveLength(0);
  });

  it('аккаунт, заведённый через Keycloak (auth_source = oidc), через LDAP не открывается', async () => {
    await app();
    await t.deps.db.insert(users).values({
      login: 'fry',
      passwordHash: await hashPassword('unknown-random'),
      role: 'user',
      authSource: 'oidc',
    });
    const res = await login({ login: 'fry', password: 'fry' });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);
  });

  it('первый вход через LDAP заводит аккаунт с auth_source = ldap', async () => {
    await app();
    expect((await login({ login: 'fry', password: 'fry' })).statusCode).toBe(200);
    const [row] = await t.deps.db.select().from(users).where(eq(users.login, 'fry'));
    expect(row?.authSource).toBe('ldap');
  });

  it('без LDAP_LOGIN_ATTRIBUTE вход по почте заводит аккаунт с введённой почтой (прежнее поведение)', async () => {
    await app({ loginAttribute: undefined, userFilter: '(|(uid=%s)(mail=%s))' });
    const byMail = await login({ login: 'fry@planetexpress.com', password: 'fry' });
    expect(byMail.statusCode).toBe(200);
    expect(byMail.json()).toMatchObject({ login: 'fry@planetexpress.com' });
  });
});

describe('ADMIN_LOGIN совпадает с uid записи каталога (настоящий LDAP)', () => {
  let t: TestApp;
  afterEach(() => t?.close());

  // ADMIN_LOGIN = fry: у каталога есть запись uid=fry с паролем fry.
  async function app(over: Partial<LdapConfig> = {}) {
    const ldapConfig = cfg(over);
    t = await createTestApp(
      { ldap: createLdapAuthenticator(ldapConfig, capturingLog().log) },
      { ldap: ldapConfig, adminLogin: 'fry' },
    );
    await t.deps.db.insert(users).values({
      login: 'fry',
      passwordHash: await hashPassword('local-admin-secret'),
      role: 'admin',
    });
    return t;
  }
  const login = (body: { login: string; password: string }) =>
    t.app.inject({ method: 'POST', url: '/api/auth/login', payload: body });
  const expectNoSession = (res: Awaited<ReturnType<typeof login>>) => {
    expect(res.statusCode).toBe(401);
    expect(res.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);
  };

  it.each([undefined, 'uid'])(
    'логин в другом регистре (Fry, FRY) не даёт сессию администратора (LDAP_LOGIN_ATTRIBUTE=%s)',
    async (loginAttribute) => {
      await app({ loginAttribute });
      expectNoSession(await login({ login: 'Fry', password: 'fry' }));
      expectNoSession(await login({ login: 'FRY', password: 'fry' }));
      // Пароль каталога и для точного написания не подходит: только локальный пароль.
      expectNoSession(await login({ login: 'fry', password: 'fry' }));
      const rows = await t.deps.db.select().from(users);
      expect(rows.map((r) => r.login)).toEqual(['fry']);
    },
  );

  it('вход по почте (канонический uid = ADMIN_LOGIN) — 401, сессии администратора нет', async () => {
    await app({ userFilter: '(|(uid=%s)(mail=%s))', loginAttribute: 'uid' });
    expectNoSession(await login({ login: 'fry@planetexpress.com', password: 'fry' }));
    const rows = await t.deps.db.select().from(users);
    expect(rows.map((r) => r.login)).toEqual(['fry']);
  });

  it('локальный пароль администратора по-прежнему работает', async () => {
    await app({ userFilter: '(|(uid=%s)(mail=%s))', loginAttribute: 'uid' });
    const res = await login({ login: 'fry', password: 'local-admin-secret' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ login: 'fry', role: 'admin' });
  });
});
