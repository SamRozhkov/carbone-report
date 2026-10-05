import type pg from 'pg';
import type { RemoveGate } from './storage';

/** Общий с docker/backup/backup.sh ключ: бэкап берёт его исключительно, удаления — разделяемо. */
export const STORAGE_REMOVE_LOCK_KEY = 726100001;

export function createRemoveGate(pool: pg.Pool): RemoveGate {
  return async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('select pg_advisory_lock_shared($1)', [STORAGE_REMOVE_LOCK_KEY]);
      try {
        return await fn();
      } finally {
        await client.query('select pg_advisory_unlock_shared($1)', [STORAGE_REMOVE_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  };
}
