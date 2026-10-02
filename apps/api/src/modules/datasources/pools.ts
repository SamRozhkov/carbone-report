import { eq } from 'drizzle-orm';
import pg from 'pg';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { datasources, type DatasourceRow } from '../../db/schema';
import type { SourcePools } from '../../deps';
import { decryptSecret } from '../../lib/crypto';
import { notFound } from '../../lib/errors';

const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082 } as const;

/** Число, если оно представимо без потери целой части; иначе исходная строка. */
export function toSafeNumber(v: string): number | string {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : v;
}

/** Числа приходят в Carbone числами, даты без времени — строками ГГГГ-ММ-ДД. */
export const SOURCE_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (oid === OID.INT8 || oid === OID.NUMERIC) return toSafeNumber;
    if (oid === OID.DATE) return (v: string) => v;
    return pg.types.getTypeParser(oid, format as 'text');
  }) as pg.CustomTypesConfig['getTypeParser'],
};

export interface ConnParams {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

export function poolConfig(c: ConnParams): pg.PoolConfig {
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.username,
    password: c.password,
    // Источники во внутренней сети часто с самоподписанными сертификатами.
    ssl: c.ssl ? { rejectUnauthorized: false } : false,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 60_000,
    types: SOURCE_TYPES,
  };
}

export function connParamsFromRow(row: DatasourceRow, key: Buffer): ConnParams {
  return {
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    password: decryptSecret(row.passwordEnc, key),
    ssl: row.ssl,
  };
}

export async function testConnection(
  c: ConnParams,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { max: _max, idleTimeoutMillis: _idle, ...cfg } = poolConfig(c);
  const client = new pg.Client(cfg);
  try {
    await client.connect();
    await client.query('select 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  } finally {
    await client.end().catch(() => {});
  }
}

export function createSourcePools(deps: { db: Db; config: Config }): SourcePools {
  const cache = new Map<string, Promise<{ pool: pg.Pool; name: string }>>();

  async function open(id: string) {
    const [row] = await deps.db.select().from(datasources).where(eq(datasources.id, id));
    if (!row) throw notFound('источник данных');
    const pool = new pg.Pool(poolConfig(connParamsFromRow(row, deps.config.encryptionKey)));
    // Ошибки простаивающих соединений не должны ронять процесс.
    pool.on('error', () => {});
    return { pool, name: row.name };
  }

  async function invalidate(id: string): Promise<void> {
    const entry = cache.get(id);
    cache.delete(id);
    if (entry) await entry.then((e) => e.pool.end()).catch(() => {});
  }

  return {
    get(id) {
      let entry = cache.get(id);
      if (!entry) {
        entry = open(id);
        cache.set(id, entry);
        const current = entry;
        current.catch(() => {
          if (cache.get(id) === current) cache.delete(id);
        });
      }
      return entry;
    },
    invalidate,
    async closeAll() {
      await Promise.all([...cache.keys()].map((id) => invalidate(id)));
    },
  };
}
