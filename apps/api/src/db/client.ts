import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export function createDb(url: string, onError: (err: Error) => void = () => {}) {
  // application_name: по нему агент бэкапа завершает сессии API перед заменой базы (§26.2).
  const pool = new pg.Pool({ connectionString: url, max: 10, application_name: 'api' });
  // Простаивающее соединение, завершённое pg_terminate_backend, пул выбрасывает сам; без
  // обработчика событие error уронило бы процесс.
  pool.on('error', onError);
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];

export async function migrateDb(db: Db): Promise<void> {
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'drizzle');
  await migrate(db, { migrationsFolder });
}
