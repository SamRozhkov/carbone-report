import type { ParamValue, RunQueryResult, TemplateQuery } from '@carbone-reports/shared';
import type pg from 'pg';
import Cursor from 'pg-cursor';
import { AppError } from '../../lib/errors';
import type { QueryResult } from './build-data';
import { parseSqlParams, SqlParamError } from './sql-params';

export interface QueryLimits {
  timeoutMs: number;
  maxRows: number;
}

type Row = Record<string, unknown>;

const TX_FORBIDDEN = 'управление транзакциями запрещено';

// Ошибки уровня соединения (класс 08, остановка сервера) — не вина запроса.
function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return !code || code.startsWith('08') || ['57P01', '57P02', '57P03'].includes(code);
}

function mapPgError(key: string, e: unknown): unknown {
  if (isConnectionError(e)) return e;
  const code = (e as { code?: string }).code;
  if (code === '57014') return new AppError('TIMEOUT', 504, 'превышено время ожидания');
  if (code === '25006') {
    return new AppError('SQL_ERROR', 400, `запрос "${key}": запись запрещена — запросы выполняются только на чтение`);
  }
  return new AppError('SQL_ERROR', 400, `запрос "${key}": ${(e as Error).message}`);
}

interface TxState {
  ts: string;
  st: string;
}

interface Tx {
  client: pg.PoolClient;
  /** Проверяет, что запрос пользователя не вышел из READ ONLY транзакции (COMMIT/ROLLBACK/END [AND CHAIN]). */
  guard(key: string): Promise<void>;
}

async function withReadOnly<T>(
  pool: pg.Pool,
  sourceName: string,
  timeoutMs: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (e) {
    throw new AppError('DATASOURCE_UNAVAILABLE', 502, `не удалось подключиться к источнику "${sourceName}"`, {
      reason: (e as Error).message,
    });
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
    const base = (
      await client.query<TxState>(
        "select transaction_timestamp()::text as ts, current_setting('statement_timeout') as st",
      )
    ).rows[0]!;
    return await fn({
      client,
      guard: async (key) => {
        const { rows } = await client.query<TxState & { ro: string }>(
          "select transaction_timestamp()::text as ts, current_setting('transaction_read_only') as ro, current_setting('statement_timeout') as st",
        );
        const cur = rows[0]!;
        if (cur.ts !== base.ts || cur.ro !== 'on' || cur.st !== base.st) {
          broken = true; // сессия могла быть изменена — в пул не возвращаем
          throw new AppError('SQL_ERROR', 400, `запрос "${key}": ${TX_FORBIDDEN}`);
        }
      },
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    broken = true;
    throw new AppError('DATASOURCE_UNAVAILABLE', 502, `соединение с источником "${sourceName}" прервано`, {
      reason: (e as Error).message,
    });
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    client.removeListener('error', onError);
    client.release(broken);
  }
}

function readBatch(cursor: Cursor, n: number): Promise<{ rows: Row[]; fields?: { name: string }[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err, rows, result) => (err ? reject(err) : resolve({ rows, fields: result?.fields })));
  });
}

async function readQuery(
  client: pg.PoolClient,
  key: string,
  sql: string,
  params: Record<string, ParamValue>,
  limit: number,
): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }> {
  let parsed;
  try {
    parsed = parseSqlParams(sql);
  } catch (e) {
    if (e instanceof SqlParamError) throw new AppError('SQL_ERROR', 400, `запрос "${key}": ${e.message}`);
    throw e;
  }
  const values = parsed.names.map((name) => {
    if (!(name in params)) throw new AppError('CONFIG', 400, `запрос "${key}": неизвестный параметр :${name}`);
    return params[name];
  });

  const cursor = client.query(new Cursor(parsed.text, values));
  let result: { columns: string[]; rows: Row[]; truncated: boolean };
  try {
    result = await readAll(cursor, limit);
  } catch (e) {
    // cursor.close() после ошибки читает ReadyForQuery и на оборванном соединении не завершится никогда.
    throw mapPgError(key, e);
  }
  await cursor.close().catch(() => {});
  return result;
}

async function readAll(cursor: Cursor, limit: number): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  let columns: string[] = [];
  for (;;) {
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

export function runQueries(
  pool: pg.Pool,
  sourceName: string,
  queries: TemplateQuery[],
  params: Record<string, ParamValue>,
  limits: QueryLimits,
): Promise<QueryResult[]> {
  return withReadOnly(pool, sourceName, limits.timeoutMs, async (tx) => {
    const results: QueryResult[] = [];
    for (const q of queries) {
      const limit = q.mode === 'single' ? 1 : limits.maxRows;
      const r = await readQuery(tx.client, q.key, q.sql, params, limit);
      await tx.guard(q.key);
      if (q.mode === 'list' && r.truncated) {
        throw new AppError('TOO_MANY_ROWS', 400, `запрос "${q.key}" вернул больше ${limits.maxRows} строк`);
      }
      results.push({ key: q.key, mode: q.mode, columns: r.columns, rows: r.rows });
    }
    return results;
  });
}

export function previewQuery(
  pool: pg.Pool,
  sourceName: string,
  sql: string,
  params: Record<string, ParamValue>,
  limits: QueryLimits & { previewRows: number },
): Promise<RunQueryResult> {
  return withReadOnly(pool, sourceName, limits.timeoutMs, async (tx) => {
    const r = await readQuery(tx.client, 'preview', sql, params, limits.previewRows);
    await tx.guard('preview');
    return r;
  });
}
