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

function mapPgError(key: string, e: unknown): unknown {
  const code = (e as { code?: string }).code;
  if (code === '57014') return new AppError('TIMEOUT', 504, 'превышено время ожидания');
  if (code === '25006') {
    return new AppError('SQL_ERROR', 400, `запрос "${key}": запись запрещена — запросы выполняются только на чтение`);
  }
  if (code) return new AppError('SQL_ERROR', 400, `запрос "${key}": ${(e as Error).message}`);
  return e;
}

async function withReadOnly<T>(
  pool: pg.Pool,
  sourceName: string,
  timeoutMs: number,
  fn: (client: pg.PoolClient) => Promise<T>,
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
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    return await fn(client);
  } catch (e) {
    broken = !(e instanceof AppError);
    throw e;
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
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
  try {
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
  } catch (e) {
    throw mapPgError(key, e);
  } finally {
    await cursor.close().catch(() => {});
  }
}

export function runQueries(
  pool: pg.Pool,
  sourceName: string,
  queries: TemplateQuery[],
  params: Record<string, ParamValue>,
  limits: QueryLimits,
): Promise<QueryResult[]> {
  return withReadOnly(pool, sourceName, limits.timeoutMs, async (client) => {
    const results: QueryResult[] = [];
    for (const q of queries) {
      const limit = q.mode === 'single' ? 1 : limits.maxRows;
      const r = await readQuery(client, q.key, q.sql, params, limit);
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
  return withReadOnly(pool, sourceName, limits.timeoutMs, (client) =>
    readQuery(client, 'preview', sql, params, limits.previewRows),
  );
}
