import type { FastifyRateLimitStore, FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import LocalStore from '@fastify/rate-limit/store/LocalStore.js';
import RedisStore from '@fastify/rate-limit/store/RedisStore.js';
import type { Redis } from 'ioredis';

type Incr = FastifyRateLimitStore['incr'];
type Callback = Parameters<Incr>[1];
type Inner = FastifyRateLimitStore & { read: Incr };

/** Хранилище с методом `read`: его вызывает `createRateLimit` при `{ increment: false }`. */
export type FallbackStore = FastifyRateLimitStore & { read: Incr };

export interface FallbackStoreOptions {
  /** ioredis-клиент. Плагин не передаёт `redis` в конструктор своего `store`, поэтому он здесь. */
  redis: Redis;
  /** Префикс ключей корневого хранилища (как `nameSpace` плагина). */
  nameSpace?: string;
  /** Сколько миллисекунд после ошибки Redis считать только в памяти. */
  breakMs?: number;
  log?: { warn(o: object, m: string): void };
}

/** Параметры, которые плагин передаёт в `new Store(...)` и в `store.child(...)` (11.2). */
interface StoreParams {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
  /** Своё поле: `createRateLimit({ nameSpace })` задаёт префикс ключей дочернего хранилища. */
  nameSpace?: string;
}

/** Автомат общий для корневого хранилища и всех его `child`. */
interface Breaker {
  openUntil: number;
  lastWarn: number;
}

/**
 * Конструктор хранилища для `@fastify/rate-limit`: счёт идёт в Redis (`RedisStore`),
 * а если Redis ответил ошибкой — в памяти экземпляра (`LocalStore`). После ошибки
 * автомат размыкается на `breakMs`: всё это время Redis не спрашивается и запросы не
 * ждут его таймаутов. Затем следующий вызов снова пробует Redis.
 *
 * Плагин создаёт хранилище как `new Store(globalParams)` и для маршрутных настроек
 * (`config.rateLimit`, `createRateLimit(opts)`) вызывает `store.child(mergedParams)`.
 */
export function fallbackStore(opts: FallbackStoreOptions): FastifyRateLimitStoreCtor {
  const breakMs = opts.breakMs ?? 5000;

  class Store implements FallbackStore {
    private readonly primary: Inner;
    private readonly local: Inner;
    private readonly breaker: Breaker;

    constructor(params: StoreParams, parent?: { primary: Inner; local: Inner; breaker: Breaker }) {
      if (parent) {
        ({ primary: this.primary, local: this.local, breaker: this.breaker } = parent);
        return;
      }
      const ce = params.continueExceeding ?? false;
      const eb = params.exponentialBackoff ?? false;
      this.primary = new RedisStore(ce, eb, opts.redis, opts.nameSpace);
      this.local = new LocalStore(ce, eb);
      this.breaker = { openUntil: 0, lastWarn: -Infinity };
    }

    incr(key: string, cb: Callback, timeWindow: number, max: number): void {
      this.run('incr', key, cb, timeWindow, max);
    }

    read(key: string, cb: Callback, timeWindow: number, max: number): void {
      this.run('read', key, cb, timeWindow, max);
    }

    child(routeOptions: Parameters<FastifyRateLimitStore['child']>[0]): FallbackStore {
      const p = routeOptions as unknown as StoreParams;
      // RedisStore.child добавляет к префиксу `${method}${url}-` маршрута. У createRateLimit
      // маршрута нет (routeInfo = {}), поэтому там префикс задаётся явно через nameSpace.
      const primary =
        typeof p.nameSpace === 'string'
          ? new RedisStore(
              p.continueExceeding ?? false,
              p.exponentialBackoff ?? false,
              opts.redis,
              p.nameSpace,
            )
          : (this.primary.child(routeOptions) as Inner);
      const local = this.local.child(routeOptions) as Inner;
      return new Store({}, { primary, local, breaker: this.breaker });
    }

    private run(
      method: 'incr' | 'read',
      key: string,
      cb: Callback,
      timeWindow: number,
      max: number,
    ) {
      if (Date.now() < this.breaker.openUntil) {
        this.local[method](key, cb, timeWindow, max);
        return;
      }
      this.primary[method](
        key,
        (err, res) => {
          if (!err) return cb(null, res);
          this.trip(err);
          this.local[method](key, cb, timeWindow, max);
        },
        timeWindow,
        max,
      );
    }

    private trip(err: Error) {
      const now = Date.now();
      this.breaker.openUntil = now + breakMs;
      if (now - this.breaker.lastWarn >= breakMs) {
        this.breaker.lastWarn = now;
        opts.log?.warn(
          { err: err.message, retryInMs: breakMs },
          'Redis недоступен — лимит входа считается в памяти экземпляра',
        );
      }
    }
  }

  return Store as unknown as FastifyRateLimitStoreCtor;
}
