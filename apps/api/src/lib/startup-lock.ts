import type pg from 'pg';

/** Миграции схемы и файлов при старте API (§27.4). 726100001 — бэкап и удаление файлов, 726100002 — сборка файлов запуска. */
export const STARTUP_LOCK_KEY = 726100003;

/**
 * fn под сессионной advisory-блокировкой на отдельном соединении: реплики API, стартующие
 * одновременно, выполняют миграции по очереди; следующая видит, что всё уже применено.
 * Если снять блокировку не удалось (соединение оборвано), соединение уничтожается —
 * закрытие сессии снимает её блокировки.
 */
export async function withStartupLock<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('select pg_advisory_lock($1::bigint)', [STARTUP_LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await client.query('select pg_advisory_unlock($1::bigint)', [STARTUP_LOCK_KEY]).catch(() => {
        destroy = true;
      });
    }
  } finally {
    client.release(destroy);
  }
}
