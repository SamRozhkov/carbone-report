import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import pg from 'pg';
import { Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bundledMigrationHashes, FUTURE_BACKUP } from '../src/migrations';
import {
  createAppDatabase,
  hostPool,
  hostRedis,
  migrateTo,
  MIGRATIONS,
  pgUrl,
  rclone,
  startAgent,
  type StartedAgent,
} from './helpers';

const KNOWN = bundledMigrationHashes(MIGRATIONS);
const codesIn = (logs: string) =>
  [...logs.matchAll(/КОД ВОССТАНОВЛЕНИЯ: ([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})/g)].map(
    (m) => m[1]!,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bucketName = () => `cr-${randomUUID()}`;

/** Ждёт, пока команда в контейнере агента не завершится с кодом 0. */
async function untilSh(agent: StartedAgent, script: string, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ((await agent.sh(script)).exitCode !== 0) {
    if (Date.now() > until) throw new Error(`не дождались: ${script}`);
    await sleep(200);
  }
}

/** Скрипты-обёртки: фаза storage падает, пока есть /backups/.fail-storage. */
const FAILING_SCRIPTS = [
  { target: '/it-scripts/backup.sh', content: '#!/bin/sh\nexec /backup/backup.sh "$@"\n' },
  { target: '/it-scripts/lib.sh', content: '. /backup/lib.sh\n', mode: 0o644 },
  {
    target: '/it-scripts/entrypoint.sh',
    content:
      '#!/bin/sh\nif [ "${1:-}" = restore-storage ] && [ -f /backups/.fail-storage ]; then\n  echo "сбой восстановления хранилища (тест)" >&2\n  exit 1\nfi\nexec /backup/entrypoint.sh "$@"\n',
  },
];

/**
 * Скрипты-обёртки: бэкап агента ждёт /backups/.it-release — замок агента гарантированно занят,
 * пока тест его не отпустит.
 */
const BLOCKING_SCRIPTS = [
  {
    target: '/it-scripts/backup.sh',
    content:
      '#!/bin/sh\nuntil [ -f /backups/.it-release ]; do sleep 0.2; done\nexec /backup/backup.sh "$@"\n',
  },
  { target: '/it-scripts/lib.sh', content: '. /backup/lib.sh\n', mode: 0o644 },
  { target: '/it-scripts/entrypoint.sh', content: '#!/bin/sh\nexec /backup/entrypoint.sh "$@"\n' },
];

let redis: Redis;
beforeAll(() => {
  redis = hostRedis();
});
afterAll(async () => {
  await redis.quit();
});

async function categories(pool: pg.Pool): Promise<string[]> {
  return (await pool.query<{ name: string }>('select name from categories order by name')).rows.map(
    (r) => r.name,
  );
}

async function list(agent: StartedAgent) {
  return (
    await agent.call<
      { name: string; kind: string; status: string; lastMigration: string | null }[]
    >('GET', '/backups')
  ).body;
}

async function backupNow(agent: StartedAgent): Promise<string> {
  const before = new Set((await list(agent)).map((b) => b.name));
  const r = await agent.call<{ operationId: string }>('POST', '/backups', { requestedBy: 'it' });
  expect(r.status).toBe(202);
  const op = await agent.waitIdle();
  // Журнал операции (секреты вырезаны агентом) — в сообщении при сбое.
  expect(op, op.log.join('\n')).toMatchObject({
    id: r.body.operationId,
    type: 'backup',
    status: 'succeeded',
  });
  const created = (await list(agent)).find((b) => !before.has(b.name) && b.kind === 'regular');
  expect(created).toBeDefined();
  return created!.name;
}

// Тесты файла выполняются по порядку (concurrent не задан): общий Redis и флаг cr:maintenance.
describe('агент бэкапа в образе', () => {
  let agent: StartedAgent;
  let db: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createAppDatabase();
    pool = hostPool(db);
    // Слушает 0.0.0.0: тесты ходят к агенту через проброшенный порт. Привязка к псевдониму — ниже.
    agent = await startAgent({ db, bucket: bucketName() });
  });
  afterAll(async () => {
    await pool.end();
    await agent.stop();
  });

  it('образ: Node ≥ 22 с часовыми поясами, rclone, flock, mountpoint, скрипты и миграции', async () => {
    const r = await agent.sh(
      `node -e "if (+process.versions.node.split('.')[0] < 22) process.exit(1); new Intl.DateTimeFormat('ru', { timeZone: 'Europe/Moscow' }).format(0)" && command -v rclone flock mountpoint pg_restore psql && ls /backup/entrypoint.sh /backup/backup.sh /backup/archive-storage.sh /backup/lib.sh /agent/drizzle/meta/_journal.json`,
    );
    expect(r.exitCode, r.output).toBe(0);
  });

  it('BACKUP_AGENT_HOST=backup-agent: агент отвечает по псевдониму (healthcheck compose), но не на 127.0.0.1', async () => {
    // Как в compose: агент слушает только адрес псевдонима backup-agent (§26.1); готовность — изнутри сети.
    const aliased = await startAgent({
      db,
      bucket: bucketName(),
      aliases: ['backup-agent'],
      env: { BACKUP_AGENT_HOST: 'backup-agent' },
      wait: Wait.forSuccessfulCommand('wget -q -O /dev/null http://backup-agent:8080/health'),
    });
    try {
      const listening = await aliased.sh('netstat -tln');
      expect(listening.output).toMatch(/\d+\.\d+\.\d+\.\d+:8080\s/);
      expect(listening.output).not.toMatch(/(0\.0\.0\.0|:::):8080\s/);
      expect(
        (await aliased.sh('wget -q -T 3 -O /dev/null http://127.0.0.1:8080/health')).exitCode,
      ).not.toBe(0);
    } finally {
      await aliased.stop();
    }
  });

  it('/health без токена; остальное — только с верным токеном', async () => {
    expect((await agent.call('GET', '/health', undefined, '')).status).toBe(200);
    expect((await agent.call('GET', '/backups', undefined, 'x'.repeat(64))).status).toBe(401);
  });

  it('неверный BACKUP_CRON, короткий токен, режим cron — выход с кодом 2 и понятным сообщением', async () => {
    const cron = await agent.sh(
      'BACKUP_CRON="0 3 * *" BACKUP_AGENT_PORT=8099 node /agent/dist/main.js; echo "rc=$?"',
    );
    expect(cron.output).toContain('BACKUP_CRON: ожидается 5 полей cron');
    expect(cron.output).toContain('rc=2');
    const tok = await agent.sh(
      'BACKUP_AGENT_TOKEN=short-token node /agent/dist/main.js; echo "rc=$?"',
    );
    expect(tok.output).toContain('BACKUP_AGENT_TOKEN: минимум 32 символа');
    expect(tok.output).not.toContain('short-token');
    expect(tok.output).toContain('rc=2');
    const mode = await agent.sh('/backup/entrypoint.sh cron; echo "rc=$?"');
    expect(mode.output).toContain('режимы: agent | now | restore-storage');
    expect(mode.output).toContain('rc=2');
  });

  it('S3 без ключей: rclone берёт учётные данные из окружения (env_auth); один ключ — код 2', async () => {
    const none = await agent.sh(
      '. /backup/lib.sh && export S3_ACCESS_KEY_ID= S3_SECRET_ACCESS_KEY= && check_storage_backend && s3_env && echo "auth=$RCLONE_CONFIG_S3_ENV_AUTH key=[${RCLONE_CONFIG_S3_ACCESS_KEY_ID:-}]"',
    );
    expect(none.output).toContain('auth=true key=[]');
    const keys = await agent.sh(
      '. /backup/lib.sh && check_storage_backend && s3_env && echo "auth=$RCLONE_CONFIG_S3_ENV_AUTH"',
    );
    expect(keys.output).toContain('auth=false');
    const one = await agent.sh(
      '(. /backup/lib.sh && export S3_SECRET_ACCESS_KEY= && check_storage_backend); echo "rc=$?"',
    );
    expect(one.output).toContain(
      'S3_ACCESS_KEY_ID и S3_SECRET_ACCESS_KEY задаются вместе (или ни один — учётные данные из окружения, IRSA)',
    );
    expect(one.output).toContain('rc=2');
  });

  it('бэкап и список: succeeded, в списке ok с последней миграцией; каталог .partial — partial', async () => {
    const name = await backupNow(agent);
    await agent.sh('mkdir -p /backups/2026-01-01T00-00-00Z.partial');
    const all = await list(agent);
    expect(all.find((b) => b.name === name)).toMatchObject({
      kind: 'regular',
      status: 'ok',
      lastMigration: KNOWN.at(-1),
    });
    expect(all.find((b) => b.name === '2026-01-01T00-00-00Z.partial')).toMatchObject({
      status: 'partial',
    });
  });

  it('409 при параллельной операции: второй запрос и ручной now (код 75); замок у постороннего процесса', async () => {
    const lockDb = await createAppDatabase();
    const a = await startAgent({
      db: lockDb,
      bucket: bucketName(),
      env: { BACKUP_SCRIPTS_DIR: '/it-scripts' },
      files: BLOCKING_SCRIPTS,
    });
    try {
      // Бэкап агента держит замок, пока нет /backups/.it-release.
      const first = await a.call<{ operationId: string }>('POST', '/backups', {});
      expect(first.status).toBe(202);
      const second = await a.call<{ busy: { type: string; startedAt: string | null } }>(
        'POST',
        '/backups',
        {},
      );
      expect(second.status).toBe(409);
      expect(second.body.busy).toEqual({ type: 'backup', startedAt: expect.any(String) });
      const now = await a.sh('/backup/entrypoint.sh now');
      expect(now.exitCode).toBe(75);
      expect(now.output).toContain('идёт другая операция с бэкапами (агент) — повторите позже');
      await a.sh('touch /backups/.it-release');
      expect(await a.waitIdle()).toMatchObject({
        id: first.body.operationId,
        type: 'backup',
        status: 'succeeded',
      });
      expect((await list(a)).filter((b) => b.kind === 'regular' && b.status === 'ok')).toHaveLength(
        1,
      );

      // Замок держит посторонний процесс (ручной now): агент отвечает 409 без startedAt.
      await a.sh(
        '(exec 9>>/backups/.op.lock; flock -n 9 && touch /backups/.it-held && until [ -f /backups/.it-free ]; do sleep 0.2; done) >/dev/null 2>&1 &',
      );
      await untilSh(a, 'test -f /backups/.it-held');
      const third = await a.call<{ busy: unknown }>('POST', '/backups', {});
      expect(third.status).toBe(409);
      expect(third.body.busy).toEqual({ type: 'backup', startedAt: null });
      await a.sh('touch /backups/.it-free');
      await untilSh(a, 'flock -n /backups/.op.lock true');
      expect((await a.call('POST', '/backups', {})).status).toBe(202);
      expect(await a.waitIdle()).toMatchObject({ type: 'backup', status: 'succeeded' });
    } finally {
      await a.stop();
    }
  });

  it('восстановление: база, файлы и Redis из бэкапа, сессии api завершены, pre-restore — последние 3, флаг снят', async () => {
    await pool.query("insert into categories (name) values ('до бэкапа')");
    await rclone(agent, 'printf v1 | rclone rcat "s3:$S3_BUCKET/templates/a.txt"');
    await sleep(1_100); // имя бэкапа — с точностью до секунды
    const name = await backupNow(agent);

    await pool.query("delete from categories where name = 'до бэкапа'");
    await pool.query("insert into categories (name) values ('после бэкапа')");
    await rclone(
      agent,
      'printf v2 | rclone rcat "s3:$S3_BUCKET/templates/a.txt" && printf x | rclone rcat "s3:$S3_BUCKET/stray.txt"',
    );
    await redis.set('cr:test:x', '{}');
    await redis.set('foreign:key', '1');
    const old = [1, 2, 3, 4].map((d) => `pre-restore-2020-01-0${d}T00-00-00Z`);
    await agent.sh(`mkdir -p ${old.map((n) => `/backups/${n}`).join(' ')}`);
    const api = new pg.Client({ connectionString: pgUrl(db), application_name: 'api' });
    api.on('error', () => {});
    await api.connect();

    const r = await agent.call('POST', `/backups/${name}/restore`, { requestedBy: 'admin' });
    expect(r.status).toBe(202);
    const op = await agent.waitIdle();
    expect(op).toMatchObject({
      type: 'restore',
      requestedBy: 'admin',
      backup: name,
      status: 'succeeded',
      phase: 'done',
      recovery: null,
    });
    const log = op.log.join('\n');
    expect(log).toContain('завершено сессий API: 1');
    expect(log).not.toContain(inject('s3').secretAccessKey);
    expect(log).not.toContain(inject('redis').password);

    expect(await categories(pool)).toContain('до бэкапа');
    expect(await categories(pool)).not.toContain('после бэкапа');
    expect((await rclone(agent, 'rclone cat "s3:$S3_BUCKET/templates/a.txt"')).output.trim()).toBe(
      'v1',
    );
    expect(
      (await rclone(agent, 'rclone lsf -R --files-only "s3:$S3_BUCKET"')).output,
    ).not.toContain('stray.txt');
    expect(await redis.exists('cr:test:x')).toBe(0);
    // Redis может быть общим с другими сервисами (§27.5): чужой ключ переживает восстановление.
    expect(await redis.exists('foreign:key')).toBe(1);
    await redis.del('foreign:key');
    expect(await redis.exists('cr:maintenance')).toBe(0);
    await expect(api.query('select 1')).rejects.toThrow();
    await api.end().catch(() => {});

    // Новый pre-restore и два самых новых из старых; …01 и …02 удалены ротацией.
    const pre = (await list(agent)).filter((b) => b.kind === 'pre-restore').map((b) => b.name);
    expect(pre).toHaveLength(3);
    const fresh = pre.filter((n) => !old.includes(n));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatch(/^pre-restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
    expect(pre).toContain(old[2]);
    expect(pre).toContain(old[3]);
    expect(pre).not.toContain(old[0]);
    expect(pre).not.toContain(old[1]);

    // BACKUP_KEEP действует только на обычные бэкапы.
    await sleep(1_100);
    const keep = await agent.sh('BACKUP_KEEP=1 /backup/backup.sh');
    expect(keep.exitCode, keep.output).toBe(0);
    const after = await list(agent);
    expect(after.filter((b) => b.kind === 'regular' && b.status === 'ok')).toHaveLength(1);
    expect(after.filter((b) => b.kind === 'pre-restore')).toHaveLength(3);
  });

  it('бэкап «из будущего» — отказ на verify; база, pre-restore и флаг не тронуты', async () => {
    await sleep(1_100);
    const name = await backupNow(agent);
    const future = '2099-01-01T00-00-00Z';
    const cp = await agent.sh(
      `cp -r /backups/${name} /backups/${future} && sed -i 's/^last_migration=.*/last_migration=${'f'.repeat(64)}/' /backups/${future}/manifest.txt`,
    );
    expect(cp.exitCode, cp.output).toBe(0);
    const pre = (await list(agent)).filter((b) => b.kind === 'pre-restore').length;
    const cats = await categories(pool);
    expect((await agent.call('POST', `/backups/${future}/restore`, {})).status).toBe(202);
    const op = await agent.waitIdle();
    expect(op).toMatchObject({
      status: 'failed',
      phase: 'verify',
      error: FUTURE_BACKUP,
      recovery: null,
    });
    expect(await categories(pool)).toEqual(cats);
    expect((await list(agent)).filter((b) => b.kind === 'pre-restore').length).toBe(pre);
    expect(await redis.exists('cr:maintenance')).toBe(0);
  });

  it('бэкап старой схемы восстанавливается и доводится миграциями до текущей', async () => {
    const oldDb = await createAppDatabase(KNOWN.length - 1);
    const oldPool = hostPool(oldDb);
    const old = await startAgent({ db: oldDb, bucket: bucketName() });
    try {
      await oldPool.query("insert into categories (name) values ('старая версия')");
      const name = await backupNow(old);
      expect((await list(old)).find((b) => b.name === name)?.lastMigration).toBe(KNOWN.at(-2));
      await migrateTo(oldDb, 'all'); // обновление приложения
      await oldPool.query("insert into categories (name) values ('после обновления')");
      expect((await old.call('POST', `/backups/${name}/restore`, {})).status).toBe(202);
      expect(await old.waitIdle()).toMatchObject({ status: 'succeeded' });
      const n = await oldPool.query<{ n: number }>(
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      expect(n.rows[0]!.n).toBe(KNOWN.length);
      expect(await categories(oldPool)).toEqual(['старая версия']);
    } finally {
      await oldPool.end();
      await old.stop();
    }
  });

  it('восстановление из самого старого pre-restore: источник не удаляется ротацией, бэкап pre-restore не ротирует обычные', async () => {
    const preDb = await createAppDatabase();
    const prePool = hostPool(preDb);
    // BACKUP_KEEP=1: ротация обычных бэкапов после pre-restore удалила бы 2020-02-01.
    const a = await startAgent({ db: preDb, bucket: bucketName(), env: { BACKUP_KEEP: '1' } });
    try {
      await prePool.query("insert into categories (name) values ('в pre-restore')");
      const source = 'pre-restore-2020-01-01T00-00-00Z';
      const made = await a.sh(`BACKUP_NAME=${source} /backup/backup.sh`);
      expect(made.exitCode, made.output).toBe(0);
      const regular = ['2020-02-01T00-00-00Z', '2020-02-02T00-00-00Z'];
      const others = ['pre-restore-2020-01-02T00-00-00Z', 'pre-restore-2020-01-03T00-00-00Z'];
      const mk = await a.sh(
        `mkdir -p ${[...regular, ...others].map((n) => `/backups/${n}`).join(' ')}`,
      );
      expect(mk.exitCode, mk.output).toBe(0);
      await prePool.query("insert into categories (name) values ('после pre-restore')");

      // Источник — самый старый из трёх pre-restore: новый pre-restore стал бы четвёртым.
      expect((await a.call('POST', `/backups/${source}/restore`, {})).status).toBe(202);
      const op = await a.waitIdle();
      expect(op, op.log.join('\n')).toMatchObject({ status: 'succeeded', phase: 'done' });
      expect(await categories(prePool)).toEqual(['в pre-restore']);
      const names = (await list(a)).map((b) => b.name);
      expect(names).toContain(source);
      for (const n of [...regular, ...others]) expect(names).toContain(n);
      expect(names.filter((n) => n.startsWith('pre-restore-'))).toHaveLength(4);
      expect(op.log.join('\n')).not.toContain('удалён старый бэкап');
    } finally {
      await prePool.end();
      await a.stop();
    }
  });

  it('сбой на этапе storage: флаг остаётся и возвращается после удаления, код только в журнале контейнера, повтор по коду', async () => {
    const failDb = await createAppDatabase();
    const failPool = hostPool(failDb);
    const a = await startAgent({
      db: failDb,
      bucket: bucketName(),
      env: { BACKUP_SCRIPTS_DIR: '/it-scripts' },
      files: FAILING_SCRIPTS,
    });
    try {
      await failPool.query("insert into categories (name) values ('в бэкапе')");
      const name = await backupNow(a);
      await failPool.query("insert into categories (name) values ('после бэкапа')");
      await a.sh('touch /backups/.fail-storage');
      expect(
        (await a.call('POST', `/backups/${name}/restore`, { requestedBy: 'admin' })).status,
      ).toBe(202);
      let op = await a.waitIdle();
      expect(op).toMatchObject({
        status: 'failed',
        phase: 'storage',
        recovery: { backup: name, preRestore: expect.stringMatching(/^pre-restore-/) },
      });
      expect(JSON.parse((await redis.get('cr:maintenance'))!)).toMatchObject({
        phase: 'storage',
        backup: name,
      });

      const [code] = codesIn(a.logs());
      expect(code).toBeDefined();
      expect(op.log.join('\n')).not.toContain(code);
      expect((await a.sh('cat /backups/.op/state.json')).output).not.toContain(code!);

      // Redis перезапущен (ключа нет) — агент возвращает флаг не позже чем через 5 с.
      await redis.del('cr:maintenance');
      await sleep(6_000);
      expect(await redis.exists('cr:maintenance')).toBe(1);

      expect((await a.call('POST', '/backups', {})).status).toBe(409);
      expect(
        (await a.call('POST', '/recovery', { code: 'AAAA-AAAA-AAAA', target: 'same' })).status,
      ).toBe(403);

      // Причина не устранена: повтор снова падает, печатается новый код.
      expect((await a.call('POST', '/recovery', { code, target: 'same' })).status).toBe(202);
      op = await a.waitIdle();
      expect(op).toMatchObject({
        status: 'failed',
        phase: 'storage',
        requestedBy: 'recovery-code',
      });
      const codes = codesIn(a.logs());
      expect(codes).toHaveLength(2);

      await a.sh('rm /backups/.fail-storage');
      expect((await a.call('POST', '/recovery', { code: codes[1], target: 'same' })).status).toBe(
        202,
      );
      op = await a.waitIdle();
      expect(op).toMatchObject({ status: 'succeeded', recovery: null });
      expect(await redis.exists('cr:maintenance')).toBe(0);
      expect(await categories(failPool)).toEqual(['в бэкапе']);
      expect((await a.call('POST', '/recovery', { code: codes[1], target: 'same' })).status).toBe(
        409,
      );
    } finally {
      await failPool.end();
      await a.stop();
    }
  });
});
