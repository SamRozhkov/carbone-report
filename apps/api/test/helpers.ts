import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role, TemplateParam, TemplateQuery } from '@carbone-reports/shared';
import type { Redis } from 'ioredis';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp, type App } from '../src/app';
import type { Config } from '../src/config';
import { createDb, migrateDb } from '../src/db/client';
import { eq } from 'drizzle-orm';
import { templates, users, type UserRow } from '../src/db/schema';
import type { AppDeps } from '../src/deps';
import { createRedis } from '../src/lib/redis';
import { Storage } from '../src/lib/storage';
import { createRemoveGate } from '../src/lib/storage-gate';
import { createSourcePools } from '../src/modules/datasources/pools';
import { hashPassword } from '../src/modules/auth/password';

const enc = new TextEncoder();

export async function createTestDatabase(): Promise<string> {
  const uri = inject('pgUri');
  const admin = new pg.Client({ connectionString: uri });
  await admin.connect();
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(uri);
  url.pathname = `/${name}`;
  return url.toString();
}

export function testConfig(databaseUrl: string, storageDir: string): Config {
  return {
    databaseUrl,
    appSecret: enc.encode('test-app-secret-'.repeat(3)),
    encryptionKey: Buffer.alloc(32, 3),
    onlyofficeJwtSecret: enc.encode('test-onlyoffice-secret-'.repeat(2)),
    onlyofficeInternalUrl: 'http://onlyoffice',
    apiInternalUrl: 'http://api:3000',
    carboneUrl: 'http://carbone:4000',
    redisUrl: inject('redisUrl'),
    storageDir,
    queryTimeoutMs: 2000,
    queryMaxRows: 1000,
    renderTimeoutMs: 5000,
    reportTimeoutMs: 20000,
    reportRetentionDays: 30,
    tz: 'Europe/Moscow',
    port: 0,
    cookieSecure: false,
    ldap: null,
  };
}

const notConfigured = (what: string) => () => {
  throw new Error(`${what} не настроен в тесте`);
};

export interface SourceConn {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export async function createSourceDatabase(seedSql: string): Promise<SourceConn> {
  const url = new URL(await createTestDatabase());
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(seedSql);
  await client.end();
  return {
    host: url.hostname,
    port: Number(url.port),
    database: url.pathname.slice(1),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export interface TestApp {
  app: App;
  deps: AppDeps;
  close(): Promise<void>;
}

const quietLog = { warn: () => {} };

/**
 * Клиент тестового Redis с уникальным префиксом ключей: приложения и тесты не видят
 * ключи друг друга. Ждёт готовности, иначе первые команды отклоняются
 * (`enableOfflineQueue: false`).
 */
export async function createTestRedis(keyPrefix = `t_${randomUUID()}:`): Promise<Redis> {
  const redis = createRedis(inject('redisUrl'), quietLog, { keyPrefix });
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        redis.disconnect();
        reject(new Error('тестовый Redis не готов'));
      }, 5000);
      redis.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return redis;
}

/**
 * `redis` по умолчанию — свой клиент тестового Redis с уникальным `keyPrefix`
 * (закрывается в `close()`); переданный явно клиент или `null` тест закрывает сам.
 * `config` — переопределение отдельных значений тестовой конфигурации.
 */
export async function createTestApp(
  overrides: Partial<Omit<AppDeps, 'config' | 'db' | 'storage'>> = {},
  config: Partial<Config> = {},
): Promise<TestApp> {
  const databaseUrl = await createTestDatabase();
  const storageDir = await mkdtemp(join(tmpdir(), 'cr-test-'));
  const cfg: Config = { ...testConfig(databaseUrl, storageDir), ...config };
  const { db, pool } = createDb(databaseUrl);
  const gatePool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  gatePool.on('error', () => {});
  await migrateDb(db);
  const ownRedis = 'redis' in overrides ? null : await createTestRedis();
  const deps: AppDeps = {
    config: cfg,
    db,
    storage: new Storage(storageDir, createRemoveGate(gatePool)),
    sources: createSourcePools({ db, config: cfg }),
    carbone: { render: notConfigured('carbone') },
    onlyoffice: { forceSave: notConfigured('onlyoffice') },
    fetchFile: notConfigured('fetchFile'),
    redis: ownRedis,
    ldap: null,
    ...overrides,
  };
  const app = await buildApp(deps);
  return {
    app,
    deps,
    async close() {
      await app.close();
      await deps.sources.closeAll();
      await gatePool.end();
      await pool.end();
      await ownRedis?.quit().catch(() => ownRedis.disconnect());
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

export async function loginAs(t: TestApp, role: Role): Promise<{ cookie: string; user: UserRow }> {
  const login = `${role}_${randomUUID().slice(0, 8)}`;
  const [user] = await t.deps.db
    .insert(users)
    .values({ login, passwordHash: await hashPassword('password123'), role })
    .returning();
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login, password: 'password123' },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { cookie, user: user! };
}

export async function createTemplate(
  t: TestApp,
  cookie: string,
  datasourceId: string,
  opts: { queries?: TemplateQuery[]; params?: TemplateParam[]; public?: boolean } = {},
): Promise<string> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/templates',
    headers: { cookie },
    payload: { name: `Шаблон ${randomUUID().slice(0, 4)}`, datasourceId, blank: 'docx' },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  const id = r.json().id as string;
  // Новые шаблоны закрыты; открыть — тестам, где генерирует обычный пользователь.
  if (opts.public) await openTemplate(t, id);
  if (opts.queries) {
    await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${id}/queries`,
      headers: { cookie },
      payload: opts.queries,
    });
  }
  if (opts.params) {
    await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${id}/params`,
      headers: { cookie },
      payload: opts.params,
    });
  }
  return id;
}

/** Делает шаблон доступным всем пользователям (templates.public = true). */
export async function openTemplate(t: TestApp, id: string): Promise<void> {
  await t.deps.db.update(templates).set({ public: true }).where(eq(templates.id, id));
}

export function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer }) {
  const boundary = '----cr' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
