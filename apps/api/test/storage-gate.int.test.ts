import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRemoveGate, STORAGE_REMOVE_LOCK_KEY } from '../src/lib/storage-gate';
import { createTestDatabase } from './helpers';

let pool: pg.Pool;
let holder: pg.Client;

beforeAll(async () => {
  const url = await createTestDatabase();
  pool = new pg.Pool({ connectionString: url, max: 3 });
  holder = new pg.Client({ connectionString: url });
  await holder.connect();
});
afterAll(async () => {
  await holder.end();
  await pool.end();
});

it('удаление ждёт, пока держится исключительная блокировка бэкапа, затем выполняется', async () => {
  const gate = createRemoveGate(pool);
  await holder.query('select pg_advisory_lock($1)', [STORAGE_REMOVE_LOCK_KEY]);
  let done = false;
  const p = gate(async () => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(done).toBe(false);
  await holder.query('select pg_advisory_unlock($1)', [STORAGE_REMOVE_LOCK_KEY]);
  await p;
  expect(done).toBe(true);
});

it('два удаления не мешают друг другу (разделяемая блокировка)', async () => {
  const gate = createRemoveGate(pool);
  let inside = 0;
  let maxInside = 0;
  const op = () =>
    gate(async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 100));
      inside--;
    });
  await Promise.all([op(), op()]);
  expect(maxInside).toBe(2);
});

it('ошибка внутри шлюза снимает блокировку и возвращает соединение', async () => {
  const gate = createRemoveGate(pool);
  await expect(
    gate(async () => {
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  const { rows } = await holder.query('select pg_try_advisory_lock($1) as ok', [
    STORAGE_REMOVE_LOCK_KEY,
  ]);
  expect(rows[0].ok).toBe(true);
  await holder.query('select pg_advisory_unlock($1)', [STORAGE_REMOVE_LOCK_KEY]);
  // Соединение шлюза возвращено в пул.
  expect(pool.totalCount - pool.idleCount).toBe(0);
});
