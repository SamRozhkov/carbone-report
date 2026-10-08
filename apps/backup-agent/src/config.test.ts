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
    });
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
    });
  });
  it('PGHOST, PGPORT, PGUSER, PGDATABASE из окружения', () => {
    expect(
      pgConnection({ PGHOST: 'db', PGPORT: '6543', PGUSER: 'u', PGDATABASE: 'd' }),
    ).toMatchObject({ host: 'db', port: 6543, user: 'u', database: 'd' });
  });
});
