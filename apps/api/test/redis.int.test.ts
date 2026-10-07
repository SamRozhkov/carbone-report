import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createRedis } from '../src/lib/redis';
import { CarboneClient } from '../src/modules/carbone/client';
import { redisTemplateCache } from '../src/modules/carbone/template-cache';
import { createTestApp, createTestRedis } from './helpers';

function fakeCarbone() {
  const counter = { uploads: 0 };
  const fn = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/template')) {
      counter.uploads++;
      return new Response(
        JSON.stringify({ success: true, data: { templateId: `cid${counter.uploads}` } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(Buffer.from('%PDF-1.7 test'), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    });
  }) as typeof fetch;
  return { fn, counter };
}

const tpl = () => ({
  id: randomUUID(),
  version: 1,
  ext: 'docx' as const,
  read: async () => Buffer.from('PK\x03\x04docx'),
});
const opts = {
  convertTo: 'pdf' as const,
  lang: 'ru',
  timezone: 'Europe/Moscow',
  timeoutMs: 5000,
};

/** Адрес тестового Redis с другим паролем (`null` — без пароля). */
function redisUrlWithPassword(password: string | null): string {
  const url = new URL(inject('redisUrl'));
  url.username = '';
  url.password = password ?? '';
  return url.toString();
}

/** Клиент, который пишет предупреждения в массив, и ожидание первого предупреждения. */
function loggedRedis(url: string) {
  const warns: { o: object; m: string }[] = [];
  const redis = createRedis(url, { warn: (o, m) => warns.push({ o, m }) });
  const firstWarn = async () => {
    for (let i = 0; i < 60 && warns.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return warns[0];
  };
  return { redis, warns, firstWarn };
}

describe('Redis', () => {
  const clients: Redis[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => c.disconnect())));
  });

  it('кэш Carbone общий: два клиента на одном Redis загружают шаблон один раз', async () => {
    const prefix = `t_${randomUUID()}:`;
    const a = await createTestRedis(prefix);
    const b = await createTestRedis(prefix);
    clients.push(a, b);
    const { fn, counter } = fakeCarbone();
    const t = tpl();
    const c1 = new CarboneClient({ baseUrl: 'http://c', fetch: fn, cache: redisTemplateCache(a) });
    const c2 = new CarboneClient({ baseUrl: 'http://c', fetch: fn, cache: redisTemplateCache(b) });
    expect((await c1.render(t, {}, opts)).toString()).toBe('%PDF-1.7 test');
    // Запись в кэш идёт в фоне (без await) — ждём появления ключа, но не дольше 2 с.
    const key = `cr:carbone:tpl:${t.id}`;
    for (let i = 0; i < 40 && !(await b.exists(key)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await c2.render(t, {}, opts)).toString()).toBe('%PDF-1.7 test');
    expect(counter.uploads).toBe(1);
    // Ключ лежит по ожидаемому имени со сроком жизни 7 дней.
    expect(JSON.parse((await a.get(key))!)).toEqual({
      version: 1,
      carboneId: 'cid1',
    });
    const ttl = await a.ttl(key);
    expect(ttl).toBeGreaterThan(604800 - 60);
    expect(ttl).toBeLessThanOrEqual(604800);
  });

  it('Redis недоступен: рендер проходит быстро, шаблон загружается', async () => {
    const warns: string[] = [];
    const down = createRedis('redis://127.0.0.1:1', { warn: (_o, m) => warns.push(m) });
    clients.push(down);
    const { fn, counter } = fakeCarbone();
    const client = new CarboneClient({
      baseUrl: 'http://c',
      fetch: fn,
      cache: redisTemplateCache(down),
    });
    const t = tpl();
    const started = Date.now();
    expect((await client.render(t, {}, opts)).toString()).toBe('%PDF-1.7 test');
    expect((await client.render(t, {}, opts)).toString()).toBe('%PDF-1.7 test');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(counter.uploads).toBe(2);
    // Повторные ошибки соединения не засоряют лог.
    await new Promise((r) => setTimeout(r, 300));
    expect(warns.length).toBeLessThanOrEqual(1);
  });

  it('тестовый Redis требует пароль: адрес из global-setup его содержит', () => {
    expect(new URL(inject('redisUrl')).password).toMatch(/^[0-9a-f]{32,}$/);
  });

  it('клиент без пароля: Redis отвечает NOAUTH, кэш считается промахом, рендер проходит', async () => {
    const { redis, firstWarn } = loggedRedis(redisUrlWithPassword(null));
    clients.push(redis);
    // ioredis сообщает об отказе аутентификации событием `error` (проверка готовности
    // получает NOAUTH) и переподключается; пока клиент не готов, команды отклоняются сразу.
    const warn = await firstWarn();
    expect(warn).toBeDefined();
    expect(JSON.stringify(warn!.o)).toContain('NOAUTH');
    await expect(redis.get('k')).rejects.toThrow();
    const { fn, counter } = fakeCarbone();
    const client = new CarboneClient({
      baseUrl: 'http://c',
      fetch: fn,
      cache: redisTemplateCache(redis),
    });
    const t = tpl();
    expect((await client.render(t, {}, opts)).toString()).toBe('%PDF-1.7 test');
    expect((await client.render(t, {}, opts)).toString()).toBe('%PDF-1.7 test');
    expect(counter.uploads).toBe(2);
  });

  it('клиент с неверным паролем: WRONGPASS в журнале, рендер проходит быстро', async () => {
    const { redis, warns, firstWarn } = loggedRedis(redisUrlWithPassword('0'.repeat(64)));
    clients.push(redis);
    const { fn, counter } = fakeCarbone();
    const client = new CarboneClient({
      baseUrl: 'http://c',
      fetch: fn,
      cache: redisTemplateCache(redis),
    });
    const t = tpl();
    const started = Date.now();
    expect((await client.render(t, {}, opts)).toString()).toBe('%PDF-1.7 test');
    expect((await client.render(t, {}, opts)).toString()).toBe('%PDF-1.7 test');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(counter.uploads).toBe(2);
    const warn = await firstWarn();
    expect(warn).toBeDefined();
    expect(warn!.m).toContain('Redis недоступен');
    expect(JSON.stringify(warn!.o)).toContain('WRONGPASS');
    // Повторные ошибки аутентификации (ioredis переподключается) не засоряют лог.
    await new Promise((r) => setTimeout(r, 300));
    expect(warns.length).toBe(1);
  });

  it('createTestApp по умолчанию даёт приложению Redis с отдельным префиксом', async () => {
    const t1 = await createTestApp();
    const t2 = await createTestApp();
    try {
      expect(t1.deps.redis).not.toBeNull();
      await t1.deps.redis!.set('k', '1');
      expect(await t1.deps.redis!.get('k')).toBe('1');
      expect(await t2.deps.redis!.get('k')).toBeNull();
    } finally {
      await t1.close();
      await t2.close();
    }
  });

  it('createTestApp({ redis: null }) работает без Redis', async () => {
    const t = await createTestApp({ redis: null });
    try {
      expect(t.deps.redis).toBeNull();
      const res = await t.app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });
});
