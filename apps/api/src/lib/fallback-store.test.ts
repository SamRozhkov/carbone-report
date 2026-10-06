import LocalStore from '@fastify/rate-limit/store/LocalStore.js';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fallbackStore, type FallbackStore } from './fallback-store';

type Res = { current: number; ttl: number };

/**
 * Фейковый ioredis-клиент для настоящего RedisStore: команды rateLimit/rateLimitRead
 * уже «определены», ответ приходит асинхронно, как от сети. `down` — Redis отвечает ошибкой.
 */
function fakeRedis() {
  const counts = new Map<string, number>();
  const r = {
    down: false,
    /** Команда бросает синхронно, не вызывая колбэк. */
    throws: false,
    keys: [] as string[],
    defineCommand: vi.fn(),
    rateLimit(
      key: string,
      timeWindow: number,
      _max: number,
      _ce: boolean,
      _eb: boolean,
      cb: (err: Error | null, res?: [number, number]) => void,
    ) {
      r.keys.push(key);
      if (r.throws) throw new Error('sync boom');
      queueMicrotask(() => {
        if (r.down) return cb(new Error('Connection is closed.'));
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        cb(null, [n, timeWindow]);
      });
    },
    rateLimitRead(key: string, cb: (err: Error | null, res?: [number, number]) => void) {
      r.keys.push(key);
      queueMicrotask(() => (r.down ? cb(new Error('down')) : cb(null, [counts.get(key) ?? 0, 1])));
    },
  };
  return r;
}

const params = { continueExceeding: false, exponentialBackoff: false };
const route = (method: string, url: string) => ({ ...params, routeInfo: { method, url } });

function call(store: FallbackStore, key: string, method: 'incr' | 'read' = 'incr') {
  return new Promise<Res>((resolve, reject) =>
    store[method](key, (err, res) => (err ? reject(err) : resolve(res as Res)), 60_000, 10),
  );
}

function setup(redis = fakeRedis()) {
  const warn = vi.fn();
  const Ctor = fallbackStore({
    redis: redis as unknown as Redis,
    nameSpace: 'cr:rl:',
    log: { warn },
  });
  // Плагин создаёт хранилище как `new Store(globalParams)`.
  const store = new Ctor(params as never) as FallbackStore;
  return { redis, warn, store, Ctor };
}

