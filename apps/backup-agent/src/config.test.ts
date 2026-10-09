import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig, pgConnection } from './config';

const base = { BACKUP_AGENT_TOKEN: 't'.repeat(32), REDIS_URL: 'redis://:pw@redis:6379' };

describe('loadAgentConfig', () => {
  it('значения по умолчанию', () => {
    expect(loadAgentConfig(base)).toEqual({
      token: 't'.repeat(32),
      port: 8080,
      redisUrl: 'redis://:pw@redis:6379',
      storageBackend: 'local',
      cron: '0 3 * * *',
      tz: 'UTC',
      backupsDir: '/backups',
      scriptsDir: '/backup',
      migrationsDir: '/agent/drizzle',
      terminateDelayMs: 3000,
      reassertMs: 5000,
      host: '0.0.0.0',
    });
  });

  it('BACKUP_AGENT_HOST задаёт адрес прослушивания', () => {
    expect(loadAgentConfig({ ...base, BACKUP_AGENT_HOST: 'backup-agent' }).host).toBe(
      'backup-agent',
    );
  });

  it('без токена агент не стартует', () => {
    expect(() => loadAgentConfig({ REDIS_URL: base.REDIS_URL })).toThrow(
      'Неверная конфигурация агента: BACKUP_AGENT_TOKEN: обязателен',
    );
  });

  it('токен короче 32 символов — ошибка; значение токена не попадает в ошибку', () => {
    const short = 'Zq9-secret-value-0123456789abcd'; // 31 символ
    expect(short).toHaveLength(31);
    let message = '';
    try {
      loadAgentConfig({ ...base, BACKUP_AGENT_TOKEN: short });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('Неверная конфигурация агента: BACKUP_AGENT_TOKEN: минимум 32 символа');
  });

  it('REDIS_URL обязателен', () => {
    expect(() => loadAgentConfig({ BACKUP_AGENT_TOKEN: base.BACKUP_AGENT_TOKEN })).toThrow(
      'REDIS_URL: обязателен',
    );
  });

  it('BACKUP_CRON не из 5 полей — прежнее сообщение', () => {
    expect(() => loadAgentConfig({ ...base, BACKUP_CRON: '0 3 * *' })).toThrow(
      /^BACKUP_CRON: ожидается 5 полей cron$/,
    );
  });

  it('BACKUP_CRON, TZ, STORAGE_BACKEND и пути из окружения', () => {
    expect(
      loadAgentConfig({
        ...base,
        BACKUP_CRON: '30  2 * * 1-5',
        TZ: 'Europe/Moscow',
        STORAGE_BACKEND: 's3',
        BACKUPS_DIR: '/tmp/b',
        BACKUP_SCRIPTS_DIR: '/it-scripts',
        BACKUP_AGENT_TERMINATE_DELAY_MS: '500',
      }),
    ).toMatchObject({
      cron: '30 2 * * 1-5',
      tz: 'Europe/Moscow',
      storageBackend: 's3',
      backupsDir: '/tmp/b',
      scriptsDir: '/it-scripts',
      terminateDelayMs: 500,
    });
  });

  it('неверный STORAGE_BACKEND', () => {
    expect(() => loadAgentConfig({ ...base, STORAGE_BACKEND: 'ftp' })).toThrow(
      'STORAGE_BACKEND: ожидается local или s3',
    );
  });
});

describe('pgConnection', () => {
  it('значения по умолчанию — как в backup.sh', () => {
    expect(pgConnection({ PGPASSWORD: 'x' })).toEqual({
      host: 'postgres',
      port: 5432,
      user: 'app',
      database: 'app',
      password: 'x',
      ssl: false,
    });
  });
  it('PGHOST, PGPORT, PGUSER, PGDATABASE из окружения', () => {
    expect(
      pgConnection({ PGHOST: 'db', PGPORT: '6543', PGUSER: 'u', PGDATABASE: 'd' }),
    ).toMatchObject({ host: 'db', port: 6543, user: 'u', database: 'd' });
  });
});

describe('pgConnection: SSL (PGSSLMODE, PGSSLROOTCERT)', () => {
  it('disable или не задан — без SSL', () => {
    expect(pgConnection({}).ssl).toBe(false);
    expect(pgConnection({ PGSSLMODE: 'disable' }).ssl).toBe(false);
  });
  it('require — шифрование без проверки сертификата (как libpq)', () => {
    expect(pgConnection({ PGSSLMODE: 'require' }).ssl).toEqual({ rejectUnauthorized: false });
  });
  it('verify-full — проверка цепочки и имени; CA из PGSSLROOTCERT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pgca-'));
    await writeFile(join(dir, 'ca.crt'), 'CA-PEM');
    expect(
      pgConnection({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: join(dir, 'ca.crt') }).ssl,
    ).toEqual({
      rejectUnauthorized: true,
      ca: 'CA-PEM',
    });
    expect(pgConnection({ PGSSLMODE: 'verify-full' }).ssl).toEqual({ rejectUnauthorized: true });
    await rm(dir, { recursive: true });
  });
  it('verify-ca — проверка цепочки без имени хоста (как libpq)', () => {
    const ssl = pgConnection({ PGSSLMODE: 'verify-ca' }).ssl as {
      rejectUnauthorized: boolean;
      checkServerIdentity: () => undefined;
    };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity()).toBeUndefined();
  });
  it('неподдерживаемый режим — ошибка с перечнем', () => {
    expect(() => pgConnection({ PGSSLMODE: 'prefer' })).toThrow(
      'PGSSLMODE: поддерживаются disable, require, verify-ca, verify-full',
    );
  });
  it('нет файла PGSSLROOTCERT — ошибка с путём', () => {
    expect(() => pgConnection({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/нет/ca.crt' })).toThrow(
      'PGSSLROOTCERT: не удалось прочитать /нет/ca.crt',
    );
  });
});

describe('loadAgentConfig: REDIS_PASSWORD', () => {
  it('вставляется в REDIS_URL с кодированием', () => {
    expect(
      loadAgentConfig({ ...base, REDIS_URL: 'redis://redis:6379', REDIS_PASSWORD: 'r@d/s#' })
        .redisUrl,
    ).toBe('redis://:r%40d%2Fs%23@redis:6379');
  });
});
