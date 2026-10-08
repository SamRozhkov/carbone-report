import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost/app',
  APP_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  ONLYOFFICE_JWT_SECRET: 'o'.repeat(32),
};

describe('loadConfig', () => {
  it('применяет значения по умолчанию', () => {
    const c = loadConfig(base);
    expect(c.queryTimeoutMs).toBe(30000);
    expect(c.queryMaxRows).toBe(100000);
    expect(c.renderTimeoutMs).toBe(120000);
    expect(c.reportTimeoutMs).toBe(120000);
    expect(c.reportRetentionDays).toBe(30);
    expect(c.tz).toBe('Europe/Moscow');
    expect(c.carboneUrl).toBe('http://carbone:4000');
    expect(c.encryptionKey.length).toBe(32);
    expect(c.cookieSecure).toBe(false);
    expect(c.redisUrl).toBe('redis://redis:6379');
  });
  it('берёт REDIS_URL из окружения', () => {
    expect(loadConfig({ ...base, REDIS_URL: 'redis://localhost:6380' }).redisUrl).toBe(
      'redis://localhost:6380',
    );
  });
  it('приводит числа из строк', () => {
    expect(loadConfig({ ...base, QUERY_MAX_ROWS: '10' }).queryMaxRows).toBe(10);
    expect(loadConfig({ ...base, REPORT_TIMEOUT_MS: '5000' }).reportTimeoutMs).toBe(5000);
  });
  it('падает с понятной ошибкой на коротком ENCRYPTION_KEY', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'abc' })).toThrow(/ENCRYPTION_KEY/);
  });
  it('требует ADMIN_PASSWORD не короче 8 символов', () => {
    expect(() => loadConfig({ ...base, ADMIN_PASSWORD: 'short' })).toThrow(/ADMIN_PASSWORD/);
    expect(loadConfig({ ...base, ADMIN_PASSWORD: 'longenough' }).adminPassword).toBe('longenough');
    expect(() => loadConfig({ ...base, ADMIN_PASSWORD: '' })).not.toThrow();
  });
  it('падает, если нет DATABASE_URL', () => {
    const { DATABASE_URL: _, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });
  it('хранилище по умолчанию — local, без настроек S3', () => {
    const c = loadConfig(base);
    expect(c.storageBackend).toBe('local');
    expect(c.storageDir).toBe('/data');
    expect(c.s3).toBeNull();
  });
  it('s3 без обязательных значений — понятная ошибка', () => {
    expect(() => loadConfig({ ...base, STORAGE_BACKEND: 's3' })).toThrow(
      'Неверная конфигурация: S3_BUCKET: обязателен при STORAGE_BACKEND=s3; S3_ACCESS_KEY_ID: обязателен при STORAGE_BACKEND=s3; S3_SECRET_ACCESS_KEY: обязателен при STORAGE_BACKEND=s3',
    );
  });
  it('пустые строки из .env — не заданы; секрет не попадает в ошибку', () => {
    let message = '';
    try {
      loadConfig({
        ...base,
        STORAGE_BACKEND: 's3',
        S3_BUCKET: '',
        S3_ACCESS_KEY_ID: 'key-id',
        S3_SECRET_ACCESS_KEY: 'very-secret-value',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('Неверная конфигурация: S3_BUCKET: обязателен при STORAGE_BACKEND=s3');
    expect(message).not.toContain('very-secret-value');
  });
  it('s3: значения по умолчанию и разбор флагов', () => {
    const env = {
      ...base,
      STORAGE_BACKEND: 's3',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    };
    expect(loadConfig(env).s3).toEqual({
      endpoint: undefined,
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: false,
      createBucket: false,
    });
    expect(
      loadConfig({
        ...env,
        S3_ENDPOINT: 'http://s3:8333',
        S3_REGION: 'ru-central1',
        S3_FORCE_PATH_STYLE: 'true',
        S3_CREATE_BUCKET: 'true',
      }).s3,
    ).toEqual({
      endpoint: 'http://s3:8333',
      region: 'ru-central1',
      bucket: 'b',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
      createBucket: true,
    });
    expect(loadConfig({ ...env, S3_ENDPOINT: '', S3_REGION: '' }).s3).toMatchObject({
      endpoint: undefined,
      region: 'us-east-1',
    });
  });
  it('неверные STORAGE_BACKEND и S3_ENDPOINT', () => {
    expect(() => loadConfig({ ...base, STORAGE_BACKEND: 'disk' })).toThrow(
      'STORAGE_BACKEND: ожидается local или s3',
    );
    expect(() =>
      loadConfig({
        ...base,
        STORAGE_BACKEND: 's3',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 's',
        S3_ENDPOINT: 's3:8333',
      }),
    ).toThrow('S3_ENDPOINT: нужен URL, например http://s3:8333');
  });

  it('LDAP выключен по умолчанию', () => {
    expect(loadConfig(base).ldap).toBeNull();
  });
  it('LDAP_ENABLED=true без LDAP_URL и LDAP_BASE_DN — понятная ошибка с именами переменных', () => {
    expect(() => loadConfig({ ...base, LDAP_ENABLED: 'true' })).toThrow(
      'Неверная конфигурация: LDAP_URL: задайте при LDAP_ENABLED=true; LDAP_BASE_DN: задайте при LDAP_ENABLED=true',
    );
  });
  it('LDAP_USER_FILTER без %s отклоняется', () => {
    expect(() =>
      loadConfig({
        ...base,
        LDAP_ENABLED: 'true',
        LDAP_URL: 'ldap://dc:389',
        LDAP_BASE_DN: 'dc=example,dc=local',
        LDAP_USER_FILTER: '(uid=fry)',
      }),
    ).toThrow('LDAP_USER_FILTER: должен содержать %s');
  });
  it('собирает настройки LDAP; пустой LDAP_BIND_DN из .env — анонимный поиск', () => {
    const c = loadConfig({
      ...base,
      LDAP_ENABLED: 'true',
      LDAP_URL: 'ldaps://dc:636',
      LDAP_BIND_DN: '',
      LDAP_BIND_PASSWORD: '',
      LDAP_BASE_DN: 'dc=example,dc=local',
      LDAP_USER_FILTER: '(sAMAccountName=%s)',
      LDAP_DEFAULT_ROLE: 'admin',
      LDAP_TLS_REJECT_UNAUTHORIZED: 'false',
    });
    expect(c.ldap).toEqual({
      url: 'ldaps://dc:636',
      bindDn: undefined,
      bindPassword: undefined,
      baseDn: 'dc=example,dc=local',
      userFilter: '(sAMAccountName=%s)',
      defaultRole: 'admin',
      tlsRejectUnauthorized: false,
    });
  });
  it('LDAP_URL — только ldap:// или ldaps://', () => {
    expect(() =>
      loadConfig({
        ...base,
        LDAP_ENABLED: 'true',
        LDAP_URL: 'dc.example.local',
        LDAP_BASE_DN: 'dc=example,dc=local',
      }),
    ).toThrow('LDAP_URL: нужен URL вида ldap://host:389 или ldaps://host:636');
  });
});

describe('loadConfig: агент бэкапа', () => {
  const token = 'b'.repeat(32);
  it('без BACKUP_AGENT_URL функция выключена (токен без адреса не мешает)', () => {
    expect(loadConfig(base).backupAgent).toBeNull();
    expect(
      loadConfig({ ...base, BACKUP_AGENT_URL: '', BACKUP_AGENT_TOKEN: token }).backupAgent,
    ).toBeNull();
  });
  it('адрес и токен; завершающий / убирается', () => {
    expect(
      loadConfig({
        ...base,
        BACKUP_AGENT_URL: 'http://backup-agent:8080/',
        BACKUP_AGENT_TOKEN: token,
      }).backupAgent,
    ).toEqual({ url: 'http://backup-agent:8080', token });
  });
  it('адрес без токена или короткий токен — ошибка; значение токена в сообщение не попадает', () => {
    expect(() => loadConfig({ ...base, BACKUP_AGENT_URL: 'http://backup-agent:8080' })).toThrow(
      'BACKUP_AGENT_TOKEN: обязателен при BACKUP_AGENT_URL',
    );
    let message = '';
    try {
      loadConfig({
        ...base,
        BACKUP_AGENT_URL: 'http://backup-agent:8080',
        BACKUP_AGENT_TOKEN: 'short-secret-token',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('BACKUP_AGENT_TOKEN: минимум 32 символа');
    expect(message).not.toContain('short-secret-token');
  });
  it('адрес — только http(s)-URL', () => {
    expect(() =>
      loadConfig({ ...base, BACKUP_AGENT_URL: 'backup:8080', BACKUP_AGENT_TOKEN: token }),
    ).toThrow('BACKUP_AGENT_URL: нужен URL, например http://backup-agent:8080');
  });
});
