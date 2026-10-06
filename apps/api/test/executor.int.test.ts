import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Deadline } from '../src/lib/deadline';
import { AppError } from '../src/lib/errors';
import { poolConfig } from '../src/modules/datasources/pools';
import { previewQuery, runQueries } from '../src/modules/queries/executor';
import { createSourceDatabase } from './helpers';

let pool: pg.Pool;
let onePool: pg.Pool;
let srcConn: Awaited<ReturnType<typeof createSourceDatabase>>;
const limits = { timeoutMs: 1000, maxRows: 5 };

beforeAll(async () => {
  const src = await createSourceDatabase(`
    create table orders(id int primary key, total numeric, created date);
    insert into orders select g, g * 10, date '2026-01-01' + g from generate_series(1, 3) g;
    create table company(name text);
    insert into company values ('ООО Ромашка');
    create table big as select generate_series(1, 20) as n;
  `);
  srcConn = src;
  pool = new pg.Pool(poolConfig({ ...src, sslMode: 'disable', sslCa: null }));
  onePool = new pg.Pool({ ...poolConfig({ ...src, sslMode: 'disable', sslCa: null }), max: 1 });
});
afterAll(async () => {
  await pool.end();
  await onePool.end();
});

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
      pool,
      'src',
      [
        {
          key: 'orders',
          mode: 'list',
          sql: 'select id, total from orders where created >= :from order by id',
        },
        { key: 'company', mode: 'single', sql: 'select name from company' },
      ],
      { from: '2026-01-03' },
      limits,
    );
    expect(r).toEqual([
      {
        key: 'orders',
        mode: 'list',
        columns: ['id', 'total'],
        rows: [
          { id: 2, total: 20 },
          { id: 3, total: 30 },
        ],
      },
      { key: 'company', mode: 'single', columns: ['name'], rows: [{ name: 'ООО Ромашка' }] },
    ]);
  });

  it('колонки возвращаются и для пустого результата', async () => {
    const [r] = await runQueries(
      pool,
      'src',
      [{ key: 'o', mode: 'list', sql: 'select id from orders where false' }],
      {},
      limits,
    );
    expect(r).toMatchObject({ columns: ['id'], rows: [] });
  });

  it('запрет записи: INSERT падает с понятной ошибкой', async () => {
    const e = await err(
      runQueries(
        pool,
        'src',
        [{ key: 'w', mode: 'list', sql: "insert into company values ('x') returning *" }],
        {},
        limits,
      ),
    );
    expect(e.code).toBe('SQL_ERROR');
    expect(e.message).toMatch(/^запрос "w": .*только на чтение/);
    const { rows } = await pool.query('select count(*)::int as n from company');
    expect(rows[0].n).toBe(1);
  });

  it('statement_timeout → TIMEOUT 504', async () => {
    const e = await err(
      runQueries(pool, 'src', [{ key: 's', mode: 'list', sql: 'select pg_sleep(3)' }], {}, limits),
    );
    expect([e.code, e.status]).toEqual(['TIMEOUT', 504]);
  });

  it('превышение maxRows в list → TOO_MANY_ROWS', async () => {
    const e = await err(
      runQueries(pool, 'src', [{ key: 'big', mode: 'list', sql: 'select n from big' }], {}, limits),
    );
    expect(e.code).toBe('TOO_MANY_ROWS');
    expect(e.message).toBe('запрос "big" вернул больше 5 строк');
  });

  it('single читает только первую строку и не упирается в лимит', async () => {
    const [r] = await runQueries(
      pool,
      'src',
      [{ key: 'b', mode: 'single', sql: 'select n from big order by n' }],
      {},
      limits,
    );
    expect(r!.rows).toEqual([{ n: 1 }]);
  });

  it('синтаксическая ошибка → SQL_ERROR с ключом запроса', async () => {
    const e = await err(
      runQueries(pool, 'src', [{ key: 'bad', mode: 'list', sql: 'selec 1' }], {}, limits),
    );
    expect(e.code).toBe('SQL_ERROR');
    expect(e.message).toMatch(/^запрос "bad": /);
  });

  it('имя из прототипа (:toString) не считается параметром → CONFIG', async () => {
    const e = await err(
      runQueries(pool, 'src', [{ key: 'q', mode: 'list', sql: 'select :toString' }], {}, limits),
    );
    expect(e.code).toBe('CONFIG');
  });

  it('неизвестный параметр → CONFIG', async () => {
    const e = await err(
      runQueries(pool, 'src', [{ key: 'q', mode: 'list', sql: 'select :nope' }], {}, limits),
    );
    expect(e.code).toBe('CONFIG');
    expect(e.message).toBe('запрос "q": неизвестный параметр :nope');
  });

  it('значение параметра не интерпретируется как SQL', async () => {
    const [r] = await runQueries(
      pool,
      'src',
      [{ key: 'q', mode: 'single', sql: 'select :v::text as v' }],
      { v: "'; drop table orders; --" },
      limits,
    );
    expect(r!.rows[0]).toEqual({ v: "'; drop table orders; --" });
    const { rows } = await pool.query('select count(*)::int as n from orders');
    expect(rows[0].n).toBe(3);
  });

  it('недоступный источник → DATASOURCE_UNAVAILABLE 502', async () => {
    const dead = new pg.Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 500 });
    const e = await err(
      runQueries(dead, 'Склад', [{ key: 'q', mode: 'list', sql: 'select 1' }], {}, limits),
    );
    expect([e.code, e.status, e.message]).toEqual([
      'DATASOURCE_UNAVAILABLE',
      502,
      'не удалось подключиться к источнику "Склад"',
    ]);
    await dead.end();
  });

  it('после ошибки соединение возвращается в пул исправным', async () => {
    await err(runQueries(pool, 'src', [{ key: 'bad', mode: 'list', sql: 'selec 1' }], {}, limits));
    const [r] = await runQueries(
      pool,
      'src',
      [{ key: 'ok', mode: 'single', sql: 'select 1 as x' }],
      {},
      limits,
    );
    expect(r!.rows).toEqual([{ x: 1 }]);
  });
});

