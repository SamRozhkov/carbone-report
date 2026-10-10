import type { Role } from '@carbone-reports/shared';
import os from 'node:os';
import { z } from 'zod';
import { hasHost, withPassword } from './lib/url-password';

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
    // Адрес этой реплики API для Document Server (разовые ссылки на собранный отчёт); в k8s — IP пода.
    API_SELF_URL: z.url().default('http://api:3000'),
    REDIS_URL: z.string().default('redis://redis:6379'),
    // Пароли отдельно от URL (чарт Helm): вставляются с кодированием, допустимы любые символы.
    DATABASE_PASSWORD: z.string().optional(),
    REDIS_PASSWORD: z.string().optional(),
    // Версия сборки: образ получает их из ARG (CI), пустая строка — «не задано».
    APP_VERSION: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('dev')),
    APP_COMMIT: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('unknown')),
    APP_BUILD_DATE: z.preprocess((v) => (v === '' ? undefined : v), z.string().default('unknown')),
    // Сколько прокси перед API: compose — nginx (1), k8s — Ingress и nginx (2).
    TRUSTED_PROXY_HOPS: z.coerce
      .number({ error: 'целое от 1 до 5' })
      .int('целое от 1 до 5')
      .min(1, 'целое от 1 до 5')
      .max(5, 'целое от 1 до 5')
      .default(1),
    // Потоки рендера Carbone; пустая строка из .env — «не задано» (min(4, число ядер)).
    RENDER_WORKERS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce
        .number({ error: 'целое от 1 до 16' })
        .int('целое от 1 до 16')
        .min(1, 'целое от 1 до 16')
        .max(16, 'целое от 1 до 16')
        .optional(),
    ),
    // Предел кучи (old space) одного потока рендера, МБ; пусто — по лимиту памяти контейнера.
    RENDER_WORKER_MEMORY_MB: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce
        .number({ error: 'целое от 128 до 8192' })
        .int('целое от 128 до 8192')
        .min(128, 'целое от 128 до 8192')
        .max(8192, 'целое от 128 до 8192')
        .optional(),
    ),
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
      .refine((v) => v.includes('%s'), 'должен содержать %s')
      .default('(uid=%s)'),
    LDAP_DEFAULT_ROLE: z.enum(['admin', 'user']).default('user'),
    LDAP_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('true'),
    // Агент бэкапа (§26.3): без адреса управление бэкапами в админке выключено.
    BACKUP_AGENT_URL: z
      .string()
      .refine(
        (v) => v === '' || (/^https?:\/\//.test(v) && URL.canParse(v)),
        'нужен URL, например http://backup-agent:8080',
      )
      .optional(),
    BACKUP_AGENT_TOKEN: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.LDAP_ENABLED !== 'true') return;
    // Имя переменной добавляет path (сообщение собирается как «<path>: <message>»).
    if (!v.LDAP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['LDAP_URL'],
        message: 'задайте при LDAP_ENABLED=true',
      });
    } else if (!/^ldaps?:\/\/[^/]/.test(v.LDAP_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['LDAP_URL'],
        message: 'нужен URL вида ldap://host:389 или ldaps://host:636',
      });
    }
    if (!v.LDAP_BASE_DN) {
      ctx.addIssue({
        code: 'custom',
        path: ['LDAP_BASE_DN'],
        message: 'задайте при LDAP_ENABLED=true',
      });
    }
  })
  .superRefine((e, ctx) => {
    if (e.STORAGE_BACKEND !== 's3') return;
    // Значения не попадают в сообщение — только имена переменных.
    if (!e.S3_BUCKET)
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET'],
        message: 'обязателен при STORAGE_BACKEND=s3',
      });
    // Ключи — оба или ни одного: без них SDK берёт учётные данные из окружения (IRSA).
    if (e.S3_ACCESS_KEY_ID && !e.S3_SECRET_ACCESS_KEY)
      ctx.addIssue({
        code: 'custom',
        path: ['S3_SECRET_ACCESS_KEY'],
        message: 'задайте вместе с S3_ACCESS_KEY_ID или не задавайте ни один',
      });
    if (!e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY)
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'задайте вместе с S3_SECRET_ACCESS_KEY или не задавайте ни один',
      });
  })
  .superRefine((e, ctx) => {
    if (e.DATABASE_PASSWORD && !hasHost(e.DATABASE_URL))
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'нужен URL вида postgres://user@host:5432/db',
      });
    if (e.REDIS_PASSWORD && !hasHost(e.REDIS_URL))
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: 'нужен URL вида redis://host:6379',
      });
  })
  .superRefine((e, ctx) => {
    if (!e.BACKUP_AGENT_URL) return;
    // Только имя переменной и правило — значение токена в сообщение не попадает.
    if (!e.BACKUP_AGENT_TOKEN)
      ctx.addIssue({
        code: 'custom',
        path: ['BACKUP_AGENT_TOKEN'],
        message: 'обязателен при BACKUP_AGENT_URL',
      });
    else if (e.BACKUP_AGENT_TOKEN.length < 32)
      ctx.addIssue({ code: 'custom', path: ['BACKUP_AGENT_TOKEN'], message: 'минимум 32 символа' });
  });

