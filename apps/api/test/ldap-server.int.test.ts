import { createServer, type Server, type Socket } from 'node:net';
import { eq } from 'drizzle-orm';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LdapConfig } from '../src/config';
import { users } from '../src/db/schema';
import { createLdapAuthenticator } from '../src/modules/auth/ldap';
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
    .withWaitStrategy(Wait.forLogMessage(/slapd starting/))
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
    defaultRole: 'user',
    tlsRejectUnauthorized: true,
    ...over,
  };
}

function capturingLog() {
  const warnings: string[] = [];
  return { warnings, log: { warn: (msg: string) => warnings.push(msg) } };
}

describe('LDAP-аутентификатор с настоящим сервером OpenLDAP', () => {
  it('верный пароль — успех; поиск анонимный', async () => {
    const { warnings, log } = capturingLog();
    const auth = createLdapAuthenticator(cfg(), log);
    expect(await auth.authenticate('fry', 'fry')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('верный пароль — успех; поиск от сервисной учётной записи', async () => {
    const auth = createLdapAuthenticator(
      cfg({ bindDn: ADMIN_DN, bindPassword: ADMIN_PASSWORD }),
      capturingLog().log,
    );
    expect(await auth.authenticate('fry', 'fry')).toBe(true);
  });

  it('DN с не-ASCII символами (bender) — успех', async () => {
    const auth = createLdapAuthenticator(cfg(), capturingLog().log);
    expect(await auth.authenticate('bender', 'bender')).toBe(true);
  });

  it('неверный пароль, неизвестный логин и пустой пароль — отказ', async () => {
    const auth = createLdapAuthenticator(cfg(), capturingLog().log);
    expect(await auth.authenticate('fry', 'leela')).toBe(false);
    expect(await auth.authenticate('nobody', 'fry')).toBe(false);
    // Пустой пароль на сервере дал бы «unauthenticated bind» — успех без проверки пароля.
    expect(await auth.authenticate('fry', '')).toBe(false);
  });

  it('фильтр с несколькими %s: вход по uid или по почте', async () => {
    const auth = createLdapAuthenticator(
      cfg({ userFilter: '(|(uid=%s)(mail=%s))' }),
      capturingLog().log,
    );
    expect(await auth.authenticate('fry', 'fry')).toBe(true);
    expect(await auth.authenticate('fry@planetexpress.com', 'fry')).toBe(true);
  });

  it('фильтр нашёл больше одной записи — отказ', async () => {
    // (uid=user1*) совпадает с user1, user10, user100… из ou=large_ou.
    const auth = createLdapAuthenticator(cfg({ userFilter: '(uid=%s*)' }), capturingLog().log);
    expect(await auth.authenticate('user1', 'user1')).toBe(false);
  });

  it('спецсимволы в логине не расширяют фильтр (LDAP-инъекция)', async () => {
    const auth = createLdapAuthenticator(cfg(), capturingLog().log);
    expect(await auth.authenticate('*', 'fry')).toBe(false);
    expect(await auth.authenticate('fr*', 'fry')).toBe(false);
    expect(await auth.authenticate('fry)(uid=*', 'fry')).toBe(false);
    expect(await auth.authenticate('*)(|(uid=*', 'fry')).toBe(false);
    expect(await auth.authenticate('fry\\', 'fry')).toBe(false);
    expect(await auth.authenticate('$`fry', 'fry')).toBe(false);
  });

  it('неверный пароль сервисной учётной записи — отказ и предупреждение без пароля', async () => {
    const { warnings, log } = capturingLog();
    const auth = createLdapAuthenticator(
      cfg({ bindDn: ADMIN_DN, bindPassword: 'wrong-service-password' }),
      log,
    );
    expect(await auth.authenticate('fry', 'fry')).toBe(false);
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
    expect(await auth.authenticate('fry', 'fry')).toBe(false);
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
    expect(await auth.authenticate('fry', 'fry')).toBe(false);
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

  it('неверный пароль — 401, пользователь не заводится', async () => {
    await app();
    const res = await login({ login: 'fry', password: 'leela' });
    expect(res.statusCode).toBe(401);
    const rows = await t.deps.db.select().from(users).where(eq(users.login, 'fry'));
    expect(rows).toHaveLength(0);
  });
});
