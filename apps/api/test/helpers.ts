import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role, TemplateParam, TemplateQuery } from '@carbone-reports/shared';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp, type App } from '../src/app';
import type { Config } from '../src/config';
import { createDb, migrateDb } from '../src/db/client';
import { users, type UserRow } from '../src/db/schema';
import type { AppDeps } from '../src/deps';
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
    storageDir,
    queryTimeoutMs: 2000,
    queryMaxRows: 1000,
    renderTimeoutMs: 5000,
    reportRetentionDays: 30,
    tz: 'Europe/Moscow',
    port: 0,
    cookieSecure: false,
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

export async function createTestApp(
  overrides: Partial<Omit<AppDeps, 'config' | 'db' | 'storage'>> = {},
): Promise<TestApp> {
  const databaseUrl = await createTestDatabase();
  const storageDir = await mkdtemp(join(tmpdir(), 'cr-test-'));
  const config = testConfig(databaseUrl, storageDir);
  const { db, pool } = createDb(databaseUrl);
  const gatePool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  gatePool.on('error', () => {});
  await migrateDb(db);
  const deps: AppDeps = {
    config,
    db,
    storage: new Storage(storageDir, createRemoveGate(gatePool)),
    sources: createSourcePools({ db, config }),
    carbone: { render: notConfigured('carbone') },
    onlyoffice: { forceSave: notConfigured('onlyoffice') },
    fetchFile: notConfigured('fetchFile'),
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
  opts: { queries?: TemplateQuery[]; params?: TemplateParam[] } = {},
): Promise<string> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/templates',
    headers: { cookie },
    payload: { name: `Шаблон ${randomUUID().slice(0, 4)}`, datasourceId, blank: 'docx' },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  const id = r.json().id as string;
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
