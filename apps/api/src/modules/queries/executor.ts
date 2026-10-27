import {
  checkReadOnlySql,
  scanSql,
  MAX_PARAM_OPTIONS,
  type ParamValue,
  type QueryCheck,
  type RunQueryResult,
  type SelectOptionValue,
  type TemplateParam,
  type TemplateQuery,
} from '@carbone-reports/shared';
import type { Locale } from '@carbone-reports/shared/i18n';
import type pg from 'pg';
import Cursor from 'pg-cursor';
import type { Deadline } from '../../lib/deadline';
import { AppError, text, translateMsg, type Msg } from '../../lib/errors';
import type { QueryResult } from './build-data';
import { sqlParamHint } from './sql-hints';
import { parseSqlParams, SqlParamError } from './sql-params';

export interface QueryLimits {
  timeoutMs: number;
  maxRows: number;
  /**
   * Общий срок отчёта. statement_timeout действует на каждый оператор, а не на транзакцию:
   * перед каждым запросом он урезается до остатка срока, а срок проверяется перед каждым запросом
   * и каждой порцией FETCH, чтобы брошенная по сроку транзакция не продолжала работу и сразу
   * вернула соединение в пул.
   */
  deadline?: Deadline;
}

type Row = Record<string, unknown>;

/** Чей SQL — начало текста ошибки: запрос шаблона или параметр со списком из запроса. */
const queryWhat = (key: string) => text('sql.query', { key });

/** Статическая проверка «только чтение» (§47.1) — до соединения с источником. */
function assertReadOnly(what: Msg, sql: string): void {
  const r = checkReadOnlySql(sql);
  if (!r.ok)
    throw new AppError('SQL_ERROR', 400, {
      key: 'sql.notReadOnly',
      params: { what, found: r.found },
    });
}

// Ошибки уровня соединения (класс 08, остановка сервера) — не вина запроса.
function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return !code || code.startsWith('08') || ['57P01', '57P02', '57P03'].includes(code);
}

function mapPgError(what: Msg, e: unknown, hint?: Msg): unknown {
  if (isConnectionError(e)) return e;
  const code = (e as { code?: string }).code;
  if (code === '57014') return new AppError('TIMEOUT', 504, { key: 'timeout' });
  if (code === '25006')
    return new AppError('SQL_ERROR', 400, { key: 'sql.readOnly', params: { what } });
  const message = (e as Error).message;
  return new AppError(
    'SQL_ERROR',
    400,
    hint
      ? { key: 'sql.errorHint', params: { what, message, hint } }
      : { key: 'sql.error', params: { what, message } },
  );
}

interface TxState {
  ts: string;
  st: string;
}

interface Tx {
  client: pg.PoolClient;
  /** Проверяет, что запрос пользователя не вышел из READ ONLY транзакции (COMMIT/ROLLBACK/END [AND CHAIN]). */
  guard(what: Msg): Promise<void>;
  /**
   * С общим сроком: перед запросом проверить срок и урезать statement_timeout до остатка
   * (SET LOCAL в начале транзакции считался от её начала). guard принимает новое значение.
   */
  beforeQuery(deadline: Deadline | undefined, timeoutMs: number): Promise<void>;
}

export async function withReadOnly<T>(
  pool: pg.Pool,
  sourceName: string,
  timeoutMs: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (e) {
    throw new AppError(
      'DATASOURCE_UNAVAILABLE',
      502,
      { key: 'datasource.connectFailed', params: { name: sourceName } },
      undefined,
      (e as Error).message,
    );
  }
  let broken = false;
  // pg-pool снимает свой обработчик 'error' на время аренды; без своего процесс упадёт при обрыве соединения.
  const onError = () => {
    broken = true;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    // Строки '…' разбираются как в scanSql (§47.1): \' не экранирует кавычку, даже если у источника off.
    await client.query('SET LOCAL standard_conforming_strings = on');
    const base = (
      await client.query<TxState>(
        "select pg_catalog.transaction_timestamp()::text as ts, pg_catalog.current_setting('statement_timeout') as st",
      )
    ).rows[0]!;
    return await fn({
      client,
      beforeQuery: async (deadline, timeoutMs) => {
        if (!deadline) return;
        deadline.check();
        const { rows } = await client.query<{ st: string }>(
          "select pg_catalog.set_config('statement_timeout', $1, true) as st",
          [String(Math.floor(deadline.cap(timeoutMs)))],
        );
        base.st = rows[0]!.st;
      },
      guard: async (what) => {
        const { rows } = await client.query<TxState & { ro: string }>(
          "select pg_catalog.transaction_timestamp()::text as ts, pg_catalog.current_setting('transaction_read_only') as ro, pg_catalog.current_setting('statement_timeout') as st",
        );
        const cur = rows[0]!;
        if (cur.ts !== base.ts || cur.ro !== 'on' || cur.st !== base.st) {
          broken = true; // сессия могла быть изменена — в пул не возвращаем
          throw new AppError('SQL_ERROR', 400, { key: 'sql.txForbidden', params: { what } });
        }
      },
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    broken = true;
    throw new AppError(
      'DATASOURCE_UNAVAILABLE',
      502,
      { key: 'datasource.connectionLost', params: { name: sourceName } },
      undefined,
      (e as Error).message,
    );
  } finally {
    try {
      await client.query('ROLLBACK');
      // Сессионное состояние (advisory-локи, prepared statements, SET) переживает ROLLBACK.
      await client.query('DISCARD ALL');
    } catch {
      broken = true;
    }
    client.removeListener('error', onError);
    client.release(broken);
  }
}

function readBatch(
  cursor: Cursor,
  n: number,
): Promise<{ rows: Row[]; fields?: { name: string }[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err, rows, result) =>
      err ? reject(err) : resolve({ rows, fields: result?.fields }),
    );
  });
}

