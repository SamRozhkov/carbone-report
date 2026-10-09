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
    expect(c.apiSelfUrl).toBe('http://api:3000');
    expect(c.renderWorkers).toBeGreaterThanOrEqual(1);
    expect(c.renderWorkers).toBeLessThanOrEqual(4);
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
  it('s3 без бакета — понятная ошибка; ключи не обязательны', () => {
    expect(() => loadConfig({ ...base, STORAGE_BACKEND: 's3' })).toThrow(
      'Неверная конфигурация: S3_BUCKET: обязателен при STORAGE_BACKEND=s3',
    );
    // Без ключей — учётные данные из окружения пода (IRSA, переменные AWS_*).
    expect(loadConfig({ ...base, STORAGE_BACKEND: 's3', S3_BUCKET: 'b' }).s3).toMatchObject({
      bucket: 'b',
      accessKeyId: undefined,
      secretAccessKey: undefined,
    });
  });
  it('s3: задан только один ключ — ошибка с именем второго, значения не попадают в текст', () => {
    const one = () =>
      loadConfig({
        ...base,
        STORAGE_BACKEND: 's3',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'key-id-123',
      });
    expect(one).toThrow(
      'S3_SECRET_ACCESS_KEY: задайте вместе с S3_ACCESS_KEY_ID или не задавайте ни один',
    );
    expect(one).not.toThrow(/key-id-123/);
    expect(() =>
      loadConfig({ ...base, STORAGE_BACKEND: 's3', S3_BUCKET: 'b', S3_SECRET_ACCESS_KEY: 'sss' }),
    ).toThrow('S3_ACCESS_KEY_ID: задайте вместе с S3_SECRET_ACCESS_KEY или не задавайте ни один');
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
  it('DATABASE_PASSWORD и REDIS_PASSWORD вставляются в URL; без них URL как есть', () => {
    const c = loadConfig({
      ...base,
      DATABASE_URL: 'postgres://app@db:5432/app?sslmode=disable',
      DATABASE_PASSWORD: 'p@ss/w:rd#%',
      REDIS_URL: 'redis://redis:6379',
      REDIS_PASSWORD: 'r@d/s#',
    });
    expect(c.databaseUrl).toBe('postgres://app:p%40ss%2Fw%3Ard%23%25@db:5432/app?sslmode=disable');
    expect(c.redisUrl).toBe('redis://:r%40d%2Fs%23@redis:6379');
    expect(loadConfig(base).databaseUrl).toBe(base.DATABASE_URL);
  });
  it('DATABASE_URL не URL при DATABASE_PASSWORD — ошибка с именем переменной, без пароля', () => {
    const bad = () =>
      loadConfig({ ...base, DATABASE_URL: 'db:5432', DATABASE_PASSWORD: 'secret-value' });
    expect(bad).toThrow('DATABASE_URL: нужен URL');
    expect(bad).not.toThrow(/secret-value/);
  });
  it('TRUSTED_PROXY_HOPS: по умолчанию 1, целое 1–5', () => {
    expect(loadConfig(base).trustedProxyHops).toBe(1);
    expect(loadConfig({ ...base, TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops).toBe(2);
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: '0' })).toThrow('TRUSTED_PROXY_HOPS');
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: '6' })).toThrow('TRUSTED_PROXY_HOPS');
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: '1.5' })).toThrow('TRUSTED_PROXY_HOPS');
  });
  it('API_SELF_URL: явное значение без завершающего слэша', () => {
    expect(loadConfig({ ...base, API_SELF_URL: 'http://10.0.0.5:3000/' }).apiSelfUrl).toBe(
      'http://10.0.0.5:3000',
    );
    expect(() => loadConfig({ ...base, API_SELF_URL: 'api' })).toThrow('API_SELF_URL');
  });
  it('RENDER_WORKERS: явное значение, пустое — по умолчанию, целое 1–16', () => {
    expect(loadConfig({ ...base, RENDER_WORKERS: '8' }).renderWorkers).toBe(8);
    expect(loadConfig({ ...base, RENDER_WORKERS: '' }).renderWorkers).toBe(
      loadConfig(base).renderWorkers,
    );
    for (const v of ['0', '17', '1.5', 'x']) {
      expect(() => loadConfig({ ...base, RENDER_WORKERS: v })).toThrow(
        'RENDER_WORKERS: целое от 1 до 16',
      );
    }
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
