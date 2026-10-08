import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { inject } from 'vitest';

/** Миграции приложения — те же, что Dockerfile кладёт в /agent/drizzle. */
export const MIGRATIONS = fileURLToPath(new URL('../../api/drizzle', import.meta.url));

export function pgUrl(db: string): string {
  const p = inject('pg');
  return `postgres://${p.user}:${p.password}@${p.host}:${p.port}/${db}`;
}

/** Миграции из apps/api/drizzle: все или первые n (схема старой версии приложения). */
export async function migrateTo(db: string, migrations: 'all' | number): Promise<void> {
  let folder = MIGRATIONS;
  let tmp: string | null = null;
  if (migrations !== 'all') {
    tmp = await mkdtemp(join(tmpdir(), 'cr-mig-'));
    await cp(MIGRATIONS, tmp, { recursive: true });
    const journalPath = join(tmp, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, migrations);
    await writeFile(journalPath, JSON.stringify(journal));
    folder = tmp;
  }
  const pool = new pg.Pool({ connectionString: pgUrl(db), max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

/** Новая база приложения (как app в compose) со всеми или первыми n миграциями. */
export async function createAppDatabase(migrations: 'all' | number = 'all'): Promise<string> {
  const name = `app_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: pgUrl('postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  await migrateTo(name, migrations);
  return name;
}

export const hostPool = (db: string) =>
  new pg.Pool({ connectionString: pgUrl(db), max: 2, application_name: 'it' });

export const hostRedis = () => new Redis(inject('redis').url, { maxRetriesPerRequest: 1 });

export interface OperationBody {
  id: string;
  type: 'backup' | 'restore';
  requestedBy: string;
  backup: string | null;
  phase: string;
  status: 'running' | 'succeeded' | 'failed';
  error: string | null;
  log: string[];
  recovery: { backup: string; preRestore: string | null } | null;
}

export interface StartedAgent {
  container: StartedTestContainer;
  call<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; body: T }>;
  sh(script: string): Promise<{ exitCode: number; output: string }>;
  /** stdout и stderr контейнера с момента старта (docker compose logs backup). */
  logs(): string;
  waitIdle(timeoutMs?: number): Promise<OperationBody>;
  stop(): Promise<void>;
}

export async function startAgent(o: {
  db: string;
  bucket: string;
  env?: Record<string, string>;
  /** Сетевые псевдонимы контейнера (в compose — backup-agent в сети backup). */
  aliases?: string[];
  files?: { content: string; target: string; mode?: number }[];
}): Promise<StartedAgent> {
  const token = randomBytes(32).toString('hex');
  const p = inject('pg');
  const s3 = inject('s3');
  // Журнал подключается до start(): если агент не стартовал (wait strategy), его вывод — в ошибке.
  let logs = '';
  const builder = new GenericContainer(inject('agentImage'))
    .withNetworkMode(inject('network'))
    .withNetworkAliases(...(o.aliases ?? []))
    .withEnvironment({
      BACKUP_AGENT_TOKEN: token,
      REDIS_URL: `redis://:${inject('redis').password}@redis:6379`,
      PGHOST: 'postgres',
      PGUSER: p.user,
      PGPASSWORD: p.password,
      PGDATABASE: o.db,
      STORAGE_BACKEND: 's3',
      S3_ENDPOINT: 'http://s3:8333',
      S3_REGION: 'us-east-1',
      S3_BUCKET: o.bucket,
      S3_ACCESS_KEY_ID: s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
      S3_FORCE_PATH_STYLE: 'true',
      BACKUP_AGENT_TERMINATE_DELAY_MS: '500',
      TZ: 'UTC',
      ...o.env,
    })
    .withCopyContentToContainer(
      (o.files ?? []).map((f) => ({ content: f.content, target: f.target, mode: f.mode ?? 0o755 })),
    )
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp('/health', 8080))
    .withLogConsumer((stream) => {
      stream.on('data', (d: Buffer | string) => {
        logs += d.toString();
      });
    });
  let container: StartedTestContainer;
  try {
    container = await builder.start();
  } catch (e) {
    throw new Error(`агент не стартовал: ${(e as Error).message}\nвывод контейнера:\n${logs}`, {
      cause: e,
    });
  }
  const base = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
  const agent: StartedAgent = {
    container,
    async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, tok = token) {
      const res = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${tok}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
    },
    async sh(script) {
      const r = await container.exec(['sh', '-c', script]);
      return { exitCode: r.exitCode, output: r.output };
    },
    logs: () => logs,
    async waitIdle(timeoutMs = 120_000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const r = await agent.call<OperationBody>('GET', '/operation');
        if (r.status === 200 && r.body.status !== 'running') return r.body;
        if (Date.now() > until)
          throw new Error(`операция не завершилась: ${JSON.stringify(r.body)}`);
        await new Promise((res) => setTimeout(res, 300));
      }
    },
    stop: async () => {
      await container.stop();
    },
  };
  // Бакет в compose создаёт API; здесь — rclone в контейнере агента теми же ключами.
  // s3_env задаёт NO_CHECK_BUCKET=true (с ним rclone mkdir бакет не создаёт) — здесь он выключен.
  const mk = await rclone(
    agent,
    'RCLONE_CONFIG_S3_NO_CHECK_BUCKET=false rclone mkdir "s3:$S3_BUCKET"',
  );
  if (mk.exitCode !== 0) throw new Error(`бакет не создан: ${mk.output}`);
  return agent;
}

/** rclone внутри контейнера агента с настройками из его окружения (lib.sh: s3_env). */
export const rclone = (agent: StartedAgent, cmd: string) =>
  agent.sh(`. /backup/lib.sh && s3_env && ${cmd}`);