async function readQuery(
  client: pg.PoolClient,
  what: Msg,
  sql: string,
  params: Record<string, ParamValue>,
  limit: number,
  deadline?: Deadline,
): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }> {
  deadline?.check();
  let parsed;
  try {
    parsed = parseSqlParams(sql);
  } catch (e) {
    if (e instanceof SqlParamError)
      throw new AppError('SQL_ERROR', 400, {
        key: 'sql.error',
        params: { what, message: text(e.key) },
      });
    throw e;
  }
  const values = parsed.names.map((name) => {
    if (!Object.hasOwn(params, name))
      throw new AppError('CONFIG', 400, {
        key: 'sql.unknownParam',
        params: { what, name },
      });
    return params[name];
  });

  const cursor = client.query(new Cursor(parsed.text, values));
  let result: { columns: string[]; rows: Row[]; truncated: boolean };
  try {
    result = await readAll(cursor, limit, deadline);
  } catch (e) {
    if (e instanceof AppError) {
      // Наша проверка срока между порциями: соединение исправно, портал приостановлен (Execute без
      // Sync). Без Close+Sync ROLLBACK в withReadOnly встанет в очередь за курсором и не отправится
      // никогда — клиент не вернётся в пул.
      await cursor.close().catch(() => {});
      throw e;
    }
    // Ошибка pg: cursor.close() после неё читает ReadyForQuery и на оборванном соединении
    // не завершится никогда — не закрываем.
    throw mapPgError(what, e, sqlParamHint(sql, parsed.names, params, e));
  }
  await cursor.close().catch(() => {});
  return result;
}

async function readAll(
  cursor: Cursor,
  limit: number,
  deadline?: Deadline,
): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  let columns: string[] = [];
  for (;;) {
    deadline?.check();
    const size = Math.min(1000, limit + 1 - rows.length);
    const batch = await readBatch(cursor, size);
    if (columns.length === 0 && batch.fields) columns = batch.fields.map((f) => f.name);
    rows.push(...batch.rows);
    if (rows.length > limit) return { columns, rows: rows.slice(0, limit), truncated: true };
    if (batch.rows.length < size) {
      if (columns.length === 0 && rows[0]) columns = Object.keys(rows[0]);
      return { columns, rows, truncated: false };
    }
  }
}

export async function runQueries(
  pool: pg.Pool,
  sourceName: string,
  queries: TemplateQuery[],
  params: Record<string, ParamValue>,
  limits: QueryLimits,
): Promise<QueryResult[]> {
  for (const q of queries) assertReadOnly(queryWhat(q.key), q.sql);
  return withReadOnly(pool, sourceName, limits.timeoutMs, async (tx) => {
    const results: QueryResult[] = [];
    for (const q of queries) {
      const limit = q.mode === 'single' ? 1 : limits.maxRows;
      await tx.beforeQuery(limits.deadline, limits.timeoutMs);
      const what = queryWhat(q.key);
      const r = await readQuery(tx.client, what, q.sql, params, limit, limits.deadline);
      // Сначала guard: попытка выйти из транзакции или снять таймаут обнаруживается всегда.
      await tx.guard(what);
      limits.deadline?.check();
      if (q.mode === 'list' && r.truncated) {
        throw new AppError('TOO_MANY_ROWS', 400, {
          key: 'sql.tooManyRows',
          params: { key: q.key, count: limits.maxRows },
        });
      }
      results.push({ key: q.key, mode: q.mode, columns: r.columns, rows: r.rows });
    }
    return results;
  });
}

export async function previewQuery(
  pool: pg.Pool,
  sourceName: string,
  sql: string,
  params: Record<string, ParamValue>,
  limits: QueryLimits & { previewRows: number },
): Promise<RunQueryResult> {
  assertReadOnly(queryWhat('preview'), sql);
  return withReadOnly(pool, sourceName, limits.timeoutMs, async (tx) => {
    const what = queryWhat('preview');
    const r = await readQuery(tx.client, what, sql, params, limits.previewRows);
    await tx.guard(what);
    return r;
  });
}

/**
 * Строки запроса вариантов → варианты.
 * Значение — колонка `value`, иначе первая колонка, кроме `label`.
 * Подпись — колонка `label`, иначе первая колонка, кроме колонки значения; если такой нет — само значение.
 * Без `value` и `label` это первая и вторая колонки. Date → ISO-строка.
 * Повторы значений (по String(value)) убираются, остаётся первое вхождение.
 */
