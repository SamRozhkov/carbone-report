// Встроенные хранилища @fastify/rate-limit 11.2 не имеют своих типов. Сигнатуры
// конструкторов взяты из store/RedisStore.js и store/LocalStore.js.
declare module '@fastify/rate-limit/store/RedisStore.js' {
  import type { FastifyRateLimitStore } from '@fastify/rate-limit';
  const RedisStore: new (
    continueExceeding: boolean,
    exponentialBackoff: boolean,
    // ioredis-клиент: хранилище регистрирует на нём команды rateLimit/rateLimitRead.
    redis: import('ioredis').Redis,
    key?: string,
  ) => FastifyRateLimitStore & { read: FastifyRateLimitStore['incr'] };
  export default RedisStore;
}

declare module '@fastify/rate-limit/store/LocalStore.js' {
  import type { FastifyRateLimitStore } from '@fastify/rate-limit';
  const LocalStore: new (
    continueExceeding: boolean,
    exponentialBackoff: boolean,
    cache?: number,
  ) => FastifyRateLimitStore & { read: FastifyRateLimitStore['incr'] };
  export default LocalStore;
}
