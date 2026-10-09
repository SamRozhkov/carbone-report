import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import type { Db } from '../db/client';
import * as schema from '../db/schema';
import { isLockTimeout } from './db-errors';
import { type Deadline, reportTimeout } from './deadline';
import { AppError } from './errors';

export type RunFileTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Транзакция под advisory-блокировкой (класс, hashtext(key)) на отдельном пуле. Всё ограничено `deadline`:
 * и получение соединения, и ожидание блокировки (lock_timeout); не успели — TIMEOUT 504.
 */
export type RunFileGate = <T>(
  lockClass: number,
  key: string,
  deadline: Deadline,
  fn: (tx: RunFileTx) => Promise<T>,
) => Promise<T>;

/**
 * Пул должен быть отдельным и небольшим (как у createRemoveGate): сборка держит соединение всё время
 * рендера (Carbone и конвертация), а ожидающие чужую сборку другого экземпляра API спят в pg_advisory_xact_lock.
 * На основном пуле десяток таких запросов остановил бы все остальные маршруты.
 * При ошибке не из приложения соединение уничтожается: закрытие сессии снимает её блокировки.
 */
export function createRunFileGate(pool: pg.Pool): RunFileGate {
  async function acquire(deadline: Deadline): Promise<pg.PoolClient> {
    const pending = pool.connect();
    try {
      return await deadline.race(pending);
    } catch (e) {
      // Срок истёк раньше, чем освободилось соединение: вернуть его в пул, когда придёт.
      pending.then(
        (c) => c.release(),
        () => {},
      );
      throw e;
    }
  }

  return async (lockClass, key, deadline, fn) => {
    const client = await acquire(deadline);
    let broken = false;
    try {
      return await drizzle(client, { schema }).transaction(async (tx) => {
        // Ждать чужую сборку — не дольше остатка срока; set_config(..., true) действует до конца транзакции.
        const wait = `${deadline.cap(deadline.remaining())}ms`;
        await tx.execute(sql`select set_config('lock_timeout', ${wait}, true)`);
        await tx.execute(
          sql`select pg_advisory_xact_lock(${lockClass}::int, hashtext(${key}::text))`,
        );
        return fn(tx);
      });
    } catch (e) {
      if (isLockTimeout(e)) throw reportTimeout();
      if (!(e instanceof AppError)) broken = true;
      throw e;
    } finally {
      client.release(broken);
    }
  };
}
