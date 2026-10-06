import { Redis } from 'ioredis';

export interface RedisLog {
  warn(o: object, m: string): void;
}

/**
 * Клиент Redis с короткими таймаутами: недоступный Redis не задерживает запросы.
 * Пока соединения нет, команды сразу отклоняются (`enableOfflineQueue: false`),
 * ioredis в фоне переподключается. Ошибки пишутся в лог не чаще раза в 30 с.
 * `keyPrefix` нужен тестам для изоляции; в приложении ключи уже начинаются с `cr:`.
 */
export function createRedis(url: string, log: RedisLog, opts: { keyPrefix?: string } = {}): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    commandTimeout: 500,
    lazyConnect: false,
    ...(opts.keyPrefix ? { keyPrefix: opts.keyPrefix } : {}),
  });
  let lastLog = 0;
  redis.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLog > 30_000) {
      lastLog = now;
      log.warn(
        { err: err.message },
        'Redis недоступен — кэш промахивается, лимиты считаются в памяти экземпляра',
      );
    }
  });
  return redis;
}
