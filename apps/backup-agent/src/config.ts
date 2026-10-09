import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { checkCron } from './cron';
import { withPassword } from './url-password';

const Env = z.object({
  BACKUP_AGENT_TOKEN: z.string({ error: 'обязателен' }).min(32, 'минимум 32 символа'),
  // §26.1: слушать только сеть backup — compose задаёт сетевой псевдоним backup-agent.
  BACKUP_AGENT_HOST: z.string().min(1).default('0.0.0.0'),
  BACKUP_AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  REDIS_URL: z.string({ error: 'обязателен' }).min(1, 'обязателен'),
  REDIS_PASSWORD: z.string().optional(),
  STORAGE_BACKEND: z.enum(['local', 's3'], { error: 'ожидается local или s3' }).default('local'),
  BACKUP_CRON: z.string().default('0 3 * * *'),
  TZ: z.string().min(1).default('UTC'),
  BACKUPS_DIR: z.string().min(1).default('/backups'),
  BACKUP_SCRIPTS_DIR: z.string().min(1).default('/backup'),
  MIGRATIONS_DIR: z.string().min(1).default('/agent/drizzle'),
  // Для тестов: задержка перед pg_terminate_backend (§26.2: 3 с) и период повтора флага (5 с).
  BACKUP_AGENT_TERMINATE_DELAY_MS: z.coerce.number().int().min(0).default(3000),
  BACKUP_AGENT_REASSERT_MS: z.coerce.number().int().min(100).default(5000),
});

export interface AgentConfig {
  /** Не логируется и не попадает в сообщения об ошибках. */
  token: string;
  /** Адрес прослушивания HTTP. */
  host: string;
  port: number;
  redisUrl: string;
  storageBackend: 'local' | 's3';
  cron: string;
  tz: string;
  /** Каталог бэкапов (том BACKUP_DIR). */
  backupsDir: string;
  /** Скрипты docker/backup в образе. */
  scriptsDir: string;
  /** Миграции apps/api/drizzle того же коммита. */
  migrationsDir: string;
  terminateDelayMs: number;
  reassertMs: number;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const r = Env.safeParse(env);
  if (!r.success) {
    // Только имена переменных и правила — значения (токен) в сообщение не попадают.
    const msg = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Неверная конфигурация агента: ${msg}`);
  }
  const e = r.data;
  let redisUrl: string;
  try {
    redisUrl = withPassword(e.REDIS_URL, e.REDIS_PASSWORD);
  } catch (err) {
    throw new Error(`Неверная конфигурация агента: REDIS_URL: ${(err as Error).message}`, {
      cause: err,
    });
  }
  return {
    token: e.BACKUP_AGENT_TOKEN,
    host: e.BACKUP_AGENT_HOST,
    port: e.BACKUP_AGENT_PORT,
    redisUrl,
    storageBackend: e.STORAGE_BACKEND,
    cron: checkCron(e.BACKUP_CRON, e.TZ),
    tz: e.TZ,
    backupsDir: e.BACKUPS_DIR,
    scriptsDir: e.BACKUP_SCRIPTS_DIR,
    migrationsDir: e.MIGRATIONS_DIR,
    terminateDelayMs: e.BACKUP_AGENT_TERMINATE_DELAY_MS,
    reassertMs: e.BACKUP_AGENT_REASSERT_MS,
  };
}

export type PgSsl =
  false | { rejectUnauthorized: boolean; ca?: string; checkServerIdentity?: () => undefined };

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  database: string;
  password?: string;
  ssl: PgSsl;
}

/**
 * SSL пула агента — как у libpq (pg_dump, psql в тех же скриптах читают PGSSLMODE сами):
 * require — шифрование без проверки, verify-ca — цепочка без имени хоста, verify-full — цепочка и имя.
 */
function pgSsl(env: NodeJS.ProcessEnv): PgSsl {
  const mode = env.PGSSLMODE || 'disable';
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode !== 'verify-ca' && mode !== 'verify-full')
    throw new Error('PGSSLMODE: поддерживаются disable, require, verify-ca, verify-full');
  let ca: string | undefined;
  if (env.PGSSLROOTCERT) {
    try {
      ca = readFileSync(env.PGSSLROOTCERT, 'utf8');
    } catch {
      throw new Error(`PGSSLROOTCERT: не удалось прочитать ${env.PGSSLROOTCERT}`);
    }
  }
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
    ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
  };
}

/** Подключение агента к базе приложения: те же PG* и умолчания, что у backup.sh. */
export function pgConnection(env: NodeJS.ProcessEnv): PgConnection {
  return {
    host: env.PGHOST || 'postgres',
    port: Number(env.PGPORT || 5432),
    user: env.PGUSER || 'app',
    database: env.PGDATABASE || 'app',
    password: env.PGPASSWORD,
    ssl: pgSsl(env),
  };
}