export function rowsToOptions(columns: string[], rows: Row[]): SelectOptionValue[] {
  const vc = columns.includes('value')
    ? 'value'
    : (columns.find((c) => c !== 'label') ?? columns[0]);
  if (vc === undefined) return [];
  const lc = columns.includes('label') ? 'label' : columns.find((c) => c !== vc);
  const scalar = (x: unknown): string | number =>
    x instanceof Date
      ? x.toISOString()
      : typeof x === 'string' || typeof x === 'number'
        ? x
        : String(x);
  const seen = new Set<string>();
  const out: SelectOptionValue[] = [];
  for (const row of rows) {
    const value = scalar(row[vc]);
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    const l = lc === undefined ? null : row[lc];
    out.push({ value, label: l === null || l === undefined ? key : String(scalar(l)) });
  }
  return out;
}

/**
 * Варианты параметров типа query — все в одной read-only транзакции, по порядку items.
 * stop(i, options) → true: остальные items не выполняются, результат короче items.
 */
export async function loadParamOptions(
  pool: pg.Pool,
  sourceName: string,
  items: { def: TemplateParam; params: Record<string, ParamValue> }[],
  limits: QueryLimits,
  stop?: (index: number, options: SelectOptionValue[]) => boolean,
): Promise<SelectOptionValue[][]> {
  for (const { def } of items) assertReadOnly(text('sql.param', { label: def.label }), def.sql!);
  return withReadOnly(pool, sourceName, limits.timeoutMs, async (tx) => {
    const out: SelectOptionValue[][] = [];
    for (const { def, params } of items) {
      const what = text('sql.param', { label: def.label });
      // readQuery читает limit + 1 строку: truncated — вариантов больше MAX_PARAM_OPTIONS.
      await tx.beforeQuery(limits.deadline, limits.timeoutMs);
      const r = await readQuery(
        tx.client,
        what,
        def.sql!,
        params,
        MAX_PARAM_OPTIONS,
        limits.deadline,
      );
      await tx.guard(what);
      limits.deadline?.check();
      if (r.truncated) {
        throw new AppError('TOO_MANY_OPTIONS', 400, {
          key: 'sql.tooManyOptions',
          params: { what, count: MAX_PARAM_OPTIONS },
        });
      }
      const options = rowsToOptions(r.columns, r.rows);
      out.push(options);
      if (stop?.(out.length - 1, options)) break;
    }
    return out;
  });
}

/** Снимает ; в конце кода (после него допустимы пробелы и комментарии — они остаются). */
function stripTrailingSemicolon(sql: string): string {
  const code = scanSql(sql).filter((seg) => seg.kind === 'code');
  for (let k = code.length - 1; k >= 0; k--) {
    const seg = code[k]!;
    const body = sql.slice(seg.start, seg.end);
    const trimmed = body.trimEnd();
    if (trimmed === '') continue;
    if (!trimmed.endsWith(';')) break;
    return sql.slice(0, seg.start + trimmed.length - 1) + sql.slice(seg.start + trimmed.length);
  }
  return sql;
}

/**
 * Проверка SQL автора (§51.2): колонки и типы без строк. Все :параметры — null; запрос
 * оборачивается в select * from (…) q limit 0, ; в конце снимается, перенос строки перед )
 * закрывает комментарий -- в последней строке. Текст ошибки — на языке locale.
 */
export async function checkQuery(
  pool: pg.Pool,
  sourceName: string,
  sql: string,
  timeoutMs: number,
  locale: Locale,
): Promise<QueryCheck> {
  const what = queryWhat('check');
  try {
    assertReadOnly(what, sql);
    const parsed = parseSqlParams(stripTrailingSemicolon(sql));
    return await withReadOnly(pool, sourceName, timeoutMs, async (tx) => {
      let fields: { name: string; dataTypeID: number }[];
      try {
        const r = await tx.client.query({
          text: `select * from (\n${parsed.text}\n) q limit 0`,
          values: parsed.names.map(() => null),
          // Расширенный протокол и без параметров: сервер откажет в нескольких операторах в тексте.
          queryMode: 'extended',
        } as pg.QueryConfig);
        fields = r.fields;
      } catch (e) {
        throw mapPgError(what, e);
      }
      const oids = [...new Set(fields.map((f) => f.dataTypeID))];
      const { rows } = await tx.client.query<{ oid: number; name: string }>(
        'select oid::int as oid, pg_catalog.format_type(oid, null) as name from pg_catalog.pg_type where oid = any($1::oid[])',
        [oids],
      );
      const names = new Map(rows.map((r) => [r.oid, r.name]));
      await tx.guard(what);
      return {
        ok: true as const,
        columns: fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) ?? 'unknown' })),
      };
    });
  } catch (e) {
    if (e instanceof SqlParamError)
      return { ok: false, error: translateMsg(locale, { key: e.key }) };
    if (e instanceof AppError && (e.code === 'SQL_ERROR' || e.code === 'TIMEOUT'))
      return { ok: false, error: e.textIn(locale) };
    throw e;
  }
}
