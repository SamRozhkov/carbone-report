import type { Role } from '@carbone-reports/shared';
import { z } from 'zod';

const S3_REQUIRED = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

const Env = z
  .object({
    DATABASE_URL: z.string({ error: 'DATABASE_URL обязателен' }).min(1, 'DATABASE_URL обязателен'),
    APP_SECRET: z.string().min(32, 'APP_SECRET: минимум 32 символа'),
    ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY: 32 байта в base64'),
    ONLYOFFICE_JWT_SECRET: z.string().min(32, 'ONLYOFFICE_JWT_SECRET: минимум 32 символа'),
    ONLYOFFICE_INTERNAL_URL: z.url().default('http://onlyoffice'),
    API_INTERNAL_URL: z.url().default('http://api:3000'),
    CARBONE_URL: z.url().default('http://carbone:4000'),
    REDIS_URL: z.string().default('redis://redis:6379'),
    ADMIN_LOGIN: z.string().optional(),
    ADMIN_PASSWORD: z
      .string()
      .refine((v) => v === '' || v.length >= 8, 'ADMIN_PASSWORD: минимум 8 символов')
      .optional(),
    STORAGE_BACKEND: z.enum(['local', 's3'], { error: 'ожидается local или s3' }).default('local'),
    STORAGE_DIR: z.string().default('/data'),
    // Пустая строка из .env — «не задано» (для S3_ENDPOINT — AWS S3).
    S3_ENDPOINT: z
      .string()
      .refine(
        (v) => v === '' || (/^https?:\/\//.test(v) && URL.canParse(v)),
        'нужен URL, например http://s3:8333',
      )
      .optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
    S3_CREATE_BUCKET: z.enum(['true', 'false']).default('false'),
    QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    QUERY_MAX_ROWS: z.coerce.number().int().positive().default(100000),
    RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
    REPORT_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
    REPORT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
    TZ: z.string().default('Europe/Moscow'),
    PORT: z.coerce.number().int().default(3000),
    COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
    LDAP_ENABLED: z.enum(['true', 'false']).default('false'),
    LDAP_URL: z.string().optional(),
    LDAP_BIND_DN: z.string().optional(),
    LDAP_BIND_PASSWORD: z.string().optional(),
    LDAP_BASE_DN: z.string().optional(),
    LDAP_USER_FILTER: z
      .string()
      .refine((v) => v.includes('%s'), 'LDAP_USER_FILTER: должен содержать %s')
      .default('(uid=%s)'),
    LDAP_DEFAULT_ROLE: z.enum(['admin', 'user']).default('user'),
    LDAP_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('true'),
  })
  .superRefine((v, ctx) => {
    if (v.LDAP_ENABLED !== 'true') return;
    if (!v.LDAP_URL) {
      ctx.addIssue({
        code: 'custom',
        message: 'LDAP_URL: задайте при LDAP_ENABLED=true',
        path: ['LDAP_URL'],
      });
    }
    if (!v.LDAP_BASE_DN) {
      ctx.addIssue({
        code: 'custom',
        message: 'LDAP_BASE_DN: задайте при LDAP_ENABLED=true',
        path: ['LDAP_BASE_DN'],
      });
    }
  })
  .superRefine((e, ctx) => {
    if (e.STORAGE_BACKEND !== 's3') return;
    // Значения не попадают в сообщение — только имена переменных.
    for (const k of S3_REQUIRED)
      if (!e[k])
        ctx.addIssue({ code: 'custom', path: [k], message: 'обязателен при STORAGE_BACKEND=s3' });
  });

/** Настройки S3 (STORAGE_BACKEND=s3). Ключи доступа не логируются. */
export interface S3Settings {
  /** Не задан — AWS S3 по региону. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** SeaweedFS, MinIO — true (адрес вида http://host/bucket/key). */
  forcePathStyle: boolean;
  /** Создать бакет при старте, если его нет. */
  createBucket: boolean;
}

export interface Config {
  databaseUrl: string;
  appSecret: Uint8Array;
  encryptionKey: Buffer;
  onlyofficeJwtSecret: Uint8Array;
  onlyofficeInternalUrl: string;
  apiInternalUrl: string;
  carboneUrl: string;
  redisUrl: string;
  adminLogin?: string;
  adminPassword?: string;
  storageBackend: 'local' | 's3';
  /** Каталог файлов для local. */
  storageDir: string;
  /** null при local. */
  s3: S3Settings | null;
  queryTimeoutMs: number;
  queryMaxRows: number;
  renderTimeoutMs: number;
  /** Общий срок генерации и предпросмотра: проверка параметров, SQL и Carbone вместе. */
  reportTimeoutMs: number;
  reportRetentionDays: number;
  tz: string;
  port: number;
  cookieSecure: boolean;
  ldap: LdapConfig | null;
}

export interface LdapConfig {
  url: string;
  bindDn?: string;
  bindPassword?: string;
  baseDn: string;
  /** Фильтр поиска пользователя, `%s` — подставляемый логин (например, `(uid=%s)` или `(sAMAccountName=%s)`). */
  userFilter: string;
  /** Роль нового локального пользователя при первом успешном входе через LDAP. */
  defaultRole: Role;
  tlsRejectUnauthorized: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Неверная конфигурация: ${msg}`);
  }
  const e = r.data;
  const enc = new TextEncoder();
  return {
    databaseUrl: e.DATABASE_URL,
    appSecret: enc.encode(e.APP_SECRET),
    encryptionKey: Buffer.from(e.ENCRYPTION_KEY, 'base64'),
    onlyofficeJwtSecret: enc.encode(e.ONLYOFFICE_JWT_SECRET),
    onlyofficeInternalUrl: e.ONLYOFFICE_INTERNAL_URL.replace(/\/$/, ''),
    apiInternalUrl: e.API_INTERNAL_URL.replace(/\/$/, ''),
    carboneUrl: e.CARBONE_URL.replace(/\/$/, ''),
    redisUrl: e.REDIS_URL,
    adminLogin: e.ADMIN_LOGIN,
    adminPassword: e.ADMIN_PASSWORD,
    storageBackend: e.STORAGE_BACKEND,
    storageDir: e.STORAGE_DIR,
    s3:
      e.STORAGE_BACKEND === 's3'
        ? {
            endpoint: e.S3_ENDPOINT || undefined,
            region: e.S3_REGION || 'us-east-1',
            bucket: e.S3_BUCKET!,
            accessKeyId: e.S3_ACCESS_KEY_ID!,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY!,
            forcePathStyle: e.S3_FORCE_PATH_STYLE === 'true',
            createBucket: e.S3_CREATE_BUCKET === 'true',
          }
        : null,
    queryTimeoutMs: e.QUERY_TIMEOUT_MS,
    queryMaxRows: e.QUERY_MAX_ROWS,
    renderTimeoutMs: e.RENDER_TIMEOUT_MS,
    reportTimeoutMs: e.REPORT_TIMEOUT_MS,
    reportRetentionDays: e.REPORT_RETENTION_DAYS,
    tz: e.TZ,
    port: e.PORT,
    cookieSecure: e.COOKIE_SECURE === 'true',
    ldap:
      e.LDAP_ENABLED === 'true'
        ? {
            url: e.LDAP_URL!,
            bindDn: e.LDAP_BIND_DN,
            bindPassword: e.LDAP_BIND_PASSWORD,
            baseDn: e.LDAP_BASE_DN!,
            userFilter: e.LDAP_USER_FILTER,
            defaultRole: e.LDAP_DEFAULT_ROLE,
            tlsRejectUnauthorized: e.LDAP_TLS_REJECT_UNAUTHORIZED === 'true',
          }
        : null,
  };
}
