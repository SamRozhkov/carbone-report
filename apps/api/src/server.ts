import { buildApp } from './app';
import { loadConfig } from './config';
import pg from 'pg';
import { createDb, migrateDb } from './db/client';
import type { AppDeps } from './deps';
import { fetchFile } from './lib/fetch-file';
import { createRedis } from './lib/redis';
import { Storage } from './lib/storage';
import { createRunFileGate } from './lib/run-file-gate';
import { createRemoveGate } from './lib/storage-gate';
import { ensureAdmin } from './modules/auth/bootstrap';
import { CarboneClient } from './modules/carbone/client';
import { redisTemplateCache } from './modules/carbone/template-cache';
import { createSourcePools } from './modules/datasources/pools';
import { createOnlyOfficeCommands } from './modules/onlyoffice/commands';
import { startCleanupTimer } from './modules/reports/cleanup';
import { migrateTemplateFiles } from './modules/templates/file-migration';

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl);
const gatePool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
gatePool.on('error', (err) => console.error('gate pool', err));
// Сборки файлов запусков: соединение держится всё время рендера, поэтому пул свой и небольшой.
const runFilePool = new pg.Pool({ connectionString: config.databaseUrl, max: 3 });
runFilePool.on('error', (err) => console.error('run file pool', err));
await migrateDb(db);

// Fastify-логгера ещё нет; ошибки Redis до него пишем в консоль (как ensureAdmin).
const redis = createRedis(config.redisUrl, {
  warn: (o, m) => console.warn(m, o),
});
const carbone = new CarboneClient({ baseUrl: config.carboneUrl, cache: redisTemplateCache(redis) });
const deps: AppDeps = {
  config,
  db,
  storage: new Storage(config.storageDir, createRemoveGate(gatePool)),
  runFileGate: createRunFileGate(runFilePool),
  sources: createSourcePools({ db, config }),
  carbone,
  onlyoffice: createOnlyOfficeCommands({
    baseUrl: config.onlyofficeInternalUrl,
    secret: config.onlyofficeJwtSecret,
  }),
  fetchFile,
  redis,
};

await ensureAdmin(deps, console);
const app = await buildApp(deps);
carbone.log = app.log;
// До listen: к первому запросу все строки уже указывают на пути с версией.
await migrateTemplateFiles({ db, storage: deps.storage, log: app.log });
const stopCleanup = startCleanupTimer(deps, app.log);

async function shutdown(signal: string) {
  app.log.info(`${signal}: остановка`);
  stopCleanup();
  await app.close();
  await deps.sources.closeAll();
  await gatePool.end();
  await runFilePool.end();
  await pool.end();
  await redis.quit().catch(() => redis.disconnect());
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
