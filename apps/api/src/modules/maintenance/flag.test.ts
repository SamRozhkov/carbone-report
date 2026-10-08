import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_KEY, watchMaintenance } from './flag';

const FLAG = JSON.stringify({
  phase: 'db',
  startedAt: '2026-10-08T10:00:00.000Z',
  backup: '2026-10-08T03-00-00Z',
});

function fakeRedis(values: (string | null | Error)[]) {
  let i = 0;
  const get = vi.fn(async (key: string) => {
    expect(key).toBe(MAINTENANCE_KEY);
    const v = values[Math.min(i++, values.length - 1)]!;
    if (v instanceof Error) throw v;
    return v;
  });
  return { redis: { get } as unknown as Redis, get };
}

const watches: { stop(): void }[] = [];
afterEach(() => watches.splice(0).forEach((w) => w.stop()));

function watch(redis: Redis | null, o: Parameters<typeof watchMaintenance>[1] = {}) {
  const w = watchMaintenance(redis, o);
  watches.push(w);
  return w;
}

describe('watchMaintenance', () => {
  it('нет Redis — обслуживания нет', async () => {
    expect(await watch(null).get()).toBeNull();
  });

  it('значение кэшируется на 1 с; одновременные вызовы делят один GET', async () => {
    let now = 0;
    const { redis, get } = fakeRedis([FLAG, null]);
    const w = watch(redis, { now: () => now });
    const [a, b] = await Promise.all([w.get(), w.get()]);
    expect(a).toEqual(JSON.parse(FLAG));
    expect(b).toEqual(a);
    expect(get).toHaveBeenCalledTimes(1);
    now = 999;
    expect(await w.get()).toEqual(a);
    expect(get).toHaveBeenCalledTimes(1);
    now = 1000;
    expect(await w.get()).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('ошибка Redis — fail-open', async () => {
    const { redis } = fakeRedis([new Error('Connection is closed.')]);
    expect(await watch(redis).get()).toBeNull();
  });

  it('флаг с неверным JSON — всё равно обслуживание', async () => {
    const { redis } = fakeRedis(['не json']);
    expect(await watch(redis).get()).toEqual({ phase: '', startedAt: '', backup: '' });
  });

  it('onEnd вызывается при снятии флага, один раз', async () => {
    let now = 0;
    const onEnd = vi.fn();
    const { redis } = fakeRedis([FLAG, FLAG, null, null]);
    const w = watch(redis, { now: () => now, onEnd });
    for (let i = 0; i < 4; i++) {
      await w.get();
      now += 1000;
    }
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
