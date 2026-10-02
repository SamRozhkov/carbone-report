import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { poolConfig } from '../src/modules/datasources/pools';
import { previewQuery, runQueries } from '../src/modules/queries/executor';
import { createSourceDatabase } from './helpers';

let pool: pg.Pool;
const limits = { timeoutMs: 1000, maxRows: 5 };

beforeAll(async () => {
  const src = await createSourceDatabase(`
    create table orders(id int primary key, total numeric, created date);
    insert into orders select g, g * 10, date '2026-01-01' + g from generate_series(1, 3) g;
    create table company(name text);
    insert into company values ('ООО Ромашка');
    create table big as select generate_series(1, 20) as n;
  `);
  pool = new pg.Pool(poolConfig({ ...src, ssl: false }));
});
afterAll(() => pool.end());

async function err(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('ожидалась ошибка');
}

describe('runQueries', () => {
  it('выполняет несколько запросов с параметрами', async () => {
    const r = await runQueries(
      pool, 'src',
      [
        { key: 'orders', mode: 'list', sql: 'select id, total from orders where created >= :from order by id' },
        { key: 'company', mode: 'single', sql: 'select name from company' },
      ],
      { from: '2026-01-03' },
      limits,
    );
    expect(r).toEqual([
      { key: 'orders', mode: 'list', columns: ['id', 'total'], rows: [{ id: 2, total: 20 }, { id: 3, total: 30 }] },
      { key: 'company', mode: 'single', columns: ['name'], rows: [{ name: 'ООО Ромашка' }] },
    ]);
  });

  it('колонки возвращаются и для пустого результата', async () => {
    const [r] = await runQueries(pool, 'src', [{ key: 'o', mode: 'list', sql: 'select id from orders where false' }], {}, limits);
    expect(r).toMatchObject({ columns: ['id'], rows: [] });
  });

  it('запрет записи: INSERT падает с понятной ошибкой', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 'w', mode: 'list', sql: 'insert into company values (\'x\') returning *' }], {}, limits));
    expect(e.code).toBe('SQL_ERROR');
    expect(e.message).toMatch(/^запрос "w": .*только на чтение/);
    const { rows } = await pool.query('select count(*)::int as n from company');
    expect(rows[0].n).toBe(1);
  });

  it('statement_timeout → TIMEOUT 504', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 's', mode: 'list', sql: 'select pg_sleep(3)' }], {}, limits));
    expect([e.code, e.status]).toEqual(['TIMEOUT', 504]);
  });

  it('превышение maxRows в list → TOO_MANY_ROWS', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 'big', mode: 'list', sql: 'select n from big' }], {}, limits));
    expect(e.code).toBe('TOO_MANY_ROWS');
    expect(e.message).toBe('запрос "big" вернул больше 5 строк');
  });

  it('single читает только первую строку и не упирается в лимит', async () => {
    const [r] = await runQueries(pool, 'src', [{ key: 'b', mode: 'single', sql: 'select n from big order by n' }], {}, limits);
    expect(r!.rows).toEqual([{ n: 1 }]);
  });

  it('синтаксическая ошибка → SQL_ERROR с ключом запроса', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 'bad', mode: 'list', sql: 'selec 1' }], {}, limits));
    expect(e.code).toBe('SQL_ERROR');
    expect(e.message).toMatch(/^запрос "bad": /);
  });

  it('неизвестный параметр → CONFIG', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 'q', mode: 'list', sql: 'select :nope' }], {}, limits));
    expect(e.code).toBe('CONFIG');
    expect(e.message).toBe('запрос "q": неизвестный параметр :nope');
  });

  it('значение параметра не интерпретируется как SQL', async () => {
    const [r] = await runQueries(pool, 'src', [{ key: 'q', mode: 'single', sql: 'select :v::text as v' }], { v: "'; drop table orders; --" }, limits);
    expect(r!.rows[0]).toEqual({ v: "'; drop table orders; --" });
    const { rows } = await pool.query('select count(*)::int as n from orders');
    expect(rows[0].n).toBe(3);
  });

  it('недоступный источник → DATASOURCE_UNAVAILABLE 502', async () => {
    const dead = new pg.Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 500 });
    const e = await err(runQueries(dead, 'Склад', [{ key: 'q', mode: 'list', sql: 'select 1' }], {}, limits));
    expect([e.code, e.status, e.message]).toEqual(['DATASOURCE_UNAVAILABLE', 502, 'не удалось подключиться к источнику "Склад"']);
    await dead.end();
  });

  it('после ошибки соединение возвращается в пул исправным', async () => {
    await err(runQueries(pool, 'src', [{ key: 'bad', mode: 'list', sql: 'selec 1' }], {}, limits));
    const [r] = await runQueries(pool, 'src', [{ key: 'ok', mode: 'single', sql: 'select 1 as x' }], {}, limits);
    expect(r!.rows).toEqual([{ x: 1 }]);
  });
});

describe('previewQuery', () => {
  it('возвращает не больше previewRows строк и флаг truncated', async () => {
    const r = await previewQuery(pool, 'src', 'select n from big order by n', {}, { ...limits, previewRows: 3 });
    expect(r).toEqual({ columns: ['n'], rows: [{ n: 1 }, { n: 2 }, { n: 3 }], truncated: true });
  });
  it('truncated=false, если строк меньше лимита', async () => {
    const r = await previewQuery(pool, 'src', 'select 1 as a', {}, { ...limits, previewRows: 3 });
    expect(r.truncated).toBe(false);
  });
});
