import type { Role } from '@carbone-reports/shared';
import { z } from 'zod';

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
    STORAGE_DIR: z.string().default('/data'),
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
  });

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
  storageDir: string;
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
    storageDir: e.STORAGE_DIR,
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
