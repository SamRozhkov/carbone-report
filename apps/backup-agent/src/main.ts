import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import pg from 'pg';
import { BackupAgent } from './agent';
import { loadAgentConfig, pgConnection, type AgentConfig, type PgConnection } from './config';
import { scheduleCron } from './cron';
import { flockFile } from './lock';
import { bundledMigrationHashes } from './migrations';
import { fileOpLogs } from './oplog';
import { createRedactor } from './redact';
import { run } from './run';
import { buildServer, listenRetrying } from './server';
import { fileStateStore, resolveExternally } from './state';
import { createSteps } from './steps';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

// scripts/restore.sh: `docker compose run --rm --no-deps --entrypoint node backup /agent/dist/main.js resolve-external`.
if (process.argv[2] === 'resolve-external') {
  const store = fileStateStore(join(process.env.BACKUPS_DIR || '/backups', '.op'));
  log(
    (await resolveExternally(store))
      ? 'незавершённое восстановление из админки отмечено: failed (resolved externally)'
      : 'незавершённых восстановлений из админки нет',
  );
  process.exit(0);
}

let cfg: AgentConfig;
let pgConn: PgConnection;
try {
  cfg = loadAgentConfig(process.env);
  pgConn = pgConnection(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

log(
  `carbone-reports backup запущен: версия ${process.env.APP_VERSION || 'dev'}, коммит ${process.env.APP_COMMIT || 'unknown'}, сборка ${process.env.APP_BUILD_DATE || 'unknown'}`,
);

const redact = createRedactor(process.env);
const redis = new Redis(cfg.redisUrl, {
  maxRetriesPerRequest: 2,
  connectTimeout: 2000,
  commandTimeout: 2000,
});
let lastRedisWarn = 0;
redis.on('error', (e: Error) => {
  if (Date.now() - lastRedisWarn > 30_000) {
    lastRedisWarn = Date.now();
    log(`Redis: ${redact(e.message)}`);
  }
});
const pool = new pg.Pool({
  ...pgConn,
  max: 2,
  application_name: 'backup-agent',
});
pool.on('error', (e) => log(`postgres: ${redact(e.message)}`));

const known = bundledMigrationHashes(cfg.migrationsDir);
const opDir = join(cfg.backupsDir, '.op');
await mkdir(opDir, { recursive: true });

const agent = new BackupAgent({
  steps: createSteps({ cfg, env: process.env, redis, pool, redact, knownMigrations: known, run }),
  store: fileStateStore(opDir),
  lock: flockFile(join(cfg.backupsDir, '.op.lock')),
  logs: fileOpLogs(opDir),
  // Код восстановления — только сюда (docker compose logs backup), не в журнал операции (§26.4).
  printCode: (code) => console.log(`КОД ВОССТАНОВЛЕНИЯ: ${code}`),
  log,
  reassertMs: cfg.reassertMs,
});
await agent.init();

const stopCron = scheduleCron(cfg.cron, cfg.tz, () => {
  agent.startBackup('cron').then(
    (r) => {
      if ('busy' in r) log('бэкап по расписанию пропущен: идёт другая операция с бэкапами');
    },
    (e: Error) => log(`бэкап по расписанию не запущен: ${redact(e.message)}`),
  );
});

const app = buildServer({ agent, token: cfg.token, backupsDir: cfg.backupsDir });
try {
  await listenRetrying(() => app.listen({ host: cfg.host, port: cfg.port }), cfg.host, log);
} catch (e) {
  console.error(`агент бэкапа не запущен: ${redact((e as Error).message)}`);
  process.exit(1);
}
log(
  `агент бэкапа: ${cfg.host}:${cfg.port}, расписание «${cfg.cron}» (TZ=${cfg.tz}), хранилище ${cfg.storageBackend}, миграций в образе: ${known.length}`,
);

async function shutdown(signal: string) {
  log(`${signal}: остановка агента`);
  stopCron();
  agent.close();
  await app.close();
  await pool.end().catch(() => {});
  redis.disconnect();
  process.exit(0);
}
// node — PID 1 в контейнере: без обработчиков docker stop ждал бы KILL.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
