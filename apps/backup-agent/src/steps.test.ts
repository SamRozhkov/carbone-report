import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FUTURE_BACKUP } from './migrations';
import type { Runner } from './run';
import {
  createSteps,
  flushExcept,
  MAINTENANCE_KEY,
  withStartupLock,
  type StepsDeps,
} from './steps';

const KNOWN = 'a'.repeat(64);
const NAME = '2026-10-08T03-00-00Z';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'steps-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function backup(
  name = NAME,
  opts: { migration?: string; corrupt?: boolean; skip?: string } = {},
) {
  const dir = join(root, name);
  await mkdir(dir);
  const files = { 'db.dump': 'dump', 'storage.tar.gz': 'tar' };
  await writeFile(
    join(dir, 'manifest.txt'),
    [
      `created_utc=${name}`,
      `last_migration=${opts.migration ?? KNOWN}`,
      `db.dump size=4 sha256=${sha(files['db.dump'])}`,
      `storage.tar.gz size=3 sha256=${sha(files['storage.tar.gz'])}`,
    ].join('\n'),
  );
  for (const [f, c] of Object.entries(files)) if (f !== opts.skip) await writeFile(join(dir, f), c);
  if (opts.corrupt) await writeFile(join(dir, 'db.dump'), 'испорчен');
  return dir;
}