describe('целостность транзакции', () => {
  const insert = {
    key: 'w',
    mode: 'list' as const,
    sql: "insert into company values ('x') returning *",
  };
  const companyCount = async () =>
    (await pool.query('select count(*)::int as n from company')).rows[0].n as number;

  it.each(['commit', 'rollback', 'end', 'abort', 'commit and chain', 'rollback and chain'])(
    '%s как первый запрос → SQL_ERROR, запись не проходит',
    async (sql) => {
      const before = await companyCount();
      const e = await err(
        runQueries(pool, 'src', [{ key: 'c', mode: 'list', sql }, insert], {}, limits),
      );
      expect([e.code, e.status, e.message]).toEqual([
        'SQL_ERROR',
        400,
        'запрос "c": управление транзакциями запрещено',
      ]);
      expect(await companyCount()).toBe(before);
    },
    10_000,
  );

  it('commit + set_config не протекает в пул', async () => {
    const e = await err(
      runQueries(
        onePool,
        'src',
        [
          { key: 'c', mode: 'list', sql: 'commit' },
          { key: 's', mode: 'single', sql: "select set_config('search_path','evil',false)" },
        ],
        {},
        limits,
      ),
    );
    expect(e.code).toBe('SQL_ERROR');
    const [r] = await runQueries(
      onePool,
      'src',
      [{ key: 'p', mode: 'single', sql: "select current_setting('search_path') as sp" }],
      {},
      limits,
    );
    expect(r!.rows[0]).not.toEqual({ sp: 'evil' });
  }, 10_000);

  it('advisory-лок не переживает запрос', async () => {
    await runQueries(
      onePool,
      'src',
      [{ key: 'l', mode: 'single', sql: 'select pg_advisory_lock(42)' }],
      {},
      limits,
    );
    const [r] = await runQueries(
      onePool,
      'src',
      [
        {
          key: 'n',
          mode: 'single',
          sql: "select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()",
        },
      ],
      {},
      limits,
    );
    expect(r!.rows).toEqual([{ n: 0 }]);
  }, 10_000);

  it('prepared statement не переживает запрос', async () => {
    await runQueries(
      onePool,
      'src',
      [{ key: 'p', mode: 'single', sql: 'prepare zz as select 1' }],
      {},
      limits,
    ).catch(() => {});
    const e = await err(
      runQueries(onePool, 'src', [{ key: 'x', mode: 'single', sql: 'execute zz' }], {}, limits),
    );
    expect(e.code).toBe('SQL_ERROR');
  }, 10_000);

  it('previewQuery: commit → SQL_ERROR', async () => {
    const e = await err(previewQuery(pool, 'src', 'commit', {}, { ...limits, previewRows: 3 }));
    expect([e.code, e.message]).toEqual([
      'SQL_ERROR',
      'запрос "preview": управление транзакциями запрещено',
    ]);
  }, 10_000);
});

