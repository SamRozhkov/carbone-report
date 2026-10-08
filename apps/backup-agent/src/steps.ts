import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Steps } from './agent';
import { backupName, rotatePreRestore } from './backups';
import type { AgentConfig } from './config';
import { MANIFEST_FILES, parseManifest } from './manifest';
import { assertKnownMigration } from './migrations';
import type { Redact } from './redact';
import { childEnv, type Out, type Runner } from './run';

/** Флаг обслуживания (§26.2): его читает middleware API. */
export const MAINTENANCE_KEY = 'cr:maintenance';

export interface StepsDeps {
  cfg: Pick<
    AgentConfig,
    'backupsDir' | 'scriptsDir' | 'migrationsDir' | 'storageBackend' | 'terminateDelayMs'
  >;
  env: NodeJS.ProcessEnv;
  redis: Redis;
  pool: pg.Pool;
  redact: Redact;
  knownMigrations: readonly string[];
  run: Runner;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Удаляет все ключи Redis, кроме keep: SCAN по страницам и UNLINK (§26.2, фаза redis). */
export async function flushExcept(redis: Redis, keep: string): Promise<number> {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
    cursor = next;
    const victims = keys.filter((k) => k !== keep);
    if (victims.length > 0) removed += await redis.unlink(...victims);
  } while (cursor !== '0');
  return removed;
}

const PRE_SQL =
  'DROP SCHEMA IF EXISTS drizzle CASCADE;\nDROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n';

export function createSteps(d: StepsDeps): Steps {
  const { cfg } = d;
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dirOf = (name: string) => join(cfg.backupsDir, name);
  const script = (name: string) => join(cfg.scriptsDir, name);
  const exec = (cmd: string, args: string[], out: Out, extra: Record<string, string> = {}) =>
    d.run(cmd, args, { env: childEnv(d.env, extra), out, redact: d.redact });

  return {
    async backup(out) {
      await exec(script('backup.sh'), [], out);
    },

    async verify(name, out) {
      const dir = dirOf(name);
      for (const f of [...MANIFEST_FILES, 'manifest.txt']) {
        try {
          await access(join(dir, f));
        } catch {
          throw new Error(`в бэкапе ${name} нет ${f}`);
        }
      }
      const manifest = parseManifest(await readFile(join(dir, 'manifest.txt'), 'utf8'));
      for (const f of MANIFEST_FILES)
        if ((await sha256File(join(dir, f))) !== manifest.files[f].sha256)
          throw new Error(`контрольная сумма ${f} не совпадает с manifest.txt`);
      out('контрольные суммы совпадают с manifest.txt');
      assertKnownMigration(manifest.lastMigration, d.knownMigrations);
      out('версия схемы бэкапа известна этой версии приложения');
      if (cfg.storageBackend === 's3') {
        await exec(
          'sh',
          [
            '-c',
            `. "${script('lib.sh')}" && check_storage_backend && s3_env && rclone -q lsf --max-depth 1 "s3:$S3_BUCKET" >/dev/null`,
          ],
          out,
        ).catch((e: Error) => {
          throw new Error(`бакет S3 недоступен: ${e.message}`);
        });
        out('бакет S3 читается');
      } else {
        await exec('sh', ['-c', 'mountpoint -q /data && [ -w /data ]'], out).catch(() => {
          throw new Error(
            '/data не смонтирован на запись: при STORAGE_BACKEND=local смонтируйте том хранилища в сервис backup',
          );
        });
      }
    },

    async preBackup(source, out) {
      const name = backupName(now(), 'pre-restore-');
      // backup.sh с BACKUP_NAME=pre-restore-* обычные бэкапы не ротирует (BACKUP_KEEP — только для них).
      await exec(script('backup.sh'), [], out, { BACKUP_NAME: name });
      for (const old of await rotatePreRestore(cfg.backupsDir, undefined, source))
        out(`удалён старый бэкап ${old}`);
      return name;
    },

    async terminateApi(out) {
      // Пауза: за 3 с все экземпляры API увидят флаг (кэш 1 с) и перестанут брать соединения.
      await sleep(cfg.terminateDelayMs);
      const r = await d.pool.query<{ n: string }>(
        `select count(pg_terminate_backend(pid))::text as n from pg_stat_activity
         where application_name = 'api' and datname = current_database() and pid <> pg_backend_pid()`,
      );
      out(`завершено сессий API: ${r.rows[0]?.n ?? '0'}`);
    },

    async restoreDb(name, out) {
      // Как scripts/restore.sh: SQL сначала пишется в файл (обрыв pg_restore не даст обрезанный скрипт),
      // затем схемы drizzle и public удаляются и создаются из дампа в ОДНОЙ транзакции (psql -1).
      const tmp = await mkdtemp(join(tmpdir(), 'cr-restore-'));
      try {
        const sql = join(tmp, 'restore.sql');
        const pre = join(tmp, 'restore-pre.sql');
        await exec('pg_restore', ['--no-owner', '-f', sql, join(dirOf(name), 'db.dump')], out);
        await writeFile(pre, PRE_SQL);
        await exec('psql', ['-1', '-v', 'ON_ERROR_STOP=1', '-q', '-f', pre, '-f', sql], out);
        out('база заменена данными из бэкапа');
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },

    async migrate(out) {
      await migrate(drizzle(d.pool), { migrationsFolder: cfg.migrationsDir });
      out('миграции применены');
    },

    async restoreStorage(name, out) {
      await exec(script('entrypoint.sh'), ['restore-storage'], out, { RESTORE_DIR: dirOf(name) });
    },

    async flushRedis(out) {
      out(`удалено ключей Redis: ${await flushExcept(d.redis, MAINTENANCE_KEY)}`);
    },

    async setFlag(flag) {
      await d.redis.set(MAINTENANCE_KEY, JSON.stringify(flag));
    },

    async clearFlag() {
      await d.redis.del(MAINTENANCE_KEY);
    },
  };
}