interface Call {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function make(over: Partial<StepsDeps> = {}, onRun?: (c: Call) => Promise<void> | void) {
  const calls: Call[] = [];
  const run: Runner = async (cmd, args, o) => {
    const c = { cmd, args, env: o.env };
    calls.push(c);
    await onRun?.(c);
  };
  const steps = createSteps({
    cfg: {
      backupsDir: root,
      scriptsDir: '/backup',
      migrationsDir: '/agent/drizzle',
      storageBackend: 's3',
      terminateDelayMs: 0,
    },
    env: { PGPASSWORD: 'pw', BACKUP_AGENT_TOKEN: 'x'.repeat(32), REDIS_URL: 'redis://:p@r:6379' },
    redis: {} as Redis,
    pool: {} as pg.Pool,
    redact: (s) => s,
    knownMigrations: [KNOWN],
    run,
    now: () => new Date('2026-10-08T10:00:00.123Z'),
    ...over,
  });
  return { steps, calls };
}

const out = () => {};

describe('verify', () => {
  it('s3: контрольные суммы, версия схемы, затем rclone lsf бакета; токен и REDIS_URL скрипту не передаются', async () => {
    await backup();
    const { steps, calls } = make();
    await steps.verify(NAME, out);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('sh');
    expect(calls[0]!.args[1]).toContain(
      '. "/backup/lib.sh" && check_storage_backend && s3_env && rclone -q lsf --max-depth 1 "s3:$S3_BUCKET"',
    );
    expect(calls[0]!.env).not.toHaveProperty('BACKUP_AGENT_TOKEN');
    expect(calls[0]!.env).not.toHaveProperty('REDIS_URL');
  });

  it('нет файла — отказ до любых команд', async () => {
    await backup(NAME, { skip: 'storage.tar.gz' });
    const { steps, calls } = make();
    await expect(steps.verify(NAME, out)).rejects.toThrow(`в бэкапе ${NAME} нет storage.tar.gz`);
    expect(calls).toEqual([]);
  });

  it('sha256 не совпадает', async () => {
    await backup(NAME, { corrupt: true });
    await expect(make().steps.verify(NAME, out)).rejects.toThrow(
      'контрольная сумма db.dump не совпадает с manifest.txt',
    );
  });

  it('бэкап «из будущего» — отказ, бакет не проверяется', async () => {
    await backup(NAME, { migration: 'f'.repeat(64) });
    const { steps, calls } = make();
    await expect(steps.verify(NAME, out)).rejects.toThrow(FUTURE_BACKUP);
    expect(calls).toEqual([]);
  });

  it('бакет не читается — понятная ошибка', async () => {
    await backup();
    const { steps } = make({}, () => {
      throw new Error('sh: directory not found');
    });
    await expect(steps.verify(NAME, out)).rejects.toThrow(
      'бакет S3 недоступен: sh: directory not found',
    );
  });

  it('local: /data должен быть смонтирован на запись', async () => {
    await backup();
    const { steps, calls } = make(
      {
        cfg: {
          backupsDir: root,
          scriptsDir: '/backup',
          migrationsDir: '/m',
          storageBackend: 'local',
          terminateDelayMs: 0,
        },
      },
      () => {
        throw new Error('sh: код 1');
      },
    );
    await expect(steps.verify(NAME, out)).rejects.toThrow('/data не смонтирован на запись');
    expect(calls[0]!.args[1]).toBe('mountpoint -q /data && [ -w /data ]');
  });
});

describe('preBackup, restoreStorage, restoreDb', () => {
  it('preBackup: backup.sh с BACKUP_NAME=pre-restore-<время>; остаются 3 последних pre-restore', async () => {
    for (const d of [1, 2, 3]) await mkdir(join(root, `pre-restore-2026-10-0${d}T00-00-00Z`));
    await mkdir(join(root, NAME));
    const { steps, calls } = make({}, async (c) => {
      await mkdir(join(root, c.env.BACKUP_NAME!));
    });
    expect(await steps.preBackup(NAME, out)).toBe('pre-restore-2026-10-08T10-00-00Z');
    expect(calls[0]).toMatchObject({ cmd: '/backup/backup.sh', args: [] });
    expect(calls[0]!.env.BACKUP_NAME).toBe('pre-restore-2026-10-08T10-00-00Z');
    expect((await readdir(root)).sort()).toEqual(
      [
        NAME,
        'pre-restore-2026-10-02T00-00-00Z',
        'pre-restore-2026-10-03T00-00-00Z',
        'pre-restore-2026-10-08T10-00-00Z',
      ].sort(),
    );
  });

  it('preBackup из самого старого pre-restore: ротация не удаляет восстанавливаемый бэкап', async () => {
    const pre = (d: number) => `pre-restore-2026-10-0${d}T00-00-00Z`;
    for (const d of [1, 2, 3]) await mkdir(join(root, pre(d)));
    const { steps } = make({}, async (c) => {
      await mkdir(join(root, c.env.BACKUP_NAME!));
    });
    expect(await steps.preBackup(pre(1), out)).toBe('pre-restore-2026-10-08T10-00-00Z');
    expect((await readdir(root)).sort()).toEqual(
      [pre(1), pre(2), pre(3), 'pre-restore-2026-10-08T10-00-00Z'].sort(),
    );
  });

  it('restoreStorage: entrypoint.sh restore-storage с RESTORE_DIR каталога бэкапа', async () => {
    const { steps, calls } = make();
    await steps.restoreStorage(NAME, out);
    expect(calls[0]).toMatchObject({ cmd: '/backup/entrypoint.sh', args: ['restore-storage'] });
    expect(calls[0]!.env.RESTORE_DIR).toBe(join(root, NAME));
  });

  it('restoreDb: pg_restore в SQL-файл, затем одна транзакция psql -1 с удалением схем; временные файлы удаляются', async () => {
    let pre = '';
    const paths: string[] = [];
    const { steps, calls } = make({}, async (c) => {
      if (c.cmd === 'psql') {
        pre = await readFile(c.args[5]!, 'utf8');
        paths.push(c.args[5]!, c.args[7]!);
      }
    });
    await steps.restoreDb(NAME, out);
    expect(calls.map((c) => c.cmd)).toEqual(['pg_restore', 'psql']);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['--no-owner', '-f']);
    expect(calls[0]!.args[3]).toBe(join(root, NAME, 'db.dump'));
    expect(calls[1]!.args.slice(0, 5)).toEqual(['-1', '-v', 'ON_ERROR_STOP=1', '-q', '-f']);
    expect(calls[1]!.args[7]).toBe(calls[0]!.args[2]);
    expect(pre).toBe(
      'DROP SCHEMA IF EXISTS drizzle CASCADE;\nDROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n',
    );
    for (const p of paths) expect(existsSync(p)).toBe(false);
  });
});

