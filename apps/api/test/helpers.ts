import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role, TemplateParam, TemplateQuery } from '@carbone-reports/shared';
import type { Redis } from 'ioredis';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp, type App } from '../src/app';
import type { Config, S3Settings } from '../src/config';
import { createDb, migrateDb } from '../src/db/client';
import { eq } from 'drizzle-orm';
import { templates, users, type UserRow } from '../src/db/schema';
import type { AppDeps } from '../src/deps';
import { createRedis } from '../src/lib/redis';
import { createStorage } from '../src/lib/create-storage';
import { createS3Client } from '../src/lib/s3-storage';
import { createRunFileGate } from '../src/lib/run-file-gate';
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
    storageBackend: 'local',
    s3: null,
    queryTimeoutMs: 2000,
    queryMaxRows: 1000,
    renderTimeoutMs: 5000,
    reportTimeoutMs: 20000,
    reportRetentionDays: 30,
    tz: 'Europe/Moscow',
    port: 0,
    cookieSecure: false,
    ldap: null,
    backupAgent: null,
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

/** Хранилище интеграционных тестов: local, или s3 при TEST_STORAGE_BACKEND=s3 (pnpm test:int:s3). */
export const testStorageBackend: 'local' | 's3' =
  process.env.TEST_STORAGE_BACKEND === 's3' ? 's3' : 'local';

/** Настройки S3 для SeaweedFS из global-setup. */
export function testS3Settings(bucket: string, over: Partial<S3Settings> = {}): S3Settings {
  const s3 = inject('s3');
  return {
    endpoint: s3.endpoint,
    region: 'us-east-1',
    bucket,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    forcePathStyle: true,
    createBucket: false,
    ...over,
  };
}

/** Уникальное имя бакета: 3–63 символа, строчные буквы, цифры и «-». */
export const testBucketName = () => `cr-${randomUUID()}`;

/** Все ключи бакета по алфавиту. */
export async function listKeys(settings: S3Settings): Promise<string[]> {
  const client = createS3Client(settings);
  try {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: settings.bucket, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  } finally {
    client.destroy();
  }
}

/** Удаляет все объекты бакета и сам бакет. */
export async function dropTestBucket(settings: S3Settings): Promise<void> {
  const keys = await listKeys(settings);
  const client = createS3Client(settings);
  try {
    for (let i = 0; i < keys.length; i += 1000) {
      const Objects = keys.slice(i, i + 1000).map((Key) => ({ Key }));
      await client.send(
        new DeleteObjectsCommand({ Bucket: settings.bucket, Delete: { Objects, Quiet: true } }),
      );
    }
    await client.send(new DeleteBucketCommand({ Bucket: settings.bucket }));
  } finally {
    client.destroy();
  }
}

export interface TestBucket {
  settings: S3Settings;
  client: S3Client;
  drop(): Promise<void>;
}

/**
 * Пустой бакет SeaweedFS для теста; drop() удаляет его вместе с объектами (непустой бакет
 * SeaweedFS удалить не даст: -s3.allowDeleteBucketNotEmpty=false).
 */
export async function createTestBucket(): Promise<TestBucket> {
  const settings = testS3Settings(testBucketName());
  const client = createS3Client(settings);
  await client.send(new CreateBucketCommand({ Bucket: settings.bucket }));
  return {
    settings,
    client,
    async drop() {
      await dropTestBucket(settings);
      client.destroy();
    },
  };
}

/**
 * `redis` по умолчанию — свой клиент тестового Redis с уникальным `keyPrefix`
 * (закрывается в `close()`); переданный явно клиент или `null` тест закрывает сам.
 * `config` — переопределение отдельных значений тестовой конфигурации.
 * Хранилище — по TEST_STORAGE_BACKEND: local (каталог во временной папке) или s3 (свой бакет SeaweedFS).
 */
export async function createTestApp(
  overrides: Partial<Omit<AppDeps, 'config' | 'db' | 'storage'>> = {},
  config: Partial<Config> = {},
): Promise<TestApp> {
  const databaseUrl = await createTestDatabase();
  const storageDir = await mkdtemp(join(tmpdir(), 'cr-test-'));
  const bucket = testStorageBackend === 's3' ? await createTestBucket() : null;
  const cfg: Config = {
    ...testConfig(databaseUrl, storageDir),
    storageBackend: testStorageBackend,
    s3: bucket?.settings ?? null,
    ...config,
  };
  const { db, pool } = createDb(databaseUrl);
  const gatePool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  gatePool.on('error', () => {});
  const runFilePool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  runFilePool.on('error', () => {});
  await migrateDb(db);
  const ownRedis = 'redis' in overrides ? null : await createTestRedis();
  const deps: AppDeps = {
    config: cfg,
    db,
    storage: await createStorage(cfg, createRemoveGate(gatePool)),
    runFileGate: createRunFileGate(runFilePool),
    sources: createSourcePools({ db, config: cfg }),
    carbone: { render: notConfigured('carbone') },
    onlyoffice: { forceSave: notConfigured('onlyoffice') },
    fetchFile: notConfigured('fetchFile'),
    redis: ownRedis,
    ldap: null,
    backupAgent: null,
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
      await runFilePool.end();
      await pool.end();
      await deps.storage.close?.();
      await ownRedis?.quit().catch(() => ownRedis.disconnect());
      await rm(storageDir, { recursive: true, force: true });
      await bucket?.drop();
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
