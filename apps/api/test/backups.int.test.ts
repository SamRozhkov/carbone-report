import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentClient } from '../src/modules/backups/agent-client';
import { startFakeAgent, type FakeAgent } from './fake-agent';
import { createTestApp, loginAs, type TestApp } from './helpers';

const NAME = '2026-10-08T03-00-00Z';
const BACKUPS = [
  {
    name: NAME,
    createdAt: '2026-10-08T03:00:00Z',
    dbSize: 1,
    storageSize: 2,
    lastMigration: 'a'.repeat(64),
    kind: 'regular',
    status: 'ok',
  },
];
const UNAVAILABLE = {
  error: { code: 'backup_agent_unavailable', message: 'Агент бэкапа недоступен' },
};
const ROUTES = [
  ['GET', '/api/admin/backups'],
  ['POST', '/api/admin/backups'],
  ['POST', `/api/admin/backups/${NAME}/restore`],
  ['GET', '/api/admin/backups/operation'],
] as const;

describe('бэкапы в админке: прокси к агенту', () => {
  let agent: FakeAgent;
  let t: TestApp;
  let admin: { cookie: string; user: { login: string } };
  let user: string;

  beforeAll(async () => {
    agent = await startFakeAgent();
    // Тайм-аут короче 10 с только для теста «агент не ответил вовремя».
    t = await createTestApp({
      backupAgent: createAgentClient({ url: agent.url, token: agent.token, timeoutMs: 500 }),
    });
    admin = await loginAs(t, 'admin');
    user = (await loginAs(t, 'user')).cookie;
  });
  afterAll(async () => {
    await t.close();
    await agent.close();
  });

  it('не-admin — 403, без входа — 401; агент не вызывается', async () => {
    for (const [method, url] of ROUTES) {
      expect((await t.app.inject({ method, url, headers: { cookie: user } })).statusCode).toBe(403);
      expect((await t.app.inject({ method, url })).statusCode).toBe(401);
    }
    expect(agent.requests).toEqual([]);
  });

  it('GET /api/admin/backups — список агента; токен передан в Authorization', async () => {
    agent.respond('GET', '/backups', { status: 200, body: BACKUPS });
    const r = await t.app.inject({
      method: 'GET',
      url: '/api/admin/backups',
      headers: { cookie: admin.cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(BACKUPS);
    expect(agent.requests.at(-1)).toEqual({
      method: 'GET',
      path: '/backups',
      auth: `Bearer ${agent.token}`,
      body: undefined,
    });
  });

  it('POST /api/admin/backups — 202; requestedBy = логин админа', async () => {
    agent.respond('POST', '/backups', { status: 202, body: { operationId: 'op1' } });
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/admin/backups',
      headers: { cookie: admin.cookie },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ operationId: 'op1' });
    expect(agent.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/backups',
      body: { requestedBy: admin.user.login },
    });
  });

  it('restore: неверное имя — 400 до агента; верное — 202 с логином', async () => {
    const before = agent.requests.length;
    for (const bad of ['..%2F..%2Fetc', `${NAME}.partial`, 'latest']) {
      const r = await t.app.inject({
        method: 'POST',
        url: `/api/admin/backups/${bad}/restore`,
        headers: { cookie: admin.cookie },
      });
      expect(r.statusCode).toBe(400);
    }
    expect(agent.requests.length).toBe(before);
    agent.respond('POST', `/backups/${NAME}/restore`, {
      status: 202,
      body: { operationId: 'op2' },
    });
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/admin/backups/${NAME}/restore`,
      headers: { cookie: admin.cookie },
    });
    expect(r.statusCode).toBe(202);
    expect(agent.requests.at(-1)).toMatchObject({
      path: `/backups/${NAME}/restore`,
      body: { requestedBy: admin.user.login },
    });
  });

  it('ответы агента 204, 404 и 409 передаются как есть', async () => {
    agent.respond('GET', '/operation', { status: 204 });
    const op = await t.app.inject({
      method: 'GET',
      url: '/api/admin/backups/operation',
      headers: { cookie: admin.cookie },
    });
    expect(op.statusCode).toBe(204);
    expect(op.body).toBe('');

    const busy = {
      error: { code: 'BUSY', message: 'уже выполняется другая операция с бэкапами' },
      busy: { type: 'restore', startedAt: '2026-10-08T10:00:00.000Z' },
    };
    agent.respond('POST', '/backups', { status: 409, body: busy });
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/admin/backups',
      headers: { cookie: admin.cookie },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(busy);

    agent.respond('POST', `/backups/${NAME}/restore`, {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'бэкап не найден' } },
    });
    const nf = await t.app.inject({
      method: 'POST',
      url: `/api/admin/backups/${NAME}/restore`,
      headers: { cookie: admin.cookie },
    });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.message).toBe('бэкап не найден');
  });

  it('агент отклонил токен, упал (5xx), ответил не-JSON или не уложился в срок — 502; токена в ответе нет', async () => {
    const cases = [
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'требуется токен агента' } } },
      { status: 500, body: { error: { code: 'INTERNAL', message: 'x' } } },
      { status: 200, raw: '<html>' },
      { status: 200, body: BACKUPS, delayMs: 1_500 },
    ];
    for (const c of cases) {
      agent.respond('GET', '/backups', c);
      const r = await t.app.inject({
        method: 'GET',
        url: '/api/admin/backups',
        headers: { cookie: admin.cookie },
      });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toEqual(UNAVAILABLE);
      expect(r.body).not.toContain(agent.token);
    }
  });

  it('features.backups = true в /api/auth/me и в ответе входа', async () => {
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: admin.cookie },
    });
    expect(me.json()).toMatchObject({
      login: admin.user.login,
      role: 'admin',
      features: { backups: true },
    });
    const fresh = await loginAs(t, 'user');
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: fresh.user.login, password: 'password123' },
    });
    expect(login.json()).toMatchObject({ features: { backups: true } });
  });

  it('соединения API помечены application_name=api и переживают pg_terminate_backend', async () => {
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: admin.cookie },
        })
      ).statusCode,
    ).toBe(200);
    const c = new pg.Client({ connectionString: t.deps.config.databaseUrl });
    await c.connect();
    const r = await c.query<{ n: number }>(
      `select count(pg_terminate_backend(pid))::int as n from pg_stat_activity
       where application_name = 'api' and datname = current_database() and pid <> pg_backend_pid()`,
    );
    await c.end();
    expect(r.rows[0]!.n).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 300));
    // Пул выбросил завершённые соединения (без обработчика error процесс бы упал) и открыл новые.
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: admin.cookie },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('бэкапы в админке: агент выключен или недоступен', () => {
  it('без BACKUP_AGENT_URL — 404 backups_disabled; features.backups = false', async () => {
    const t = await createTestApp();
    try {
      const { cookie } = await loginAs(t, 'admin');
      const r = await t.app.inject({
        method: 'GET',
        url: '/api/admin/backups',
        headers: { cookie },
      });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('backups_disabled');
      const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(me.json().features).toEqual({ backups: false });
    } finally {
      await t.close();
    }
  });

  it('агент не слушает порт — 502 backup_agent_unavailable', async () => {
    const gone = await startFakeAgent();
    await gone.close();
    const t = await createTestApp({
      backupAgent: createAgentClient({ url: gone.url, token: gone.token }),
    });
    try {
      const { cookie } = await loginAs(t, 'admin');
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/admin/backups',
        headers: { cookie },
      });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toEqual(UNAVAILABLE);
    } finally {
      await t.close();
    }
  });
});
