import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, migrateDb } from './db/client';
import type { AppDeps } from './deps';
import { fetchFile } from './lib/fetch-file';
import { Storage } from './lib/storage';
import { ensureAdmin } from './modules/auth/bootstrap';
import { CarboneClient } from './modules/carbone/client';
import { createSourcePools } from './modules/datasources/pools';
import { createOnlyOfficeCommands } from './modules/onlyoffice/commands';
import { startCleanupTimer } from './modules/reports/cleanup';
import { migrateTemplateFiles } from './modules/templates/file-migration';

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl);
await migrateDb(db);

const carbone = new CarboneClient({ baseUrl: config.carboneUrl });
const deps: AppDeps = {
  config,
  db,
  storage: new Storage(config.storageDir),
  sources: createSourcePools({ db, config }),
  carbone,
  onlyoffice: createOnlyOfficeCommands({
    baseUrl: config.onlyofficeInternalUrl,
    secret: config.onlyofficeJwtSecret,
  }),
  fetchFile,
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
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