describe('устойчивость', () => {
  const ok = () =>
    runQueries(pool, 'src', [{ key: 'ok', mode: 'single', sql: 'select 1 as x' }], {}, limits);

  it('после TIMEOUT следующий запрос проходит', async () => {
    await err(
      runQueries(pool, 'src', [{ key: 's', mode: 'list', sql: 'select pg_sleep(3)' }], {}, limits),
    );
    expect((await ok())[0]!.rows).toEqual([{ x: 1 }]);
  }, 10_000);

  it('после TOO_MANY_ROWS следующий запрос проходит', async () => {
    await err(
      runQueries(pool, 'src', [{ key: 'big', mode: 'list', sql: 'select n from big' }], {}, limits),
    );
    expect((await ok())[0]!.rows).toEqual([{ x: 1 }]);
  }, 10_000);

  it('обрыв соединения посреди запроса → DATASOURCE_UNAVAILABLE, пул жив', async () => {
    const running = runQueries(
      pool,
      'src',
      [{ key: 's', mode: 'list', sql: 'select pg_sleep(5)' }],
      {},
      { timeoutMs: 10_000, maxRows: 5 },
    );
    const settled = running.then(
      () => undefined,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 300));
    const admin = new pg.Client({
      host: srcConn.host,
      port: srcConn.port,
      database: srcConn.database,
      user: srcConn.username,
      password: srcConn.password,
    });
    await admin.connect();
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(5)%' and pid <> pg_backend_pid()",
    );
    await admin.end();
    const e = (await settled) as AppError;
    expect(e).toBeInstanceOf(AppError);
    expect([e.code, e.status]).toEqual(['DATASOURCE_UNAVAILABLE', 502]);
    expect((await ok())[0]!.rows).toEqual([{ x: 1 }]);
  }, 10_000);
});

describe('previewQuery', () => {
  it('возвращает не больше previewRows строк и флаг truncated', async () => {
    const r = await previewQuery(
      pool,
      'src',
      'select n from big order by n',
      {},
      { ...limits, previewRows: 3 },
    );
    expect(r).toEqual({ columns: ['n'], rows: [{ n: 1 }, { n: 2 }, { n: 3 }], truncated: true });
  });
  it('truncated=false, если строк меньше лимита', async () => {
    const r = await previewQuery(pool, 'src', 'select 1 as a', {}, { ...limits, previewRows: 3 });
    expect(r.truncated).toBe(false);
  });
});

describe('общий срок (deadline)', () => {
  const pid = async (p: pg.Pool) =>
    (
      await runQueries(
        p,
        'src',
        [{ key: 'pid', mode: 'single', sql: 'select pg_backend_pid() as pid' }],
        {},
        limits,
      )
    )[0]!.rows[0]!.pid as number;

  /** Срок, который истекает по сигналу теста, не урезая statement_timeout заранее. */
  class FlipDeadline extends Deadline {
    expired = false;
    override remaining(): number {
      return this.expired ? 0 : super.remaining();
    }
  }

  it('срок истёк между порциями FETCH → TIMEOUT, курсор закрыт, соединение вернулось в пул', async () => {
    const p = new pg.Pool({
      ...poolConfig({ ...srcConn, sslMode: 'disable', sslCa: null }),
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    p.on('error', () => {});
    // statement_timeout у pg-cursor действует до Sync, то есть на всё чтение курсора, и урезан до
    // остатка срока; поэтому срок «истекает» флагом через 300 мс, пока statement_timeout — 30 с.
    // Порция в 1000 строк идёт ~0,4 с (10 × pg_sleep(0.04)), запрос целиком — ~2 с: флаг
    // поднимается посреди чтения, и проверка перед следующим FETCH застаёт приостановленный портал.
    const deadline = new FlipDeadline(60_000);
    const flip = setTimeout(() => (deadline.expired = true), 300);
    try {
      const e = await err(
        runQueries(
          p,
          'src',
          [
            {
              key: 'slow',
              mode: 'list',
              sql: 'select g, pg_sleep(case when g % 100 = 0 then 0.04 else 0 end) from generate_series(1, 5000) g',
            },
          ],
          {},
          { timeoutMs: 30000, maxRows: 100000, deadline },
        ),
      );
      // Текст срока отчёта, а не statement_timeout: сработала проверка между порциями.
      expect([e.code, e.status, e.message]).toEqual([
        'TIMEOUT',
        504,
        'превышено время формирования отчёта',
      ]);
      // С max: 1 следующий запрос пройдёт, только если клиент освобождён.
      const [r] = await runQueries(
        p,
        'src',
        [{ key: 'ok', mode: 'single', sql: 'select 1 as x' }],
        {},
        limits,
      );
      expect(r!.rows).toEqual([{ x: 1 }]);
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
         where datname = $1 and state like 'idle in transaction%'`,
        [srcConn.database],
      );
      expect(rows[0]!.n).toBe(0);
    } finally {
      clearTimeout(flip);
      await Promise.race([p.end(), new Promise((r) => setTimeout(r, 1000))]);
    }
  }, 15_000);

  it('с активным сроком set_config(statement_timeout) в SQL → SQL_ERROR, соединение не переиспользуется', async () => {
    const before = await pid(onePool);
    const e = await err(
      runQueries(
        onePool,
        'src',
        [
          {
            key: 'esc',
            mode: 'single',
            sql: "select set_config('statement_timeout','0',true)",
          },
        ],
        {},
        { ...limits, deadline: new Deadline(5000) },
      ),
    );
    expect([e.code, e.message]).toEqual([
      'SQL_ERROR',
      'запрос "esc": управление транзакциями запрещено',
    ]);
    expect(await pid(onePool)).not.toBe(before);
  }, 10_000);
});
