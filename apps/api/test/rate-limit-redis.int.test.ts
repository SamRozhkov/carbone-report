import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createRedis } from '../src/lib/redis';
import { createTestApp, createTestRedis, loginAs, type TestApp } from './helpers';

const attempt = (t: TestApp, login: string, password: string) =>
  t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password } });

describe('лимит входа в Redis', () => {
  const clients: Redis[] = [];
  const apps: TestApp[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((t) => t.close()));
    await Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));
  });

  it('лимит общий для двух экземпляров API на одном Redis', async () => {
    const redis = await createTestRedis(`t_${randomUUID()}:`);
    clients.push(redis);
    const a = await createTestApp({ redis });
    apps.push(a);
    const b = await createTestApp({ redis });
    apps.push(b);

    // 6 попыток через A и 4 через B — ровно лимит (10), все отклонены паролем.
    for (let i = 0; i < 6; i++) expect((await attempt(a, 'x', 'bad')).statusCode).toBe(401);
    for (let i = 0; i < 4; i++) expect((await attempt(b, 'x', 'bad')).statusCode).toBe(401);
    // 11-я попытка (5-я через B) уже упирается в общий лимит, следующая — тоже.
    const eleventh = await attempt(b, 'x', 'bad');
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json()).toMatchObject({ error: { code: 'TOO_MANY_ATTEMPTS' } });
    expect((await attempt(b, 'X', 'bad')).statusCode).toBe(429);
    expect((await attempt(a, 'x', 'bad')).statusCode).toBe(429);
    // Счётчик лежит в Redis под пространством имён cr:rl:.
    const keys = await redis.keys(`${redis.options.keyPrefix}cr:rl:*`);
    expect(keys).toHaveLength(1);
  });

  // Redis отвечает ошибкой: лимит считается в памяти экземпляра (11-я попытка — 429), а
  // автомат после первой ошибки 5 с не обращается к Redis, поэтому запросы не ждут его.
  async function expectMemoryLimit(redisUrl: string) {
    const down = createRedis(redisUrl, { warn: () => {} });
    clients.push(down);
    const t = await createTestApp({ redis: down });
    apps.push(t);

    const all = Date.now();
    for (let i = 1; i <= 12; i++) {
      const started = Date.now();
      const res = await attempt(t, 'x', 'bad');
      expect(res.statusCode).toBe(i <= 10 ? 401 : 429);
      if (i > 10) expect(res.json()).toMatchObject({ error: { code: 'TOO_MANY_ATTEMPTS' } });
      expect(Date.now() - started).toBeLessThan(1000);
    }
    expect(Date.now() - all).toBeLessThan(2000);
    // Другой логин не задет; вход верным паролем быстрый и без 500.
    const started = Date.now();
    await loginAs(t, 'user');
    expect(Date.now() - started).toBeLessThan(1000);
  }

  it('Redis недоступен: лимит в памяти, 11-я попытка — 429, всё быстро', async () => {
    await expectMemoryLimit('redis://127.0.0.1:1');
  });

  it('неверный пароль Redis: лимит в памяти, 11-я попытка — 429, всё быстро', async () => {
    const url = new URL(inject('redisUrl'));
    url.password = '0'.repeat(64);
    await expectMemoryLimit(url.toString());
  });
});
