import type pg from 'pg';
import type { RemoveGate } from './storage';

/** Общий с docker/backup/backup.sh ключ: бэкап берёт его исключительно, удаления — разделяемо. */
export const STORAGE_REMOVE_LOCK_KEY = 726100001;

/**
 * Пул должен быть отдельным и небольшим: ожидающие удаления занимают его соединения, а не основной пул API.
 * При любой ошибке запроса соединение уничтожается: закрытие сессии снимает её advisory-блокировки,
 * так что сбой разблокировки не может навсегда заблокировать бэкап.
 */
export function createRemoveGate(pool: pg.Pool): RemoveGate {
  const gate: RemoveGate = async (fn) => {
    const client = await pool.connect();
    let broken = false;
    try {
      try {
        await client.query('select pg_advisory_lock_shared($1)', [STORAGE_REMOVE_LOCK_KEY]);
      } catch (err) {
        broken = true;
        throw err;
      }
      try {
        return await fn();
      } finally {
        try {
          await client.query('select pg_advisory_unlock_shared($1)', [STORAGE_REMOVE_LOCK_KEY]);
        } catch {
          // Результат fn важнее; соединение уничтожается ниже и снимает блокировку само.
          broken = true;
        }
      }
    } finally {
      client.release(broken);
    }
  };
  return gate;
}