/** Настройки S3 (STORAGE_BACKEND=s3). Ключи доступа не логируются. */
export interface S3Settings {
  /** Не задан — AWS S3 по региону. */
  endpoint?: string;
  region: string;
  bucket: string;
  /** Без ключей — учётные данные из окружения (IRSA, AWS_*). */
  accessKeyId?: string;
  secretAccessKey?: string;
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
  /** Адрес этой реплики для Document Server, без завершающего слэша. */
  apiSelfUrl: string;
  /** Число потоков рендера Carbone. */
  renderWorkers: number;
  /** Предел кучи одного потока рендера, МБ (resourceLimits.maxOldGenerationSizeMb). */
  renderWorkerMemoryMb: number;
  /** Откуда взят предел: env — RENDER_WORKER_MEMORY_MB, container — из лимита памяти, default — 1024. */
  renderWorkerMemorySource: 'env' | 'container' | 'default';
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
  /** Версия сборки: тег выпуска без `v` или `dev`. */
  appVersion: string;
  /** Короткий SHA коммита сборки или `unknown`. */
  appCommit: string;
  /** Дата коммита сборки (ISO 8601) или `unknown`. */
  appBuildDate: string;
  /** Сколько прокси перед API (X-Forwarded-For): compose — 1, k8s — 2. */
  trustedProxyHops: number;
  ldap: LdapConfig | null;
  /** Агент бэкапа; null — управление бэкапами выключено. Токен не логируется. */
  backupAgent: { url: string; token: string } | null;
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

/** Запас памяти контейнера на основной поток API, МБ. */
const API_RESERVE_MB = 400;

/**
 * Предел кучи потока рендера по умолчанию: (лимит контейнера − 400 МБ) / число потоков,
 * в пределах 256–2048 МБ; лимит неизвестен — 1024 МБ.
 */
export function defaultRenderWorkerMemoryMb(limitBytes: number | undefined, workers: number) {
  if (!limitBytes || !Number.isFinite(limitBytes) || limitBytes <= 0) return 1024;
  const limitMb = limitBytes / (1024 * 1024);
  const perWorker = Math.floor((limitMb - API_RESERVE_MB) / Math.max(1, workers));
  return Math.min(2048, Math.max(256, perWorker));
}

/** Лимит памяти контейнера (cgroup), байт; undefined — не задан или не определяется. */
export function containerMemoryLimit(): number | undefined {
  const v = process.constrainedMemory?.();
  // Без лимита Node возвращает 0 или огромное значение (cgroup v1) — больше памяти узла.
  if (!v || !Number.isFinite(v) || v <= 0 || v >= os.totalmem()) return undefined;
  return v;
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  memoryLimit: () => number | undefined = containerMemoryLimit,
): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Неверная конфигурация: ${msg}`);
  }
  const e = r.data;
  const renderWorkers = e.RENDER_WORKERS ?? Math.min(4, os.availableParallelism());
  const limit = e.RENDER_WORKER_MEMORY_MB === undefined ? memoryLimit() : undefined;
  const enc = new TextEncoder();
  return {
    databaseUrl: withPassword(e.DATABASE_URL, e.DATABASE_PASSWORD),
    appSecret: enc.encode(e.APP_SECRET),
    encryptionKey: Buffer.from(e.ENCRYPTION_KEY, 'base64'),
    onlyofficeJwtSecret: enc.encode(e.ONLYOFFICE_JWT_SECRET),
    onlyofficeInternalUrl: e.ONLYOFFICE_INTERNAL_URL.replace(/\/$/, ''),
    apiInternalUrl: e.API_INTERNAL_URL.replace(/\/$/, ''),
    apiSelfUrl: e.API_SELF_URL.replace(/\/$/, ''),
    renderWorkers,
    renderWorkerMemoryMb:
      e.RENDER_WORKER_MEMORY_MB ?? defaultRenderWorkerMemoryMb(limit, renderWorkers),
    renderWorkerMemorySource:
      e.RENDER_WORKER_MEMORY_MB !== undefined ? 'env' : limit ? 'container' : 'default',
    redisUrl: withPassword(e.REDIS_URL, e.REDIS_PASSWORD),
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
            accessKeyId: e.S3_ACCESS_KEY_ID || undefined,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY || undefined,
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
    appVersion: e.APP_VERSION,
    appCommit: e.APP_COMMIT,
    appBuildDate: e.APP_BUILD_DATE,
    trustedProxyHops: e.TRUSTED_PROXY_HOPS,
    ldap:
      e.LDAP_ENABLED === 'true'
        ? {
            url: e.LDAP_URL!,
            // Пустые значения из .env (${LDAP_BIND_DN:-} в compose) — анонимный поиск.
            bindDn: e.LDAP_BIND_DN || undefined,
            bindPassword: e.LDAP_BIND_PASSWORD || undefined,
            baseDn: e.LDAP_BASE_DN!,
            userFilter: e.LDAP_USER_FILTER,
            defaultRole: e.LDAP_DEFAULT_ROLE,
            tlsRejectUnauthorized: e.LDAP_TLS_REJECT_UNAUTHORIZED === 'true',
          }
        : null,
    backupAgent: e.BACKUP_AGENT_URL
      ? { url: e.BACKUP_AGENT_URL.replace(/\/$/, ''), token: e.BACKUP_AGENT_TOKEN! }
      : null,
  };
}
