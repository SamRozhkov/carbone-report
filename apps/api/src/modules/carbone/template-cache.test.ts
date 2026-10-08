import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { memoryTemplateCache, redisTemplateCache } from './template-cache';

const fakeRedis = (impl: { get?: (k: string) => unknown; set?: (...a: unknown[]) => unknown }) => {
  const get = vi.fn(async (k: string) => impl.get?.(k) ?? null);
  const set = vi.fn(async (...a: unknown[]) => impl.set?.(...a) ?? 'OK');
  return { client: { get, set } as unknown as Redis, get, set };
};

describe('memoryTemplateCache', () => {
  it('возвращает сохранённое значение и null для неизвестного id', async () => {
    const cache = memoryTemplateCache();
    expect(await cache.get('a')).toBeNull();
    await cache.set('a', { version: 2, carboneId: 'x' });
    expect(await cache.get('a')).toEqual({ version: 2, carboneId: 'x' });
  });

  it('держит не больше limit записей: вытесняется самая давняя (ключи снимков — по запуску)', async () => {
    const cache = memoryTemplateCache(2);
    await cache.set('run:a', { version: 1, carboneId: 'a' });
    await cache.set('run:b', { version: 1, carboneId: 'b' });
    await cache.set('run:a', { version: 1, carboneId: 'a2' }); // повторная запись освежает ключ
    await cache.set('run:c', { version: 1, carboneId: 'c' });
    expect(await cache.get('run:b')).toBeNull();
    expect(await cache.get('run:a')).toEqual({ version: 1, carboneId: 'a2' });
    expect(await cache.get('run:c')).toEqual({ version: 1, carboneId: 'c' });
  });
});

describe('redisTemplateCache', () => {
  it('set пишет JSON по ключу cr:carbone:tpl:<id> со сроком 7 дней', async () => {
    const { client, set } = fakeRedis({});
    await redisTemplateCache(client).set('tpl-1', { version: 3, carboneId: 'abc' });
    expect(set).toHaveBeenCalledWith(
      'cr:carbone:tpl:tpl-1',
      JSON.stringify({ version: 3, carboneId: 'abc' }),
      'EX',
      604800,
    );
  });

  it('get разбирает JSON', async () => {
    const { client, get } = fakeRedis({
      get: () => JSON.stringify({ version: 1, carboneId: 'id1' }),
    });
    expect(await redisTemplateCache(client).get('tpl-1')).toEqual({ version: 1, carboneId: 'id1' });
    expect(get).toHaveBeenCalledWith('cr:carbone:tpl:tpl-1');
  });

  it('get: отсутствующий ключ → null', async () => {
    const { client } = fakeRedis({});
    expect(await redisTemplateCache(client).get('tpl-1')).toBeNull();
  });

  it('get: ошибка Redis → null', async () => {
    const { client } = fakeRedis({
      get: () => {
        throw new Error('Connection is closed.');
      },
    });
    expect(await redisTemplateCache(client).get('tpl-1')).toBeNull();
  });

  it('set: ошибка Redis поглощается', async () => {
    const { client } = fakeRedis({
      set: () => {
        throw new Error('Command timed out');
      },
    });
    await expect(
      redisTemplateCache(client).set('tpl-1', { version: 1, carboneId: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('get: битый JSON или чужая форма → null', async () => {
    for (const raw of ['{not json', '"str"', JSON.stringify({ version: '1', carboneId: 2 })]) {
      const { client } = fakeRedis({ get: () => raw });
      expect(await redisTemplateCache(client).get('tpl-1')).toBeNull();
    }
  });
});
