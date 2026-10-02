import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp, type App } from '../src/app';
import type { Config } from '../src/config';
import { createDb, migrateDb } from '../src/db/client';
import type { AppDeps } from '../src/deps';
import { Storage } from '../src/lib/storage';

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
  await migrateDb(db);
  const deps: AppDeps = {
    config,
    db,
    storage: new Storage(storageDir),
    sources: {
      get: notConfigured('sources'),
      invalidate: async () => {},
      closeAll: async () => {},
    },
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
      await pool.end();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}