describe('fallbackStore', () => {
  let localIncr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    localIncr = vi.spyOn(LocalStore.prototype, 'incr');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('Redis работает: счёт идёт в Redis под nameSpace, LocalStore не трогается', async () => {
    const { redis, store, warn } = setup();
    expect(await call(store, 'x')).toEqual({ current: 1, ttl: 60_000 });
    expect(await call(store, 'x')).toEqual({ current: 2, ttl: 60_000 });
    expect(redis.keys).toEqual(['cr:rl:x', 'cr:rl:x']);
    expect(localIncr).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('ошибка Redis: тот же вызов уходит в память, 5 с Redis не трогается, потом пробуется снова', async () => {
    const { redis, store } = setup();
    redis.down = true;
    // Ошибка наружу не выходит: первый вызов посчитан в памяти.
    expect(await call(store, 'x')).toMatchObject({ current: 1 });
    expect(redis.keys).toHaveLength(1);
    expect(localIncr).toHaveBeenCalledTimes(1);

    // Автомат разомкнут: Redis не спрашивается, счёт в памяти продолжается.
    for (let i = 2; i <= 11; i++) expect(await call(store, 'x')).toMatchObject({ current: i });
    expect(redis.keys).toHaveLength(1);

    vi.setSystemTime(1_000_000 + 4_999);
    await call(store, 'x');
    expect(redis.keys).toHaveLength(1);

    // Через 5 с автомат пробует Redis; Redis снова жив — счёт идёт туда.
    redis.down = false;
    vi.setSystemTime(1_000_000 + 5_000);
    expect(await call(store, 'x')).toEqual({ current: 1, ttl: 60_000 });
    expect(redis.keys).toHaveLength(2);
    const localCalls = localIncr.mock.calls.length;
    await call(store, 'x');
    expect(localIncr.mock.calls.length).toBe(localCalls);
  });

  it('после 5 с Redis всё ещё недоступен — снова память и новый период', async () => {
    const { redis, store } = setup();
    redis.down = true;
    await call(store, 'x');
    vi.setSystemTime(1_000_000 + 5_000);
    expect(await call(store, 'x')).toMatchObject({ current: 2 });
    expect(redis.keys).toHaveLength(2);
    vi.setSystemTime(1_000_000 + 9_999);
    await call(store, 'x');
    expect(redis.keys).toHaveLength(2);
  });

  it('предупреждение не чаще раза за период автомата, даже при параллельных ошибках', async () => {
    const { redis, store, warn } = setup();
    redis.down = true;
    // Три запроса ушли в Redis одновременно и все получили ошибку.
    await Promise.all([call(store, 'a'), call(store, 'b'), call(store, 'c')]);
    expect(redis.keys).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ err: 'Connection is closed.' });

    await call(store, 'a');
    expect(warn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 5_000);
    await call(store, 'a');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('Redis бросает синхронно: вызов уходит в память, автомат размыкается', async () => {
    const { redis, store, warn } = setup();
    redis.throws = true;
    expect(await call(store, 'x')).toMatchObject({ current: 1 });
    expect(localIncr).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ err: 'sync boom' });
    expect(warn.mock.calls[0]?.[1]).toBe(
      'Redis недоступен — лимиты запросов считаются в памяти экземпляра',
    );
    expect(await call(store, 'x')).toMatchObject({ current: 2 });
    expect(redis.keys).toHaveLength(1);
  });

  it('child для маршрута: ключ как у RedisStore.child, автомат общий с корнем и соседями', async () => {
    const { redis, store, warn } = setup();
    const login = store.child(route('POST', '/api/auth/login') as never) as FallbackStore;
    const other = store.child(route('POST', '/api/other') as never) as FallbackStore;
    await call(login, 'x');
    expect(redis.keys).toEqual(['cr:rl:POST/api/auth/login-x']);

    redis.down = true;
    expect(await call(login, 'x')).toMatchObject({ current: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    // Автомат разомкнут для всех хранилищ этого экземпляра.
    await call(other, 'x');
    await call(store, 'x');
    expect(redis.keys).toHaveLength(2);
    // Память у маршрутов раздельная, как у LocalStore.child.
    expect(await call(login, 'x')).toMatchObject({ current: 2 });
    expect(await call(other, 'x')).toMatchObject({ current: 2 });
  });

  it('child с nameSpace (createRateLimit): свой префикс ключа в Redis', async () => {
    const { redis, store } = setup();
    const ip = store.child({ ...params, nameSpace: 'cr:rl-ip:', routeInfo: {} } as never);
    await call(ip as FallbackStore, '10.0.0.1');
    expect(redis.keys).toEqual(['cr:rl-ip:10.0.0.1']);
  });

  it('read: Redis, а при ошибке — память без увеличения счётчика', async () => {
    const { redis, store } = setup();
    await call(store, 'x');
    expect(await call(store, 'x', 'read')).toMatchObject({ current: 1 });
    redis.down = true;
    await call(store, 'x');
    await call(store, 'x');
    expect(await call(store, 'x', 'read')).toMatchObject({ current: 2 });
    expect(await call(store, 'x', 'read')).toMatchObject({ current: 2 });
  });

  it('конструктор хранилища — независимые автоматы у разных экземпляров плагина', async () => {
    const { redis, Ctor, store: a } = setup();
    const b = new Ctor(params as never) as FallbackStore;
    redis.down = true;
    await call(a, 'x');
    redis.down = false;
    await call(b, 'x');
    expect(redis.keys).toHaveLength(2);
  });
});
