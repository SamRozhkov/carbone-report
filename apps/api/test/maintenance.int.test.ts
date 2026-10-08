import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedis } from '../src/lib/redis';
import { createAgentClient } from '../src/modules/backups/agent-client';
import { MAINTENANCE_KEY } from '../src/modules/maintenance/flag';
import { startFakeAgent, type FakeAgent } from './fake-agent';
import { createTestApp, loginAs, type TestApp } from './helpers';

const NAME = '2026-10-08T03-00-00Z';
const PRE = 'pre-restore-2026-10-08T10-00-00Z';
const FLAG = { phase: 'db', startedAt: '2026-10-08T10:00:05.000Z', backup: NAME };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Кэш флага в API — 1 с. */
const CACHE = 1_100;

const retry = (
  t: TestApp,
  ip: string,
  payload: object = { code: 'ABCD-EFGH-IJKL', target: 'same' },
) =>
  t.app.inject({
    method: 'POST',
    url: '/api/maintenance/retry',
    headers: { 'x-forwarded-for': ip },
    payload,
  });

describe('режим обслуживания', () => {
  let agent: FakeAgent;
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    agent = await startFakeAgent();
    agent.respond('GET', '/operation', {
      status: 200,
      body: { id: 'op1', status: 'failed', recovery: { backup: NAME, preRestore: PRE } },
    });
    agent.respond('POST', '/recovery', { status: 202, body: { operationId: 'op9' } });
    t = await createTestApp({
      backupAgent: createAgentClient({ url: agent.url, token: agent.token }),
    });
    cookie = (await loginAs(t, 'admin')).cookie;
  });
  afterAll(async () => {
    await t.close();
    await agent.close();
  });

  it('без флага: /api/maintenance — { active: false }, запросы проходят', async () => {
    const m = await t.app.inject({ method: 'GET', url: '/api/maintenance' });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({ active: false });
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200);
  });

  it('с флагом: 503 maintenance на всё, кроме белого списка; /api/maintenance с фазой и целями повтора', async () => {
    await t.deps.redis!.set(MAINTENANCE_KEY, JSON.stringify(FLAG));
    await sleep(CACHE);
    for (const [method, url] of [
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/templates'],
      ['GET', '/api/admin/backups'],
      ['GET', '/api/нет-такого'],
      ['GET', '/api/healthz'],
    ] as const) {
      const r = await t.app.inject({
        method,
        url,
        headers: { cookie },
        payload: method === 'POST' ? { login: 'a', password: 'b' } : undefined,
      });
      expect(r.statusCode, `${method} ${url}`).toBe(503);
      expect(r.json()).toEqual({
        error: {
          code: 'maintenance',
          message: 'идёт восстановление из бэкапа, повторите позже',
          details: { phase: 'db' },
        },
      });
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const m = await t.app.inject({ method: 'GET', url: '/api/maintenance?t=1' });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({
      active: true,
      ...FLAG,
      recovery: { backup: NAME, preRestore: PRE },
    });
  });

  it('retry проксирует в /recovery; неверные данные — 400 без агента', async () => {
    const before = agent.requests.length;
    expect((await retry(t, '10.0.0.9', { code: 'X' })).statusCode).toBe(400);
    expect(agent.requests.length).toBe(before);
    const r = await retry(t, '10.0.0.9');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ operationId: 'op9' });
    expect(agent.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/recovery',
      body: { code: 'ABCD-EFGH-IJKL', target: 'same' },
      auth: `Bearer ${agent.token}`,
    });
  });

  it('ответ агента 403 (неверный код) передаётся как есть', async () => {
    agent.respond('POST', '/recovery', {
      status: 403,
      body: { error: { code: 'BAD_CODE', message: 'неверный код восстановления' } },
    });
    const r = await retry(t, '10.0.0.8');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toEqual({ code: 'BAD_CODE', message: 'неверный код восстановления' });
    agent.respond('POST', '/recovery', { status: 202, body: { operationId: 'op9' } });
  });

  it('агент: 400 BAD_TARGET (нет бэкапа до восстановления) передаётся как есть', async () => {
    const message = 'нет бэкапа до восстановления';
    agent.respond('POST', '/recovery', {
      status: 400,
      body: { error: { code: 'BAD_TARGET', message } },
    });
    const r = await retry(t, '10.0.0.7', { code: 'ABCD-EFGH-IJKL', target: 'pre-restore' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: 'BAD_TARGET', message });
    agent.respond('POST', '/recovery', { status: 202, body: { operationId: 'op9' } });
  });

  it('лимит retry: 10 за 15 минут с одного IP, 11-й — 429; другой IP не задет', async () => {
    for (let i = 0; i < 10; i++) expect((await retry(t, '10.0.0.1')).statusCode).toBe(202);
    const r = await retry(t, '10.0.0.1');
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect((await retry(t, '10.0.0.2')).statusCode).toBe(202);
  });

  it('после снятия флага запросы проходят, пулы источников сброшены', async () => {
    const closeAll = vi.spyOn(t.deps.sources, 'closeAll');
    await t.deps.redis!.del(MAINTENANCE_KEY);
    await sleep(CACHE);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode,
    ).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/maintenance' })).json()).toEqual({
      active: false,
    });
    expect(closeAll).toHaveBeenCalledTimes(1);
  });
});

describe('режим обслуживания без Redis и без агента', () => {
  it('Redis недоступен — fail-open: запросы проходят, лимит retry не применяется', async () => {
    const agent = await startFakeAgent();
    agent.respond('POST', '/recovery', {
      status: 409,
      body: { error: { code: 'NO_RECOVERY', message: 'восстановление по коду не требуется' } },
    });
    const deadRedis: Redis = createRedis('redis://127.0.0.1:1', { warn: () => {} });
    const t = await createTestApp({
      redis: deadRedis,
      backupAgent: createAgentClient({ url: agent.url, token: agent.token }),
    });
    try {
      expect((await t.app.inject({ method: 'GET', url: '/api/maintenance' })).json()).toEqual({
        active: false,
      });
      const { cookie } = await loginAs(t, 'admin');
      expect(
        (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } }))
          .statusCode,
      ).toBe(200);
      for (let i = 0; i < 12; i++) expect((await retry(t, '10.0.0.3')).statusCode).toBe(409);
    } finally {
      await t.close();
      deadRedis.disconnect();
      await agent.close();
    }
  });

  it('без агента: retry — 404 backups_disabled, recovery в статусе — null', async () => {
    const t = await createTestApp();
    try {
      await t.deps.redis!.set(MAINTENANCE_KEY, JSON.stringify(FLAG));
      const m = await t.app.inject({ method: 'GET', url: '/api/maintenance' });
      expect(m.json()).toEqual({ active: true, ...FLAG, recovery: null });
      const r = await retry(t, '10.0.0.4');
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('backups_disabled');
    } finally {
      await t.close();
    }
  });
});
