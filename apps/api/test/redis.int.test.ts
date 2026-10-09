import type { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createRedis } from '../src/lib/redis';
import { createTestApp } from './helpers';

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

  it('Redis недоступен: команды отклоняются быстро, лог не засоряется', async () => {
    const warns: string[] = [];
    const down = createRedis('redis://127.0.0.1:1', { warn: (_o, m) => warns.push(m) });
    clients.push(down);
    const started = Date.now();
    await expect(down.get('k')).rejects.toThrow();
    await expect(down.get('k')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
    // Повторные ошибки соединения не засоряют лог.
    await new Promise((r) => setTimeout(r, 300));
    expect(warns.length).toBeLessThanOrEqual(1);
  });

  it('тестовый Redis требует пароль: адрес из global-setup его содержит', () => {
    expect(new URL(inject('redisUrl')).password).toMatch(/^[0-9a-f]{32,}$/);
  });

  it('клиент без пароля: Redis отвечает NOAUTH, команды отклоняются', async () => {
    const { redis, firstWarn } = loggedRedis(redisUrlWithPassword(null));
    clients.push(redis);
    // ioredis сообщает об отказе аутентификации событием `error` (проверка готовности
    // получает NOAUTH) и переподключается; пока клиент не готов, команды отклоняются сразу.
    const warn = await firstWarn();
    expect(warn).toBeDefined();
    expect(JSON.stringify(warn!.o)).toContain('NOAUTH');
    await expect(redis.get('k')).rejects.toThrow();
  });

  it('клиент с неверным паролем: WRONGPASS в журнале, команды отклоняются быстро', async () => {
    const { redis, warns, firstWarn } = loggedRedis(redisUrlWithPassword('0'.repeat(64)));
    clients.push(redis);
    const started = Date.now();
    await expect(redis.get('k')).rejects.toThrow();
    await expect(redis.get('k')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
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