describe('flushExcept', () => {
  /** Фейк SCAN с MATCH: шаблон вида «префикс*», как у Redis для cr:*. */
  function fakeRedis(all: string[]) {
    const keys = new Set(all);
    const snapshot = [...keys].sort();
    const calls: string[][] = [];
    return {
      keys,
      calls,
      async scan(cursor: string, ...args: string[]) {
        calls.push(args);
        const match = args[args.indexOf('MATCH') + 1];
        const start = Number(cursor);
        const page = snapshot.slice(start, start + 500);
        const next = start + 500 >= snapshot.length ? '0' : String(start + 500);
        const prefix = match?.endsWith('*') ? match.slice(0, -1) : undefined;
        return [next, prefix === undefined ? page : page.filter((k) => k.startsWith(prefix))] as [
          string,
          string[],
        ];
      },
      async unlink(...victims: string[]) {
        for (const v of victims) keys.delete(v);
        return victims.length;
      },
    };
  }

  it('SCAN MATCH cr:* по страницам и UNLINK всего, кроме cr:maintenance', async () => {
    const fake = fakeRedis([
      MAINTENANCE_KEY,
      ...Array.from({ length: 1200 }, (_, i) => `cr:k${i}`),
    ]);
    expect(await flushExcept(fake as unknown as Redis, MAINTENANCE_KEY)).toBe(1200);
    expect([...fake.keys]).toEqual([MAINTENANCE_KEY]);
    expect(fake.calls.every((a) => a.join(' ') === 'MATCH cr:* COUNT 500')).toBe(true);
  });

  it('общий внешний Redis: чужие ключи не трогаются', async () => {
    const fake = fakeRedis([MAINTENANCE_KEY, 'cr:rl:1', 'session:abc', 'other-app:cache', 'crx:1']);
    expect(await flushExcept(fake as unknown as Redis, MAINTENANCE_KEY)).toBe(1);
    expect([...fake.keys].sort()).toEqual(
      ['crx:1', MAINTENANCE_KEY, 'other-app:cache', 'session:abc'].sort(),
    );
  });
});

describe('withStartupLock', () => {
  function fakePool(failUnlock = false) {
    const log: string[] = [];
    const client = {
      async query(sql: string, params?: unknown[]) {
        log.push(`${sql.includes('unlock') ? 'unlock' : 'lock'}:${String(params?.[0])}`);
        if (failUnlock && sql.includes('unlock')) throw new Error('обрыв');
        return { rows: [] };
      },
      release(destroy?: boolean) {
        log.push(`release:${String(destroy ?? false)}`);
      },
    };
    return { log, pool: { connect: async () => client } as unknown as pg.Pool };
  }

  it('ключ 726100003 берётся и снимается на одном соединении вокруг fn', async () => {
    const { log, pool } = fakePool();
    const r = await withStartupLock(pool, async () => {
      log.push('fn');
      return 7;
    });
    expect(r).toBe(7);
    expect(log).toEqual(['lock:726100003', 'fn', 'unlock:726100003', 'release:false']);
  });

  it('при ошибке fn блокировка снимается, ошибка пробрасывается', async () => {
    const { log, pool } = fakePool();
    await expect(
      withStartupLock(pool, async () => {
        throw new Error('сбой миграции');
      }),
    ).rejects.toThrow('сбой миграции');
    expect(log).toEqual(['lock:726100003', 'unlock:726100003', 'release:false']);
  });

  it('не удалось снять — соединение уничтожается', async () => {
    const { log, pool } = fakePool(true);
    await withStartupLock(pool, async () => undefined);
    expect(log.at(-1)).toBe('release:true');
  });
});
