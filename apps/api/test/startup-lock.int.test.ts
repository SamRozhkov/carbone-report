import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, migrateDb } from '../src/db/client';
import { STARTUP_LOCK_KEY, withStartupLock } from '../src/lib/startup-lock';
import { createTestDatabase } from './helpers';

const pools: pg.Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Отдельный пул на «реплику»: как у API, max 10 соединений. */
function replica(url: string) {
  const { db, pool } = createDb(url);
  pools.push(pool);
  return { db, pool };
}

describe('withStartupLock', () => {
  it('три реплики стартуют одновременно на пустой базе: миграции один раз, все успешны', async () => {
    const url = await createTestDatabase();
    const rs = [replica(url), replica(url), replica(url)];
    await Promise.all(rs.map((r) => withStartupLock(r.pool, () => migrateDb(r.db))));
    const check = new pg.Client({ connectionString: url });
    await check.connect();
    const { rows } = await check.query<{ n: string; d: string }>(
      'select count(*) as n, count(distinct hash) as d from drizzle.__drizzle_migrations',
    );
    await check.end();
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    expect(rows[0]!.n).toBe(rows[0]!.d);
  });

  it('секции выполняются по очереди, а не вперемешку', async () => {
    const url = await createTestDatabase();
    const a = replica(url);
    const b = replica(url);
    const events: string[] = [];
    const section = (name: string) => async () => {
      events.push(`${name}:начало`);
      await sleep(300);
      events.push(`${name}:конец`);
    };
    await Promise.all([
      withStartupLock(a.pool, section('a')),
      withStartupLock(b.pool, section('b')),
    ]);
    // Каждая секция целиком: начало и конец одной секции идут подряд.
    const who = events.map((e) => e.split(':')[0]);
    expect(who[0]).toBe(who[1]);
    expect(who[2]).toBe(who[3]);
    expect(who[0]).not.toBe(who[2]);
  });

  it('ошибка внутри секции поднимается, блокировка снимается, соединение возвращается в пул', async () => {
    const url = await createTestDatabase();
    const a = replica(url);
    await expect(
      withStartupLock(a.pool, async () => {
        throw new Error('миграция упала');
      }),
    ).rejects.toThrow('миграция упала');
    const check = new pg.Client({ connectionString: url });
    await check.connect();
    const { rows } = await check.query(
      "select 1 from pg_locks where locktype = 'advisory' and objid = $1",
      [STARTUP_LOCK_KEY],
    );
    await check.end();
    expect(rows).toHaveLength(0);
    expect(a.pool.idleCount).toBe(a.pool.totalCount);
    await expect(withStartupLock(a.pool, async () => 'ок')).resolves.toBe('ок');
  });
});
