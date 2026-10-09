import { buildApp } from './app';
import { loadConfig } from './config';
import pg from 'pg';
import { createDb, migrateDb } from './db/client';
import type { AppDeps } from './deps';
import { fetchFile } from './lib/fetch-file';
import { createRedis } from './lib/redis';
import { createStorage } from './lib/create-storage';
import { withStartupLock } from './lib/startup-lock';
import { createRunFileGate } from './lib/run-file-gate';
import { createRemoveGate } from './lib/storage-gate';
import { ensureAdmin } from './modules/auth/bootstrap';
import { createLdapAuthenticator } from './modules/auth/ldap';
import { createAgentClient } from './modules/backups/agent-client';
import { createSourcePools } from './modules/datasources/pools';
import { createOnlyOfficeCommands } from './modules/onlyoffice/commands';
import { createRenderHandoff } from './modules/render/handoff';
import { createOnlyOfficeConverter } from './modules/render/onlyoffice-convert';
import { RenderPool } from './modules/render/pool';
import { createEmbeddedRenderer } from './modules/render/renderer';
import { renderWorkerUrl } from './modules/render/worker-url';
import { startCleanupTimer } from './modules/reports/cleanup';
import { migrateTemplateFiles } from './modules/templates/file-migration';

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, (err) => console.error('db pool', err.message));
const gatePool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 2,
  application_name: 'api',
});
gatePool.on('error', (err) => console.error('gate pool', err));
// Сборки файлов запусков: соединение держится всё время рендера, поэтому пул свой и небольшой.
const runFilePool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 3,
  application_name: 'api',
});
runFilePool.on('error', (err) => console.error('run file pool', err));
// Несколько реплик (Helm): миграции схемы — одна реплика за раз, остальные ждут и видят, что всё применено.
await withStartupLock(pool, () => migrateDb(db));
// До buildApp и listen: с s3 нет бакета (и S3_CREATE_BUCKET=false) — API не запускается.
// Fastify-логгера ещё нет; сообщение о созданном бакете — в консоль (как ensureAdmin).
const storage = await createStorage(config, createRemoveGate(gatePool), console);

// Fastify-логгера ещё нет; ошибки Redis до него пишем в консоль (как ensureAdmin).
const redis = createRedis(config.redisUrl, {
  warn: (o, m) => console.warn(m, o),
});
// Встроенный Carbone в worker_threads. Логгер Fastify появится после buildApp:
// аварии потоков до этого пишем в консоль, потом — в журнал приложения (carbone.log).
const consoleLog = { error: (o: object, m: string) => console.error(m, o) };
const worker = renderWorkerUrl();
const renderPool = new RenderPool({
  size: config.renderWorkers,
  workerUrl: worker.url,
  execArgv: worker.execArgv,
  onCrash: (err, ctx) =>
    (carbone.log ?? consoleLog).error(
      { err, hadTask: ctx?.hadTask, beforeReady: ctx?.beforeReady },
      'поток рендера завершился аварийно',
    ),
});
const renderFiles = createRenderHandoff(config.appSecret);
const carbone = createEmbeddedRenderer({
  pool: renderPool,
  handoff: renderFiles,
  convert: createOnlyOfficeConverter({
    baseUrl: config.onlyofficeInternalUrl,
    secret: config.onlyofficeJwtSecret,
  }),
  selfUrl: config.apiSelfUrl,
  log: consoleLog,
});
const deps: AppDeps = {
  config,
  db,
  storage,
  runFileGate: createRunFileGate(runFilePool),
  sources: createSourcePools({ db, config }),
  carbone,
  onlyoffice: createOnlyOfficeCommands({
    baseUrl: config.onlyofficeInternalUrl,
    secret: config.onlyofficeJwtSecret,
  }),
  fetchFile,
  redis,
  ldap: config.ldap ? createLdapAuthenticator(config.ldap, console) : null,
  backupAgent: config.backupAgent ? createAgentClient(config.backupAgent) : null,
  renderFiles,
};

await ensureAdmin(deps, console);
const app = await buildApp(deps);
carbone.log = app.log;
// До listen: к первому запросу все строки уже указывают на пути с версией.
await withStartupLock(pool, () =>
  migrateTemplateFiles({ db, storage: deps.storage, log: app.log }),
);
const stopCleanup = startCleanupTimer(deps, app.log);

async function shutdown(signal: string) {
  app.log.info(`${signal}: остановка`);
  stopCleanup();
  await app.close();
  await deps.sources.closeAll();
  await gatePool.end();
  await runFilePool.end();
  await pool.end();
  await deps.storage.close?.();
  await redis.quit().catch(() => redis.disconnect());
  await renderPool.destroy();
  renderFiles.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
