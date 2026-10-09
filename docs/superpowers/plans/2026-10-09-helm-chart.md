# Helm-чарт (План 16) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разворачивать carbone-reports в свой кластер Kubernetes одним `helm install`: несколько реплик API, бэкап и восстановление из админки, встроенные или внешние Postgres/Redis/S3.

**Architecture:** Один чарт `charts/carbone-reports` с обычными шаблонами; компоненты и встроенные зависимости включаются флагами. Приложение получает небольшие правки для кластера: пароли отдельно от URL, число доверенных прокси из настройки, S3 без ключей (IRSA), блокировка миграций при старте, очистка Redis только по `cr:*`, SSL агента к Postgres, режимы nginx в образе web. Проверка — helm lint, helm-unittest и kubeconform через Docker-образы с закреплёнными версиями; установка в kind и smoke-тест в CI.

**Tech Stack:** Helm 4 (alpine/helm:4.3.0), helm-unittest 1.2.1, kubeconform 0.8.0, kind (helm/kind-action), Fastify 5 + pg + ioredis + @aws-sdk/client-s3, nginx 1.30 (envsubst-шаблоны официального образа), vitest + testcontainers, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §27 (План 16).

## Global Constraints

- Node 22: `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH` перед `pnpm` (в shell по умолчанию Node 16 без pnpm).
- Тексты для пользователя, сообщения об ошибках и комментарии — на русском, в стиле окружающего кода.
- Секреты не печатаются никогда: ни в тестах, ни в журналах, ни в сообщениях об ошибках — только имена переменных. `.env` и `certs/` не коммитятся.
- Каждый коммит заканчивается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Перед коммитом: `pnpm exec prettier --check .`, `pnpm lint`, `pnpm typecheck` для затронутых пакетов — зелёные.
- Образы инструментов (только так, без установки на хост): `alpine/helm:4.3.0`, `helmunittest/helm-unittest:4.3.0-1.2.1`, `ghcr.io/yannh/kubeconform:v0.8.0`; схемы Kubernetes для kubeconform — `-kubernetes-version 1.33.0`.
- Образы чарта — те же, что в compose: `postgres:17-alpine`, `redis:7-alpine`, `chrislusf/seaweedfs:4.48`, `carbone/carbone-ee:full-5.15.3-fonts`, `onlyoffice/documentserver:9.4.0.1`; образы приложения — `ghcr.io/samrozhkov/carbone-report-{api,web,backup}`, общий тег `image.tag` (по умолчанию `.Chart.AppVersion`).
- Advisory-ключи Postgres: `726100001` — бэкап и удаление файлов, `726100002` — сборка файлов запуска, `726100003` — миграции при старте API (новый).
- В чарте хранилище файлов только S3 (`STORAGE_BACKEND=s3`).
- Все ключи Redis приложения начинаются с `cr:`; флаг обслуживания — `cr:maintenance`.
- Пароли не подставляются в URL шаблоном: `DATABASE_PASSWORD` и `REDIS_PASSWORD` вставляются в URL кодом приложения (`encodeURIComponent` + `new URL()`). `PGPASSWORD` в окружении API запрещён (pg подставил бы его в источники данных без пароля); агенту пароль базы передаётся как `PGPASSWORD`.
- `TRUSTED_PROXY_HOPS`: целое 1–5, по умолчанию 1 (compose); чарт ставит 2.
- S3-клиент API: `maxAttempts: 2`, `requestTimeout` 30 000 мс, `connectionTimeout` 5 000 мс; ключи S3 — оба или ни одного.
- Имена ресурсов чарта: `<fullname>-<компонент>`; компоненты `api`, `web`, `carbone`, `onlyoffice`, `backup-agent`, `postgresql`, `redis`, `s3`.
- Ключи Secret: `APP_SECRET`, `ENCRYPTION_KEY`, `ONLYOFFICE_JWT_SECRET`, `ADMIN_LOGIN`, `ADMIN_PASSWORD`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `BACKUP_AGENT_TOKEN`, необязательные `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `LDAP_BIND_PASSWORD`. Чарт не генерирует случайные значения (`lookup` не используется).
- Интеграционные тесты под нагрузкой хоста бывают медленными; падение по таймауту перепроверить повторным запуском, прежде чем считать его дефектом.

## Review Focus

1. Пароль внешней базы или Redis со спецсимволами (`p@ss/w:rd#%`) — API и агент подключаются; пароль не появляется в сообщениях об ошибках. Тесты: Task 1 (API), Task 3 (агент).
2. Реплики API стартуют одновременно на пустой базе — миграции применяются один раз, ни одна реплика не падает. Тест: Task 2 (три параллельных старта).
3. Общий внешний Redis с чужими ключами — восстановление удаляет только `cr:*` (кроме `cr:maintenance`), чужие ключи на месте. Тест: Task 3.
4. `helm install` без обязательного значения (хост Ingress, внешний Postgres, секрет) — понятная ошибка с именем значения, а не битые манифесты. Тесты: Task 5 и Task 7 (helm-unittest `failedTemplate`).
5. `helm uninstall` — том с бэкапами не удаляется вместе с релизом. Тест: Task 6 (аннотация `helm.sh/resource-policy: keep` на PVC бэкапов).

## Файлы

**Приложение**
- `apps/api/src/config.ts`, `config.test.ts` — `DATABASE_PASSWORD`, `REDIS_PASSWORD`, `TRUSTED_PROXY_HOPS`, ключи S3 «оба или ни одного».
- `apps/api/src/lib/url-password.ts` (+ тест) — вставка пароля в URL.
- `apps/api/src/app.ts`, `src/app.test.ts` — `createFastify(hops)`.
- `apps/api/src/lib/s3-storage.ts`, `src/lib/s3-storage.test.ts` — `maxAttempts`, таймаут, необязательные ключи.
- `apps/api/src/lib/startup-lock.ts`, `test/startup-lock.int.test.ts`, `src/server.ts` — блокировка миграций.
- `apps/api/test/helpers.ts` — `testConfig` с новыми полями.
- `apps/backup-agent/src/config.ts`, `config.test.ts` — `REDIS_PASSWORD`, SSL к Postgres.
- `apps/backup-agent/src/steps.ts`, `steps.test.ts` — `flushExcept` по `cr:*`.
- `apps/backup-agent/src/main.ts` — пул с SSL.
- `docker/backup/lib.sh`, `apps/backup-agent/test/agent.int.test.ts` — S3 без ключей (rclone `env_auth`).
- `docker/nginx/*`, `docker/web.Dockerfile`, `docker-compose.dev.yml`, `apps/web/test/nginx.int.test.ts`, `apps/web/vitest.int.config.ts`, `apps/web/package.json` — режимы nginx.

**Чарт**
- `charts/carbone-reports/Chart.yaml`, `values.yaml`, `.helmignore`, `templates/_helpers.tpl`, `templates/_validate.tpl`, `templates/NOTES.txt`.
- `templates/secret.yaml`, `configmap-api.yaml`, `configmap-backup-agent.yaml`, `serviceaccount.yaml`.
- `templates/api.yaml`, `web.yaml`, `ingress.yaml`, `carbone.yaml`, `onlyoffice.yaml`, `backup-agent.yaml`, `postgresql.yaml`, `redis.yaml`, `s3.yaml`, `networkpolicy.yaml`.
- `charts/carbone-reports/files/s3-entrypoint.sh` — копия `docker/s3/entrypoint.sh`.
- `charts/carbone-reports/tests/*_test.yaml` — helm-unittest.
- `charts/carbone-reports/ci/*.yaml` — наборы values для lint/kubeconform.
- `scripts/chart.sh` — lint, unittest, kubeconform, проверка копии скрипта.
- `scripts/k8s-smoke.ts` — smoke через port-forward.
- `.github/workflows/ci.yml` — задания `chart`, `chart-kind`, публикация чарта.
- `README.md`, `docs/superpowers/notes/2026-10-02-backend-follow-ups.md`.

---
### Task 1: API — пароли отдельно от URL, доверенные прокси, S3 без ключей

**Files:**
- Create: `apps/api/src/lib/url-password.ts`, `apps/api/src/lib/url-password.test.ts`, `apps/api/src/app.test.ts`, `apps/api/src/lib/s3-storage.test.ts`
- Modify: `apps/api/src/config.ts`, `apps/api/src/config.test.ts`, `apps/api/src/app.ts`, `apps/api/src/lib/s3-storage.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Produces: `withPassword(url: string, password: string | undefined): string` (`apps/api/src/lib/url-password.ts`); `Config.trustedProxyHops: number`; `S3Settings.accessKeyId?: string`, `S3Settings.secretAccessKey?: string`; `createFastify(hops?: number)`; `S3_TIMEOUTS = { connectionTimeoutMs: 5_000, requestTimeoutMs: 30_000 }`, `S3_MAX_ATTEMPTS = 2`.
- Env: `DATABASE_PASSWORD`, `REDIS_PASSWORD`, `TRUSTED_PROXY_HOPS` — читает Task 5 (чарт).

- [ ] **Step 1: Тест вставки пароля в URL**

`apps/api/src/lib/url-password.test.ts`:

```ts
import { Redis } from 'ioredis';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { withPassword } from './url-password';

const NASTY = 'p@ss/w:rd#%?&=+ пароль';

describe('withPassword', () => {
  it('без пароля URL не меняется', () => {
    expect(withPassword('postgres://app@db:5432/app', undefined)).toBe('postgres://app@db:5432/app');
    expect(withPassword('postgres://app@db:5432/app', '')).toBe('postgres://app@db:5432/app');
  });

  it('pg получает пароль со спецсимволами без искажений, остальное — как было', () => {
    const url = withPassword('postgres://app@db.example:6432/app?sslmode=disable', NASTY);
    const p = (new pg.Client({ connectionString: url }) as unknown as {
      connectionParameters: { password: string; user: string; host: string; port: number; database: string };
    }).connectionParameters;
    expect(p).toMatchObject({ password: NASTY, user: 'app', host: 'db.example', port: 6432, database: 'app' });
  });

  it('ioredis получает пароль со спецсимволами без искажений', () => {
    const r = new Redis(withPassword('redis://redis.example:6380/2', NASTY), { lazyConnect: true });
    expect(r.options).toMatchObject({ password: NASTY, host: 'redis.example', port: 6380, db: 2 });
    r.disconnect();
  });

  it('пароль из переменной заменяет пароль в URL', () => {
    const url = withPassword('redis://:old@redis:6379', 'new');
    const r = new Redis(url, { lazyConnect: true });
    expect(r.options.password).toBe('new');
    r.disconnect();
  });

  it('не URL — ошибка без пароля в тексте', () => {
    expect(() => withPassword('not a url', 'secret-value')).toThrow('нужен URL');
    try {
      withPassword('not a url', 'secret-value');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-value');
    }
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd apps/api && pnpm exec vitest run src/lib/url-password.test.ts`
Expected: FAIL — `Cannot find module './url-password'`.

- [ ] **Step 3: Реализация**

`apps/api/src/lib/url-password.ts`:

```ts
/**
 * Пароль из отдельной переменной (DATABASE_PASSWORD, REDIS_PASSWORD) вставляется в URL с кодированием:
 * в пароле внешней базы могут быть @, /, #, % — подставленный шаблоном как есть, он сломал бы URL.
 * Пустой пароль — URL без изменений (compose передаёт пароль прямо в URL).
 */
export function withPassword(url: string, password: string | undefined): string {
  if (!password) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Ни URL, ни пароль в сообщение не попадают.
    throw new Error('нужен URL вида scheme://user@host:port/…');
  }
  // Сеттер не кодирует %, поэтому кодируем сами: pg и ioredis раскодируют пароль обратно.
  u.password = encodeURIComponent(password);
  return u.toString();
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `cd apps/api && pnpm exec vitest run src/lib/url-password.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Тесты конфигурации**

В `apps/api/src/config.test.ts`:

1. Заменить тест `'s3 без обязательных значений — понятная ошибка'` на:

```ts
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
      loadConfig({ ...base, STORAGE_BACKEND: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'key-id-123' });
    expect(one).toThrow(
      'S3_SECRET_ACCESS_KEY: задайте вместе с S3_ACCESS_KEY_ID или не задавайте ни один',
    );
    expect(one).not.toThrow(/key-id-123/);
    expect(() =>
      loadConfig({ ...base, STORAGE_BACKEND: 's3', S3_BUCKET: 'b', S3_SECRET_ACCESS_KEY: 'sss' }),
    ).toThrow('S3_ACCESS_KEY_ID: задайте вместе с S3_SECRET_ACCESS_KEY или не задавайте ни один');
  });
```

2. Добавить в конец `describe('loadConfig', …)`:

```ts
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
```

- [ ] **Step 6: Запустить — падают**

Run: `cd apps/api && pnpm exec vitest run src/config.test.ts`
Expected: FAIL — новые тесты (нет `trustedProxyHops`, ключи S3 обязательны, пароль не вставляется).

- [ ] **Step 7: Реализация в `config.ts`**

1. Импорт вверху: `import { withPassword } from './lib/url-password';`
2. Удалить константу `S3_REQUIRED`.
3. В `Env` после `REDIS_URL`:

```ts
    // Пароли отдельно от URL (чарт Helm): вставляются с кодированием, допустимы любые символы.
    DATABASE_PASSWORD: z.string().optional(),
    REDIS_PASSWORD: z.string().optional(),
    // Сколько прокси перед API: compose — nginx (1), k8s — Ingress и nginx (2).
    TRUSTED_PROXY_HOPS: z.coerce
      .number({ error: 'целое от 1 до 5' })
      .int('целое от 1 до 5')
      .min(1, 'целое от 1 до 5')
      .max(5, 'целое от 1 до 5')
      .default(1),
```

4. Заменить `superRefine` для S3 на:

```ts
  .superRefine((e, ctx) => {
    if (e.STORAGE_BACKEND !== 's3') return;
    // Значения не попадают в сообщение — только имена переменных.
    if (!e.S3_BUCKET)
      ctx.addIssue({ code: 'custom', path: ['S3_BUCKET'], message: 'обязателен при STORAGE_BACKEND=s3' });
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
    if (e.DATABASE_PASSWORD && !URL.canParse(e.DATABASE_URL))
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'нужен URL вида postgres://user@host:5432/db' });
    if (e.REDIS_PASSWORD && !URL.canParse(e.REDIS_URL))
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'нужен URL вида redis://host:6379' });
  })
```

5. `S3Settings`: поля ключей необязательны:

```ts
  /** Без ключей — учётные данные из окружения (IRSA, AWS_*). */
  accessKeyId?: string;
  secretAccessKey?: string;
```

6. `Config`: после `cookieSecure: boolean;` добавить:

```ts
  /** Сколько прокси перед API (X-Forwarded-For): compose — 1, k8s — 2. */
  trustedProxyHops: number;
```

7. В `loadConfig`:

```ts
    databaseUrl: withPassword(e.DATABASE_URL, e.DATABASE_PASSWORD),
    …
    redisUrl: withPassword(e.REDIS_URL, e.REDIS_PASSWORD),
    …
            accessKeyId: e.S3_ACCESS_KEY_ID || undefined,
            secretAccessKey: e.S3_SECRET_ACCESS_KEY || undefined,
    …
    cookieSecure: e.COOKIE_SECURE === 'true',
    trustedProxyHops: e.TRUSTED_PROXY_HOPS,
```

8. `apps/api/test/helpers.ts`, `testConfig`: после `cookieSecure: false,` добавить `trustedProxyHops: 1,`.

- [ ] **Step 8: Запустить — проходят**

Run: `cd apps/api && pnpm exec vitest run src/config.test.ts && pnpm typecheck`
Expected: PASS; typecheck укажет на `s.accessKeyId` в `s3-storage.ts` (строка с `credentials`) — чинится в Step 11.

- [ ] **Step 9: Тест доверенных прокси и S3-клиента**

`apps/api/src/app.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createFastify } from './app';

async function ipFor(hops: number | undefined, xff: string): Promise<string> {
  const app = createFastify(hops);
  app.get('/ip', async (req) => ({ ip: req.ip }));
  const r = await app.inject({ method: 'GET', url: '/ip', headers: { 'x-forwarded-for': xff } });
  await app.close();
  return (r.json() as { ip: string }).ip;
}

describe('createFastify: доверенные прокси', () => {
  it('по умолчанию 1 хоп (nginx): клиент — последний адрес X-Forwarded-For', async () => {
    expect(await ipFor(undefined, '203.0.113.7, 10.0.0.5')).toBe('10.0.0.5');
  });
  it('2 хопа (Ingress и nginx): клиент — адрес до Ingress, подставленное клиентом не учитывается', async () => {
    expect(await ipFor(2, '198.51.100.1, 203.0.113.7, 10.0.0.5')).toBe('203.0.113.7');
  });
});
```

`apps/api/src/lib/s3-storage.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createS3Client, S3_MAX_ATTEMPTS, S3_TIMEOUTS } from './s3-storage';

const base = { region: 'us-east-1', bucket: 'b', forcePathStyle: true, createBucket: false };

afterEach(() => vi.unstubAllEnvs());

describe('createS3Client', () => {
  it('две попытки и таймаут запроса 30 с: общий срок вызова — до минуты', async () => {
    expect(S3_MAX_ATTEMPTS).toBe(2);
    expect(S3_TIMEOUTS).toEqual({ connectionTimeoutMs: 5_000, requestTimeoutMs: 30_000 });
    expect(await createS3Client(base).config.maxAttempts()).toBe(2);
  });

  it('с ключами — статические учётные данные', async () => {
    const c = createS3Client({ ...base, accessKeyId: 'k-id', secretAccessKey: 'k-secret' });
    expect(await c.config.credentials()).toMatchObject({ accessKeyId: 'k-id', secretAccessKey: 'k-secret' });
  });

  it('без ключей — цепочка по умолчанию (здесь переменные AWS_* окружения, в k8s — IRSA)', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'env-id');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret');
    const c = createS3Client(base);
    expect(await c.config.credentials()).toMatchObject({ accessKeyId: 'env-id', secretAccessKey: 'env-secret' });
  });
});
```

- [ ] **Step 10: Запустить — падают**

Run: `cd apps/api && pnpm exec vitest run src/app.test.ts src/lib/s3-storage.test.ts`
Expected: FAIL — `createFastify` не принимает хопы (оба ответа `10.0.0.5`), нет `S3_MAX_ATTEMPTS`.

- [ ] **Step 11: Реализация**

`apps/api/src/app.ts`:
- комментарий над `TRUSTED_PROXY_HOPS` дополнить строкой: «Значение по умолчанию; в работе — `config.trustedProxyHops` (TRUSTED_PROXY_HOPS, чарт Helm ставит 2: Ingress и nginx).»;
- `export function createFastify(hops: number = TRUSTED_PROXY_HOPS) {` и `trustProxy: trustProxyHops(hops),`;
- в `buildApp`: `const app = createFastify(deps.config.trustedProxyHops);`.

`apps/api/src/lib/s3-storage.ts`:

```ts
export const S3_TIMEOUTS: S3Timeouts = { connectionTimeoutMs: 5_000, requestTimeoutMs: 30_000 };

/** Попыток на вызов: с таймаутом 30 с общий срок — до минуты (по умолчанию у SDK 3 попытки). */
export const S3_MAX_ATTEMPTS = 2;

/**
 * Клиент S3 с таймаутами: по умолчанию у SDK их нет, и зависший S3 держал бы шлюз удаления,
 * блокировки в БД и старт API. Без throwOnRequestTimeout requestTimeout лишь пишет предупреждение.
 * Таймаут — повторяемая ошибка: S3_MAX_ATTEMPTS попыток, общий срок — до 2 × requestTimeout.
 * Без ключей — цепочка учётных данных SDK по умолчанию (IRSA в k8s, переменные AWS_*).
 */
export function createS3Client(s: S3Settings, t: S3Timeouts = S3_TIMEOUTS): S3Client {
  return new S3Client({
    requestHandler: new NodeHttpHandler({
      connectionTimeout: t.connectionTimeoutMs,
      requestTimeout: t.requestTimeoutMs,
      throwOnRequestTimeout: true,
    }),
    maxAttempts: S3_MAX_ATTEMPTS,
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle,
    ...(s.accessKeyId && s.secretAccessKey
      ? { credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } }
      : {}),
    // S3-совместимые хранилища (SeaweedFS и др.): контрольные суммы — только там, где их требует API.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
```

- [ ] **Step 12: Запустить всё в пакете**

Run: `cd apps/api && pnpm exec vitest run && pnpm typecheck`
Expected: PASS (все модульные тесты API, typecheck чистый). Если `test/helpers.ts` или другие места используют `settings.accessKeyId` как `string` — typecheck покажет; передавать как есть (поле стало необязательным, значения в тестах заданы).

- [ ] **Step 13: Интеграционные тесты, которые касаются IP и S3**

Run: `cd apps/api && pnpm exec vitest run --config vitest.int.config.ts test/login-ip-limit.int.test.ts test/s3-startup.int.test.ts test/storage-contract.int.test.ts`
Expected: PASS (поведение по умолчанию не изменилось).

- [ ] **Step 14: Commit**

```bash
git add apps/api/src/lib/url-password.ts apps/api/src/lib/url-password.test.ts apps/api/src/config.ts apps/api/src/config.test.ts apps/api/src/app.ts apps/api/src/app.test.ts apps/api/src/lib/s3-storage.ts apps/api/src/lib/s3-storage.test.ts apps/api/test/helpers.ts
git commit -m "feat(api): DATABASE_PASSWORD/REDIS_PASSWORD, TRUSTED_PROXY_HOPS, S3 keys optional with 2 attempts and 30s timeout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API — миграции при старте под advisory-блокировкой

**Files:**
- Create: `apps/api/src/lib/startup-lock.ts`, `apps/api/test/startup-lock.int.test.ts`
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `migrateDb(db: Db)`, `createDb(url)` (`apps/api/src/db/client.ts`); `createTestDatabase(): Promise<string>` (`apps/api/test/helpers.ts`, пустая база).
- Produces: `STARTUP_LOCK_KEY = 726100003`; `withStartupLock<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<T>`.

- [ ] **Step 1: Интеграционный тест**

`apps/api/test/startup-lock.int.test.ts`:

```ts
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, migrateDb } from '../src/db/client';
import { STARTUP_LOCK_KEY, withStartupLock } from '../src/lib/startup-lock';
import { createTestDatabase } from './helpers';

const pools: pg.Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Отдельный пул на «реплику»: как у API, max 10 соединений. */
function replica(url: string) {
  const { db, pool } = createDb(url);
  pools.push(pool);
  return { db, pool };
}

describe('withStartupLock', () => {
  it('три реплики стартуют одновременно на пустой базе: миграции один раз, все успешны', async () => {
    const url = await createTestDatabase();
    const rs = [replica(url), replica(url), replica(url)];
    await Promise.all(rs.map((r) => withStartupLock(r.pool, () => migrateDb(r.db))));
    const check = new pg.Client({ connectionString: url });
    await check.connect();
    const { rows } = await check.query<{ n: string; d: string }>(
      'select count(*) as n, count(distinct hash) as d from drizzle.__drizzle_migrations',
    );
    await check.end();
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    expect(rows[0]!.n).toBe(rows[0]!.d);
  });

  it('секции выполняются по очереди, а не вперемешку', async () => {
    const url = await createTestDatabase();
    const a = replica(url);
    const b = replica(url);
    const events: string[] = [];
    const section = (name: string) => async () => {
      events.push(`${name}:начало`);
      await sleep(300);
      events.push(`${name}:конец`);
    };
    await Promise.all([withStartupLock(a.pool, section('a')), withStartupLock(b.pool, section('b'))]);
    // Каждая секция целиком: начало и конец одной секции идут подряд.
    const who = events.map((e) => e.split(':')[0]);
    expect(who[0]).toBe(who[1]);
    expect(who[2]).toBe(who[3]);
    expect(who[0]).not.toBe(who[2]);
  });

  it('ошибка внутри секции поднимается, блокировка снимается, соединение возвращается в пул', async () => {
    const url = await createTestDatabase();
    const a = replica(url);
    await expect(
      withStartupLock(a.pool, async () => {
        throw new Error('миграция упала');
      }),
    ).rejects.toThrow('миграция упала');
    const check = new pg.Client({ connectionString: url });
    await check.connect();
    const { rows } = await check.query(
      "select 1 from pg_locks where locktype = 'advisory' and objid = $1",
      [STARTUP_LOCK_KEY],
    );
    await check.end();
    expect(rows).toHaveLength(0);
    expect(a.pool.idleCount).toBe(a.pool.totalCount);
    await expect(withStartupLock(a.pool, async () => 'ок')).resolves.toBe('ок');
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd apps/api && pnpm exec vitest run --config vitest.int.config.ts test/startup-lock.int.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/startup-lock'`.

- [ ] **Step 3: Реализация**

`apps/api/src/lib/startup-lock.ts`:

```ts
import type pg from 'pg';

/** Миграции схемы и файлов при старте API (§27.4). 726100001 — бэкап и удаление файлов, 726100002 — сборка файлов запуска. */
export const STARTUP_LOCK_KEY = 726100003;

/**
 * fn под сессионной advisory-блокировкой на отдельном соединении: реплики API, стартующие
 * одновременно, выполняют миграции по очереди; следующая видит, что всё уже применено.
 * Если снять блокировку не удалось (соединение оборвано), соединение уничтожается —
 * закрытие сессии снимает её блокировки.
 */
export async function withStartupLock<T>(pool: pg.Pool, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('select pg_advisory_lock($1::bigint)', [STARTUP_LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await client
        .query('select pg_advisory_unlock($1::bigint)', [STARTUP_LOCK_KEY])
        .catch(() => {
          destroy = true;
        });
    }
  } finally {
    client.release(destroy);
  }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `cd apps/api && pnpm exec vitest run --config vitest.int.config.ts test/startup-lock.int.test.ts`
Expected: PASS, 3 tests. Если первый тест проходит и без блокировки (проверить, временно заменив тело `withStartupLock` на `return fn()`), всё равно оставить его: он фиксирует сценарий; второй тест без блокировки обязан падать.

- [ ] **Step 5: Подключить в `server.ts`**

- импорт: `import { withStartupLock } from './lib/startup-lock';`
- `await migrateDb(db);` → 

```ts
// Несколько реплик (Helm): миграции схемы — одна реплика за раз, остальные ждут и видят, что всё применено.
await withStartupLock(pool, () => migrateDb(db));
```

- `await migrateTemplateFiles({ db, storage: deps.storage, log: app.log });` →

```ts
await withStartupLock(pool, () => migrateTemplateFiles({ db, storage: deps.storage, log: app.log }));
```

(комментарий «До listen: …» над строкой сохранить).

- [ ] **Step 6: Проверка**

Run: `cd apps/api && pnpm typecheck && pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/startup-lock.ts apps/api/test/startup-lock.int.test.ts apps/api/src/server.ts
git commit -m "feat(api): schema and template-file migrations at startup under advisory lock 726100003

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Агент бэкапа — общий Redis, SSL к Postgres, пароль Redis, S3 без ключей

**Files:**
- Create: `apps/backup-agent/src/url-password.ts`, `apps/backup-agent/src/url-password.test.ts`
- Modify: `apps/backup-agent/src/steps.ts`, `apps/backup-agent/src/steps.test.ts`, `apps/backup-agent/src/config.ts`, `apps/backup-agent/src/config.test.ts`, `apps/backup-agent/src/main.ts`, `docker/backup/lib.sh`, `apps/backup-agent/test/agent.int.test.ts`

**Interfaces:**
- Consumes: ничего из Task 1–2 (агент — отдельный пакет; `withPassword` копируется, как общие константы в Плане 15).
- Produces: env агента `REDIS_PASSWORD`, `PGSSLMODE` (`disable` | `require` | `verify-ca` | `verify-full`), `PGSSLROOTCERT` (путь к CA); `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` необязательны (оба или ни одного). Их задаёт чарт (Task 6).
- `pgConnection(env)` теперь возвращает ещё `ssl: false | { rejectUnauthorized: boolean; ca?: string; checkServerIdentity?: () => undefined }` и бросает `Error` с текстом `PGSSLMODE: …` на неподдерживаемом режиме.

- [ ] **Step 1: Тест `flushExcept` на общем Redis**

В `apps/backup-agent/src/steps.test.ts` заменить тело `describe('flushExcept', …)` на:

```ts
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
    const fake = fakeRedis([MAINTENANCE_KEY, ...Array.from({ length: 1200 }, (_, i) => `cr:k${i}`)]);
    expect(await flushExcept(fake as unknown as Redis, MAINTENANCE_KEY)).toBe(1200);
    expect([...fake.keys]).toEqual([MAINTENANCE_KEY]);
    expect(fake.calls.every((a) => a.join(' ') === 'MATCH cr:* COUNT 500')).toBe(true);
  });

  it('общий внешний Redis: чужие ключи не трогаются', async () => {
    const fake = fakeRedis([MAINTENANCE_KEY, 'cr:rl:1', 'session:abc', 'other-app:cache', 'crx:1']);
    expect(await flushExcept(fake as unknown as Redis, MAINTENANCE_KEY)).toBe(1);
    expect([...fake.keys].sort()).toEqual(['crx:1', MAINTENANCE_KEY, 'other-app:cache', 'session:abc'].sort());
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd apps/backup-agent && pnpm exec vitest run src/steps.test.ts -t flushExcept`
Expected: FAIL — `calls` без `MATCH`, чужие ключи удалены.

- [ ] **Step 3: Реализация**

В `apps/backup-agent/src/steps.ts`:

```ts
/** Ключи приложения в Redis: все начинаются с cr: (§27.5). */
export const APP_KEYS = 'cr:*';

/**
 * Удаляет ключи приложения (cr:*), кроме keep: SCAN MATCH по страницам и UNLINK (§26.2, фаза redis).
 * Внешний Redis может быть общим с другими сервисами (§27.5) — чужие ключи не трогаются.
 */
export async function flushExcept(redis: Redis, keep: string): Promise<number> {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', APP_KEYS, 'COUNT', 500);
    cursor = next;
    const victims = keys.filter((k) => k !== keep);
    if (victims.length > 0) removed += await redis.unlink(...victims);
  } while (cursor !== '0');
  return removed;
}
```

Run: `cd apps/backup-agent && pnpm exec vitest run src/steps.test.ts` → PASS.

- [ ] **Step 4: Тесты пароля Redis и SSL к Postgres**

`apps/backup-agent/src/url-password.test.ts` — копия `apps/api/src/lib/url-password.test.ts` из Task 1 без теста про `pg` (pg-клиента агент собирает из PG*), с импортом `./url-password`:

```ts
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { withPassword } from './url-password';

const NASTY = 'p@ss/w:rd#%?&=+ пароль';

describe('withPassword', () => {
  it('без пароля URL не меняется', () => {
    expect(withPassword('redis://:pw@redis:6379', undefined)).toBe('redis://:pw@redis:6379');
  });
  it('ioredis получает пароль со спецсимволами без искажений', () => {
    const r = new Redis(withPassword('redis://redis.example:6380/2', NASTY), { lazyConnect: true });
    expect(r.options).toMatchObject({ password: NASTY, host: 'redis.example', port: 6380, db: 2 });
    r.disconnect();
  });
  it('не URL — ошибка без пароля в тексте', () => {
    expect(() => withPassword('not a url', 'secret-value')).toThrow('нужен URL');
    expect(() => withPassword('not a url', 'secret-value')).not.toThrow(/secret-value/);
  });
});
```

`apps/backup-agent/src/url-password.ts` — тот же код, что `apps/api/src/lib/url-password.ts` (Task 1, Step 3), с дополнительной строкой в комментарии: «Копия apps/api/src/lib/url-password.ts: образ агента не собирается вместе с API (как общие константы, План 15).»

В `apps/backup-agent/src/config.test.ts`:

1. В тесте `pgConnection` «значения по умолчанию — как в backup.sh» ожидание дополнить `ssl: false`.
2. Добавить:

```ts
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
    expect(pgConnection({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: join(dir, 'ca.crt') }).ssl).toEqual({
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
      loadAgentConfig({ ...base, REDIS_URL: 'redis://redis:6379', REDIS_PASSWORD: 'r@d/s#' }).redisUrl,
    ).toBe('redis://:r%40d%2Fs%23@redis:6379');
  });
});
```

(импорты в начале файла: `import { mkdtemp, rm, writeFile } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';`).

- [ ] **Step 5: Запустить — падают**

Run: `cd apps/backup-agent && pnpm exec vitest run src/config.test.ts src/url-password.test.ts`
Expected: FAIL — нет `ssl`, `url-password`, пароль не вставляется.

- [ ] **Step 6: Реализация `config.ts`**

1. Импорты: `import { readFileSync } from 'node:fs'; import { withPassword } from './url-password';`
2. В `Env`: `REDIS_PASSWORD: z.string().optional(),`
3. В `loadAgentConfig`: `redisUrl: withPassword(e.REDIS_URL, e.REDIS_PASSWORD),` — `withPassword` бросает «нужен URL…» без значений; обернуть так, чтобы сообщение было в формате агента:

```ts
  let redisUrl: string;
  try {
    redisUrl = withPassword(e.REDIS_URL, e.REDIS_PASSWORD);
  } catch (err) {
    throw new Error(`Неверная конфигурация агента: REDIS_URL: ${(err as Error).message}`);
  }
```

и `redisUrl,` в возвращаемом объекте.
4. `PgConnection` и `pgConnection`:

```ts
export type PgSsl =
  | false
  | { rejectUnauthorized: boolean; ca?: string; checkServerIdentity?: () => undefined };

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  database: string;
  password?: string;
  ssl: PgSsl;
}

/**
 * SSL пула агента — как у libpq (pg_dump, psql в тех же скриптах читают PGSSLMODE сами):
 * require — шифрование без проверки, verify-ca — цепочка без имени хоста, verify-full — цепочка и имя.
 */
function pgSsl(env: NodeJS.ProcessEnv): PgSsl {
  const mode = env.PGSSLMODE || 'disable';
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode !== 'verify-ca' && mode !== 'verify-full')
    throw new Error('PGSSLMODE: поддерживаются disable, require, verify-ca, verify-full');
  let ca: string | undefined;
  if (env.PGSSLROOTCERT) {
    try {
      ca = readFileSync(env.PGSSLROOTCERT, 'utf8');
    } catch {
      throw new Error(`PGSSLROOTCERT: не удалось прочитать ${env.PGSSLROOTCERT}`);
    }
  }
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
    ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
  };
}

/** Подключение агента к базе приложения: те же PG* и умолчания, что у backup.sh. */
export function pgConnection(env: NodeJS.ProcessEnv): PgConnection {
  return {
    host: env.PGHOST || 'postgres',
    port: Number(env.PGPORT || 5432),
    user: env.PGUSER || 'app',
    database: env.PGDATABASE || 'app',
    password: env.PGPASSWORD,
    ssl: pgSsl(env),
  };
}
```

5. `main.ts`: ошибки `pgConnection` — тоже выход с кодом 2 и сообщением:

```ts
let cfg: AgentConfig;
let pgConn: PgConnection;
try {
  cfg = loadAgentConfig(process.env);
  pgConn = pgConnection(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
```

(импорт `type PgConnection` из `./config`), и `new pg.Pool({ ...pgConn, max: 2, application_name: 'backup-agent' })`.

Если в `apps/backup-agent/src` есть другие вызовы `pgConnection(` (`grep -rn "pgConnection(" apps/backup-agent/src`), они получают `ssl` автоматически — проверить, что типы сходятся.

- [ ] **Step 7: Запустить — проходят**

Run: `cd apps/backup-agent && pnpm exec vitest run && pnpm typecheck`
Expected: PASS (на macOS 3 теста замка пропускаются — так и должно быть).

- [ ] **Step 8: Тест S3 без ключей в образе**

`docker/backup/lib.sh` вызывается в контейнере агента; тест — в `apps/backup-agent/test/agent.int.test.ts`, внутри `describe('агент бэкапа в образе', …)` после теста «неверный BACKUP_CRON…»:

```ts
  it('S3 без ключей: rclone берёт учётные данные из окружения (env_auth); один ключ — код 2', async () => {
    const none = await agent.sh(
      '. /backup/lib.sh && export S3_ACCESS_KEY_ID= S3_SECRET_ACCESS_KEY= && check_storage_backend && s3_env && echo "auth=$RCLONE_CONFIG_S3_ENV_AUTH key=[${RCLONE_CONFIG_S3_ACCESS_KEY_ID:-}]"',
    );
    expect(none.output).toContain('auth=true key=[]');
    const keys = await agent.sh('. /backup/lib.sh && check_storage_backend && s3_env && echo "auth=$RCLONE_CONFIG_S3_ENV_AUTH"');
    expect(keys.output).toContain('auth=false');
    const one = await agent.sh(
      '(. /backup/lib.sh && export S3_SECRET_ACCESS_KEY= && check_storage_backend); echo "rc=$?"',
    );
    expect(one.output).toContain(
      'S3_ACCESS_KEY_ID и S3_SECRET_ACCESS_KEY задаются вместе (или ни один — учётные данные из окружения, IRSA)',
    );
    expect(one.output).toContain('rc=2');
  });
```

- [ ] **Step 9: Реализация `lib.sh`**

Комментарий над `check_storage_backend` заменить на:

```sh
# check_storage_backend: STORAGE_BACKEND — local (по умолчанию, каталог /data) или s3 (бакет через
# rclone). Для s3 нужны S3_BUCKET и rclone в образе; ключи S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY —
# оба или ни одного (без них rclone берёт учётные данные из окружения: IRSA в k8s).
# Иначе — сообщение и выход с кодом 2.
```

В ветке `s3)` две строки с проверками `S3_ACCESS_KEY_ID` и `S3_SECRET_ACCESS_KEY` заменить на (проверка `S3_BUCKET` и `rclone` остаются):

```sh
      case "${S3_ACCESS_KEY_ID:+1}${S3_SECRET_ACCESS_KEY:+1}" in
        1) echo "S3_ACCESS_KEY_ID и S3_SECRET_ACCESS_KEY задаются вместе (или ни один — учётные данные из окружения, IRSA)" >&2; exit 2 ;;
      esac
```

(`1` — ровно одна переменная непуста; `11` — обе; пусто — ни одной).

В `s3_env` заменить три строки с `ENV_AUTH`/ключами:

```sh
  # Без ключей — учётные данные из окружения (переменные AWS_*, IRSA в k8s).
  if [ -n "${S3_ACCESS_KEY_ID:-}" ]; then
    RCLONE_CONFIG_S3_ENV_AUTH=false
    RCLONE_CONFIG_S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
    RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
  else
    RCLONE_CONFIG_S3_ENV_AUTH=true
    RCLONE_CONFIG_S3_ACCESS_KEY_ID=
    RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=
  fi
```

Комментарий над `s3_env` дополнить: «Без ключей — env_auth (IRSA).»

- [ ] **Step 10: Интеграционные тесты агента**

Run: `cd apps/backup-agent && pnpm test:int`
Expected: PASS, 12 tests (образ пересобирается — `lib.sh` в нём). Фаза `redis` восстановления (тест «восстановление: база, файлы и Redis из бэкапа…») по-прежнему проходит: ключи теста начинаются с `cr:`. Если тест кладёт в Redis ключи без префикса `cr:` и ждёт их удаления — это изменённое поведение по §27.5: переименовать ключи теста в `cr:…` и добавить в этот же тест ключ `foreign:key`, который после восстановления остаётся.

- [ ] **Step 11: Commit**

```bash
git add apps/backup-agent/src docker/backup/lib.sh apps/backup-agent/test/agent.int.test.ts
git commit -m "feat(backup-agent): restore flushes only cr:* keys, PGSSLMODE/PGSSLROOTCERT, REDIS_PASSWORD, S3 env_auth without keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Образ web — режимы nginx `tls` / `http` / `dev`, адреса из окружения

**Files:**
- Rename: `docker/nginx/common.conf` → `docker/nginx/templates/common.conf.template`; `docker/nginx/prod.conf` → `docker/nginx/server-tls.conf`; `docker/nginx/dev.conf` → `docker/nginx/server-dev.conf`
- Create: `docker/nginx/server-http.conf`, `docker/nginx/15-carbone-reports.envsh`, `apps/web/test/nginx.int.test.ts`, `apps/web/vitest.int.config.ts`
- Modify: `docker/web.Dockerfile`, `docker-compose.dev.yml`, `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/tsconfig.json` (если `test/` не входит в `include`)

**Interfaces:**
- Produces: env образа web `NGINX_MODE` (`tls` по умолчанию | `http` | `dev`), `API_UPSTREAM` (по умолчанию `http://api:3000`), `ONLYOFFICE_UPSTREAM` (по умолчанию `http://onlyoffice`), необязательный `NGINX_RESOLVER` (по умолчанию — первый `nameserver` из `/etc/resolv.conf`); стадия Dockerfile `nginx` (конфигурация без SPA). Чарт (Task 5) ставит `NGINX_MODE=http` и полные имена сервисов.

- [ ] **Step 1: Переименования (без изменения содержимого)**

```bash
mkdir -p docker/nginx/templates
git mv docker/nginx/common.conf docker/nginx/templates/common.conf.template
git mv docker/nginx/prod.conf docker/nginx/server-tls.conf
git mv docker/nginx/dev.conf docker/nginx/server-dev.conf
```

- [ ] **Step 2: Интеграционный тест**

`apps/web/vitest.int.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    // Сборка стадии nginx образа web — до пары минут при первом запуске.
    hookTimeout: 600_000,
  },
});
```

`apps/web/package.json`: в `scripts` добавить `"test:int": "vitest run --config vitest.int.config.ts"`; в `devDependencies` — `"testcontainers": "^12.2.0"` (та же версия, что у api); `pnpm install`.

`apps/web/vite.config.ts`, блок `test`: добавить `include: ['src/**/*.test.{ts,tsx}'],` — модульные тесты не должны подхватывать `test/*.int.test.ts`.

`apps/web/test/nginx.int.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const IMAGE = 'carbone-reports-web-nginx:it';
const INDEX = '<!doctype html><title>stub</title>';

let network: StartedNetwork;
let upstream: StartedTestContainer;
const started: StartedTestContainer[] = [];
let certs: string;

/** Заглушка API и OnlyOffice: nginx отвечает своим именем на любой путь. */
const STUB_CONF = `server {
  listen 3000; location / { return 200 "api-stub $request_uri"; }
}
server {
  listen 80; location / { return 200 "oo-stub $request_uri"; }
}`;

beforeAll(async () => {
  await GenericContainer.fromDockerfile(ROOT, 'docker/web.Dockerfile')
    .withTarget('nginx')
    .build(IMAGE, { deleteOnExit: false });
  network = await new Network().start();
  // Имена как в k8s: полное имя сервиса с точками (резолвер nginx не применяет домены поиска).
  upstream = await new GenericContainer('nginx:1.30-alpine')
    .withCopyContentToContainer([{ content: STUB_CONF, target: '/etc/nginx/conf.d/default.conf' }])
    .withNetwork(network)
    .withNetworkAliases('cr-api.ns.svc.cluster.local', 'cr-onlyoffice.ns.svc.cluster.local', 'api', 'onlyoffice')
    .start();
  certs = mkdtempSync(join(tmpdir(), 'web-certs-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(certs, 'privkey.pem'), '-out', join(certs, 'fullchain.pem'),
  ], { stdio: 'ignore' });
}, 600_000);

afterAll(async () => {
  await Promise.all(started.map((c) => c.stop()));
  await upstream?.stop();
  await network?.stop();
  if (certs) rmSync(certs, { recursive: true, force: true });
});

async function web(env: Record<string, string>, opts: { tls?: boolean } = {}) {
  let c = new GenericContainer(IMAGE)
    .withEnvironment(env)
    .withNetwork(network)
    .withCopyContentToContainer([{ content: INDEX, target: '/usr/share/nginx/html/index.html' }])
    .withExposedPorts(...(opts.tls ? [80, 443] : [80]))
    .withWaitStrategy(Wait.forListeningPorts());
  if (opts.tls)
    c = c.withCopyFilesToContainer([
      { source: join(certs, 'fullchain.pem'), target: '/etc/nginx/certs/fullchain.pem' },
      { source: join(certs, 'privkey.pem'), target: '/etc/nginx/certs/privkey.pem' },
    ]);
  const s = await c.start();
  started.push(s);
  return s;
}
const url = (c: StartedTestContainer, port: number, path: string) =>
  `http://${c.getHost()}:${c.getMappedPort(port)}${path}`;

describe('образ web: nginx', () => {
  it('http (k8s): /api и /onlyoffice по полным именам сервисов, резолвер из resolv.conf, HSTS, CSP', async () => {
    const c = await web({
      NGINX_MODE: 'http',
      API_UPSTREAM: 'http://cr-api.ns.svc.cluster.local:3000',
      ONLYOFFICE_UPSTREAM: 'http://cr-onlyoffice.ns.svc.cluster.local',
    });
    const api = await fetch(url(c, 80, '/api/health'));
    expect(await api.text()).toBe('api-stub /api/health');
    expect(api.headers.get('strict-transport-security')).toBe('max-age=31536000');
    const oo = await fetch(url(c, 80, '/onlyoffice/healthcheck'));
    expect(await oo.text()).toBe('oo-stub /healthcheck');
    const page = await fetch(url(c, 80, '/'), { redirect: 'manual' });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(page.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect((await fetch(url(c, 80, '/internal/x'))).status).toBe(404);
    const conf = await c.exec(['cat', '/etc/nginx/snippets/common.conf']);
    const ns = (await c.exec(['awk', '$1 == "nameserver" { print $2; exit }', '/etc/resolv.conf'])).output.trim();
    expect(conf.output).toContain(`resolver ${ns} valid=10s ipv6=off;`);
    // Переменные nginx не тронуты envsubst.
    expect(conf.output).toContain('proxy_set_header Host $http_host;');
  });

  it('tls (compose, по умолчанию): 80 → 301 на https, 443 с сертификатами, адреса api/onlyoffice по умолчанию', async () => {
    const c = await web({}, { tls: true });
    const plain = await fetch(url(c, 80, '/x'), { redirect: 'manual' });
    expect(plain.status).toBe(301);
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get(
          { host: c.getHost(), port: c.getMappedPort(443), path: '/api/me', rejectUnauthorized: false },
          (res) => {
            let s = '';
            res.on('data', (d) => (s += d));
            res.on('end', () => resolve(s));
          },
        )
        .on('error', reject);
    });
    expect(body).toBe('api-stub /api/me');
  });

  it('dev: только HTTP, без HSTS', async () => {
    const c = await web({ NGINX_MODE: 'dev' });
    const page = await fetch(url(c, 80, '/'));
    expect(page.status).toBe(200);
    expect(page.headers.get('strict-transport-security')).toBeNull();
  });

  it('неверный NGINX_MODE — понятная ошибка и ненулевой код', async () => {
    const c = await web({ NGINX_MODE: 'http' });
    const r = await c.exec(['sh', '-c', 'NGINX_MODE=bogus; . /docker-entrypoint.d/15-carbone-reports.envsh; echo "rc=$?"']);
    expect(r.output).toContain('NGINX_MODE: ожидается tls, http или dev');
    expect(r.output).not.toContain('rc=0');
  });

  it('шаблон и режимы в репозитории — те же файлы, что копирует Dockerfile', () => {
    const df = readFileSync(join(ROOT, 'docker/web.Dockerfile'), 'utf8');
    for (const f of ['templates/', 'server-tls.conf', 'server-http.conf', 'server-dev.conf', '15-carbone-reports.envsh'])
      expect(df).toContain(`docker/nginx/${f}`);
  });
});
```

- [ ] **Step 3: Запустить — падает**

Run: `cd apps/web && pnpm test:int`
Expected: FAIL — в Dockerfile нет стадии `nginx` (`target stage "nginx" could not be found`).

- [ ] **Step 4: Конфигурация nginx**

`docker/nginx/templates/common.conf.template` — три правки, остальное как было:

```nginx
# Резолвер — первый nameserver из /etc/resolv.conf (15-carbone-reports.envsh): встроенный DNS Docker
# в compose, DNS кластера в k8s. Адреса api и onlyoffice перерезолвятся без перезапуска nginx.
resolver ${NGINX_RESOLVER} valid=10s ipv6=off;
```

```nginx
    set $api_upstream ${API_UPSTREAM};
```

```nginx
    set $oo_upstream ${ONLYOFFICE_UPSTREAM};
```

`docker/nginx/server-http.conf`:

```nginx
# NGINX_MODE=http (чарт Helm): TLS завершает Ingress, nginx слушает только 80 без редиректа.
# HSTS отдаётся, как при TLS на nginx: браузер видит https-адрес Ingress.
server {
    listen 80;
    server_name _;

    add_header Strict-Transport-Security "max-age=31536000" always;

    set $hsts "max-age=31536000";
    include /etc/nginx/snippets/common.conf;
}
```

В начало `server-tls.conf` добавить строку `# NGINX_MODE=tls (по умолчанию, compose): 80 → 301, TLS на 443 с сертификатами из /etc/nginx/certs.`, в начало `server-dev.conf` — `# NGINX_MODE=dev (docker-compose.dev.yml): только HTTP, без HSTS.`

`docker/nginx/15-carbone-reports.envsh` (исполняемый; официальный `/docker-entrypoint.sh` сорсит `*.envsh` до `20-envsubst-on-templates.sh`):

```sh
#!/bin/sh
# Конфигурация nginx при старте контейнера (сорсится /docker-entrypoint.sh официального образа
# до 20-envsubst-on-templates.sh). set -e не меняем: файл выполняется в оболочке точки входа.
# NGINX_MODE — какой server подключить: tls (compose), http (k8s, TLS на Ingress), dev.
case "${NGINX_MODE:-tls}" in
  tls | http | dev) cp "/etc/nginx/modes/server-${NGINX_MODE:-tls}.conf" /etc/nginx/conf.d/default.conf ;;
  *)
    echo "NGINX_MODE: ожидается tls, http или dev" >&2
    exit 1
    ;;
esac
# NGINX_RESOLVER — DNS для proxy_pass с переменными: по умолчанию первый nameserver контейнера.
if [ -z "${NGINX_RESOLVER:-}" ]; then
  NGINX_RESOLVER=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf)
  if [ -z "$NGINX_RESOLVER" ]; then
    echo "в /etc/resolv.conf нет nameserver: задайте NGINX_RESOLVER" >&2
    exit 1
  fi
  case $NGINX_RESOLVER in *:*) NGINX_RESOLVER="[$NGINX_RESOLVER]" ;; esac
fi
export NGINX_RESOLVER
```

- [ ] **Step 5: Dockerfile**

`docker/web.Dockerfile` — последняя стадия заменяется двумя:

```dockerfile
# Конфигурация nginx без SPA (стадию собирает тест apps/web/test/nginx.int.test.ts).
FROM nginx:1.30-alpine AS nginx
# common.conf — шаблон envsubst: подставляются только эти переменные, $host и прочие переменные nginx не трогаются.
ENV NGINX_MODE=tls \
    API_UPSTREAM=http://api:3000 \
    ONLYOFFICE_UPSTREAM=http://onlyoffice \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/snippets \
    NGINX_ENVSUBST_FILTER='^(NGINX_RESOLVER|API_UPSTREAM|ONLYOFFICE_UPSTREAM)$'
COPY docker/nginx/maps.conf /etc/nginx/conf.d/00-maps.conf
COPY docker/nginx/templates/ /etc/nginx/templates/
COPY docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker/nginx/server-tls.conf docker/nginx/server-http.conf docker/nginx/server-dev.conf /etc/nginx/modes/
COPY --chmod=755 docker/nginx/15-carbone-reports.envsh /docker-entrypoint.d/15-carbone-reports.envsh

FROM nginx
COPY --from=build /repo/apps/web/dist/ /usr/share/nginx/html/
```

`docker-compose.dev.yml`, сервис `web`: вместо монтирования `dev.conf`:

```yaml
  web:
    ports: !override
      - '127.0.0.1:${WEB_DEV_PORT:-8080}:80'
    volumes: !override []
    environment:
      NGINX_MODE: dev
```

- [ ] **Step 6: Запустить — проходит**

Run: `cd apps/web && pnpm test:int && pnpm test && pnpm typecheck`
Expected: PASS — 5 интеграционных тестов; модульные тесты web — прежнее число (интеграционный файл не подхвачен). Если `pnpm typecheck` не видит `test/` — добавить `"test"` в `include` `apps/web/tsconfig.json`, только если там уже не указан весь каталог; если типы DOM/jsdom конфликтуют с node-типами в тесте — оставить `test/` вне tsconfig и положиться на eslint (так сделано для `vitest.int.config.ts` в других пакетах — проверить `apps/api/tsconfig.json`).

- [ ] **Step 7: Живой стек compose не сломан**

Run (диск ≥ 5 GiB свободно — `df -h /`):

```bash
docker compose build web && docker compose up -d web && sleep 5 && docker compose ps web
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:${WEB_HTTPS_PORT:-443}/api/health
```

Expected: `web` в состоянии running, `200`. (На этой машине стек поднят на порту 8443: `WEB_HTTPS_PORT=8443` из `.env`.) После проверки: `docker builder prune -f`.

- [ ] **Step 8: Commit**

```bash
git add docker/nginx docker/web.Dockerfile docker-compose.dev.yml apps/web/test apps/web/vitest.int.config.ts apps/web/package.json apps/web/vite.config.ts pnpm-lock.yaml
git add apps/web/tsconfig.json 2>/dev/null || true
git commit -m "feat(web): nginx modes tls/http/dev, upstreams and resolver from environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Чарт — каркас, секреты, настройки, api, web, Ingress, инструменты проверки

**Files:**
- Create: `charts/carbone-reports/Chart.yaml`, `values.yaml`, `.helmignore`, `templates/_helpers.tpl`, `templates/_validate.tpl`, `templates/NOTES.txt`, `templates/serviceaccount.yaml`, `templates/secret.yaml`, `templates/configmap-api.yaml`, `templates/api.yaml`, `templates/web.yaml`, `templates/ingress.yaml`, `files/s3-entrypoint.sh`, `tests/api_test.yaml`, `tests/web_ingress_test.yaml`, `tests/secret_test.yaml`, `tests/validate_test.yaml`, `ci/external-values.yaml`, `scripts/chart.sh`
- Modify: `package.json` (скрипт `chart:check`), `.prettierignore`

**Interfaces:**
- Consumes: env API из Task 1 (`DATABASE_PASSWORD`, `REDIS_PASSWORD`, `TRUSTED_PROXY_HOPS`, необязательные ключи S3); env образа web из Task 4 (`NGINX_MODE`, `API_UPSTREAM`, `ONLYOFFICE_UPSTREAM`).
- Produces (helpers в `_helpers.tpl`, ими пользуются Task 6–8): `cr.fullname`, `cr.component` (`dict "root" . "name" "<компонент>"`), `cr.labels`, `cr.selectorLabels` (`dict "root" . "component" "<компонент>"`), `cr.image` (`dict "root" . "name" "api|web|backup"`), `cr.secretName`, `cr.secretEnv` (`dict "root" . "env" "<ENV>" "key" "<KEY>" "optional" <bool>`), `cr.serviceAccountName`, `cr.podDefaults`, `cr.scheduling`, `cr.fqdn` (`dict "root" . "name" "<компонент>"`), `cr.databaseUrl`, `cr.db.host|port|name|user|sslMode|caPath`, `cr.redisUrl`, `cr.s3Config`, `cr.carboneUrl`, `cr.onlyofficeUrl`, `cr.validate`.
- Имена Service: `<fullname>-api:3000`, `<fullname>-web:80`, `<fullname>-carbone:4000`, `<fullname>-onlyoffice:80`, `<fullname>-backup-agent:8080`, `<fullname>-postgresql:5432`, `<fullname>-redis:6379`, `<fullname>-s3:8333` — шаблоны последних пяти появятся в Task 6–7, адреса используются уже здесь.

- [ ] **Step 1: Инструменты проверки**

`scripts/chart.sh`:

```sh
#!/bin/sh
# Проверки чарта через Docker-образы с закреплёнными версиями — локально и в CI одинаково (§27.9):
#   sh scripts/chart.sh [files|lint|unittest|kubeconform|all]
set -eu
cd "$(dirname "$0")/.."
CHART=charts/carbone-reports
HELM_IMAGE=alpine/helm:4.3.0
UNITTEST_IMAGE=helmunittest/helm-unittest:4.3.0-1.2.1
KUBECONFORM_IMAGE=ghcr.io/yannh/kubeconform:v0.8.0
K8S_VERSION=1.33.0

helm() { docker run --rm -v "$PWD:/apps" -w /apps "$HELM_IMAGE" "$@"; }

# Скрипт SeaweedFS в чарте — копия docker/s3/entrypoint.sh (чарт не читает файлы вне своего каталога).
files() {
  cmp -s docker/s3/entrypoint.sh "$CHART/files/s3-entrypoint.sh" || {
    echo "$CHART/files/s3-entrypoint.sh расходится с docker/s3/entrypoint.sh: скопируйте файл" >&2
    exit 1
  }
}
lint() { for v in "$CHART"/ci/*.yaml; do helm lint --strict "$CHART" -f "$v"; done; }
unittest() { docker run --rm -v "$PWD:/apps" -w /apps "$UNITTEST_IMAGE" "$CHART"; }
kubeconform() {
  for v in "$CHART"/ci/*.yaml; do
    echo "== kubeconform: $v"
    helm template cr "$CHART" -f "$v" --namespace cr |
      docker run --rm -i "$KUBECONFORM_IMAGE" -strict -summary -kubernetes-version "$K8S_VERSION" -
  done
}

case "${1:-all}" in
  files) files ;;
  lint) lint ;;
  unittest) unittest ;;
  kubeconform) kubeconform ;;
  all) files && lint && unittest && kubeconform ;;
  *)
    echo "использование: sh scripts/chart.sh [files|lint|unittest|kubeconform|all]" >&2
    exit 2
    ;;
esac
```

`package.json` (корень), `scripts`: `"chart:check": "sh scripts/chart.sh all",`.

`.prettierignore`: добавить строку `charts/carbone-reports/templates/` (шаблоны Go — не YAML).

`charts/carbone-reports/files/s3-entrypoint.sh`: `cp docker/s3/entrypoint.sh charts/carbone-reports/files/s3-entrypoint.sh` (нужен в Task 7; копируется сейчас, чтобы `files` проходил с первого дня).

- [ ] **Step 2: Каркас чарта**

`charts/carbone-reports/Chart.yaml`:

```yaml
apiVersion: v2
name: carbone-reports
description: Отчёты Carbone с веб-интерфейсом и редактором шаблонов OnlyOffice
type: application
# На тег vX.Y.Z CI публикует чарт с version и appVersion X.Y.Z (§27.8).
version: 0.1.0
appVersion: '0.1.0'
kubeVersion: '>=1.27.0-0'
home: https://github.com/SamRozhkov/carbone-report
sources:
  - https://github.com/SamRozhkov/carbone-report
```

`charts/carbone-reports/.helmignore`:

```
tests/
ci/
.DS_Store
*.swp
```

`charts/carbone-reports/values.yaml` (полностью; комментарии — часть документации значений):

```yaml
# Значения чарта carbone-reports (спецификация §27). «Обязательно» — без значения helm install
# остановится с ошибкой, называющей это значение.

nameOverride: ''
fullnameOverride: ''
# Домен кластера: web обращается к api и onlyoffice по полным именам сервисов
# (резолвер nginx не применяет домены поиска).
clusterDomain: cluster.local

image:
  registry: ghcr.io/samrozhkov
  # Общий тег образов api, web и backup; пусто — appVersion чарта. Отдельного тега у агента нет:
  # он накатывает миграции из своего образа, версии api и агента должны совпадать.
  tag: ''
  pullPolicy: IfNotPresent
# Пакеты GHCR приватные, пока их не сделали публичными: [{ name: ghcr-pull }].
imagePullSecrets: []

serviceAccount:
  create: true
  name: ''
  # IRSA (S3 без ключей): eks.amazonaws.com/role-arn: arn:aws:iam::<account>:role/<role>
  annotations: {}

# Готовый Secret с ключами из таблицы README («Kubernetes (Helm)»). Задан — secrets.* не используются.
existingSecret: ''
secrets:
  # Обязательно, не короче 32 символов.
  appSecret: ''
  # Обязательно: 32 байта в base64 (openssl rand -base64 32).
  encryptionKey: ''
  # Обязательно, не короче 32 символов.
  onlyofficeJwtSecret: ''
  # Обязательно: первый администратор (создаётся, пока в базе нет пользователей).
  adminLogin: ''
  # Обязательно, не короче 8 символов.
  adminPassword: ''
  # Обязательно: пароль пользователя Postgres (встроенного или внешнего); любые символы.
  postgresPassword: ''
  # Обязательно: пароль Redis. Для встроенного Redis — только шестнадцатеричные символы (openssl rand -hex 32).
  redisPassword: ''
  # Обязательно, не короче 32 символов: токен агента бэкапа.
  backupAgentToken: ''
  # Встроенный s3 — обязательно оба (A-Z, a-z, 0-9 и . _ ~ + / = -). Внешний — оба или ни одного (IRSA).
  s3AccessKeyId: ''
  s3SecretAccessKey: ''
  # Пароль привязки LDAP (config.ldap.bindDn).
  ldapBindPassword: ''

config:
  tz: Europe/Moscow
  queryTimeoutMs: 30000
  queryMaxRows: 100000
  renderTimeoutMs: 120000
  reportTimeoutMs: 120000
  reportRetentionDays: 30
  # Прокси перед API: Ingress и nginx образа web (1–5).
  trustedProxyHops: 2
  # Cookie сессии только по HTTPS. false — лишь для пробной установки без TLS.
  cookieSecure: true
  ldap:
    enabled: false
    url: ''
    bindDn: ''
    baseDn: ''
    userFilter: '(uid=%s)'
    defaultRole: user
    tlsRejectUnauthorized: true

ingress:
  enabled: true
  className: ''
  # Обязательно при ingress.enabled: например reports.example.com.
  host: ''
  # ingress-nginx — без этих аннотаций не работает загрузка в OnlyOffice:
  #   nginx.ingress.kubernetes.io/proxy-body-size: 100m
  #   nginx.ingress.kubernetes.io/proxy-read-timeout: '300'
  #   nginx.ingress.kubernetes.io/proxy-send-timeout: '300'
  annotations: {}
  tls:
    # Secret с сертификатом (cert-manager или свой). Пусто — Ingress без TLS.
    secretName: ''

web:
  replicas: 2
  resources:
    requests: { cpu: 50m, memory: 64Mi }
    limits: { memory: 256Mi }
  nodeSelector: {}
  tolerations: []
  affinity: {}
  podAnnotations: {}
  extraEnv: []

api:
  replicas: 2
  resources:
    requests: { cpu: 200m, memory: 256Mi }
    limits: { memory: 1Gi }
  nodeSelector: {}
  tolerations: []
  affinity: {}
  podAnnotations: {}
  extraEnv: []

carbone:
  enabled: true
  image: carbone/carbone-ee:full-5.15.3-fonts
  # При carbone.enabled=false — адрес внешнего Carbone, например http://carbone.example:4000.
  url: ''
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits: { memory: 2Gi }
  nodeSelector: {}
  tolerations: []
  affinity: {}
  podAnnotations: {}
  extraEnv: []

onlyoffice:
  enabled: true
  image: onlyoffice/documentserver:9.4.0.1
  # При onlyoffice.enabled=false — адрес Document Server изнутри кластера.
  internalUrl: ''
  persistence:
    size: 10Gi
    storageClass: ''
  resources:
    requests: { cpu: 500m, memory: 2Gi }
    limits: { memory: 4Gi }
  nodeSelector: {}
  tolerations: []
  affinity: {}
  podAnnotations: {}
  extraEnv: []

backup:
  cron: '0 3 * * *'
  keep: 14
  # Срок каждого шага бэкапа, секунды.
  timeout: 3600
  persistence:
    # Том с бэкапами не удаляется при helm uninstall (helm.sh/resource-policy: keep).
    size: 20Gi
    storageClass: ''
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }
  nodeSelector: {}
  tolerations: []
  affinity: {}
  podAnnotations: {}
  extraEnv: []

# Встроенный Postgres — для пробной установки; для прода — externalDatabase.
postgresql:
  enabled: false
  image: postgres:17-alpine
  database: app
  user: app
  persistence:
    size: 10Gi
    storageClass: ''
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }
externalDatabase:
  # Обязательно при postgresql.enabled=false.
  host: ''
  port: 5432
  database: app
  user: app
  # disable | require | verify-ca | verify-full — как в libpq.
  sslMode: disable
  # Secret с сертификатом CA для verify-ca/verify-full (частный CA).
  caSecret:
    name: ''
    key: ca.crt

# Встроенный Redis (без персистентности, как в compose).
redis:
  enabled: false
  image: redis:7-alpine
  resources:
    requests: { cpu: 50m, memory: 64Mi }
    limits: { memory: 256Mi }
externalRedis:
  # Обязательно при redis.enabled=false: URL без пароля (пароль — secrets.redisPassword), rediss:// — TLS.
  url: ''

# Встроенный S3 (SeaweedFS).
s3:
  enabled: false
  image: chrislusf/seaweedfs:4.48
  bucket: carbone-reports
  persistence:
    size: 20Gi
    storageClass: ''
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }
externalS3:
  # Пусто — AWS S3 по региону.
  endpoint: ''
  region: us-east-1
  # Обязательно при s3.enabled=false.
  bucket: ''
  forcePathStyle: false
  createBucket: false
  # Провайдер rclone для S3-совместимого хранилища (Other, Minio, Ceph…). Пусто: с endpoint — SeaweedFS, без — AWS.
  rcloneProvider: ''

networkPolicy:
  # Повторяет внутренние сети compose (§27.6).
  enabled: false
```

- [ ] **Step 3: Тесты helm-unittest (падают — шаблонов ещё нет)**

`charts/carbone-reports/ci/external-values.yaml` (внешние зависимости, без встроенных; используется lint/kubeconform и как основа тестов):

```yaml
ingress:
  host: reports.example.com
  className: nginx
  tls:
    secretName: reports-tls
secrets:
  appSecret: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  encryptionKey: AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=
  onlyofficeJwtSecret: oooooooooooooooooooooooooooooooooooooooo
  adminLogin: admin
  adminPassword: admin-password
  postgresPassword: 'p@ss/w:rd#%'
  redisPassword: redis-password
  backupAgentToken: tttttttttttttttttttttttttttttttttttttttt
externalDatabase:
  host: pg.example.com
  sslMode: verify-full
  caSecret:
    name: pg-ca
externalRedis:
  url: rediss://redis.example.com:6380
externalS3:
  endpoint: https://storage.example.com
  bucket: reports
  forcePathStyle: true
  rcloneProvider: Other
```

`charts/carbone-reports/tests/api_test.yaml`:

```yaml
suite: api
templates:
  - api.yaml
  - configmap-api.yaml
  - secret.yaml
values:
  - ../ci/external-values.yaml
release:
  name: cr
  namespace: reports
tests:
  - it: Deployment, Service и PDB с именами <fullname>-api
    template: api.yaml
    asserts:
      - hasDocuments: { count: 3 }
      - equal: { path: metadata.name, value: cr-carbone-reports-api }
        documentIndex: 0
      - equal: { path: spec.replicas, value: 2 }
        documentIndex: 0
      - equal: { path: spec.strategy.rollingUpdate, value: { maxUnavailable: 0, maxSurge: 1 } }
        documentIndex: 0
      - isKind: { of: Service }
        documentIndex: 1
      - equal: { path: spec.ports[0].port, value: 3000 }
        documentIndex: 1
      - isKind: { of: PodDisruptionBudget }
        documentIndex: 2
      - equal: { path: spec.minAvailable, value: 1 }
        documentIndex: 2
  - it: одна реплика — без PDB (иначе он блокирует drain узла)
    template: api.yaml
    set: { api.replicas: 1 }
    asserts:
      - hasDocuments: { count: 2 }
  - it: образ ghcr с тегом appVersion по умолчанию и с image.tag
    template: api.yaml
    documentIndex: 0
    asserts:
      - equal: { path: 'spec.template.spec.containers[0].image', value: ghcr.io/samrozhkov/carbone-report-api:0.1.0 }
  - it: image.tag задаёт общий тег
    template: api.yaml
    documentIndex: 0
    set: { image.tag: sha-abc1234 }
    asserts:
      - equal: { path: 'spec.template.spec.containers[0].image', value: ghcr.io/samrozhkov/carbone-report-api:sha-abc1234 }
  - it: пароли — отдельными переменными из Secret; PGPASSWORD в API нет
    template: api.yaml
    documentIndex: 0
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: DATABASE_PASSWORD
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: POSTGRES_PASSWORD } }
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: REDIS_PASSWORD
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: REDIS_PASSWORD } }
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: S3_ACCESS_KEY_ID
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: S3_ACCESS_KEY_ID, optional: true } }
      - notContains:
          path: spec.template.spec.containers[0].env
          content: { name: PGPASSWORD }
          any: true
  - it: безопасность api — restricted
    template: api.yaml
    documentIndex: 0
    asserts:
      - equal:
          path: spec.template.spec.securityContext
          value: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      - equal:
          path: spec.template.spec.containers[0].securityContext
          value: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      - contains:
          path: spec.template.spec.containers[0].volumeMounts
          content: { name: tmp, mountPath: /tmp }
      - equal: { path: spec.template.spec.automountServiceAccountToken, value: false }
  - it: пробы /api/health, startupProbe с запасом на миграции
    template: api.yaml
    documentIndex: 0
    asserts:
      - equal: { path: 'spec.template.spec.containers[0].startupProbe.httpGet.path', value: /api/health }
      - equal: { path: 'spec.template.spec.containers[0].startupProbe.failureThreshold', value: 60 }
      - equal: { path: 'spec.template.spec.containers[0].readinessProbe.httpGet.path', value: /api/health }
      - equal: { path: 'spec.template.spec.containers[0].livenessProbe.httpGet.path', value: /api/health }
  - it: CA внешнего Postgres монтируется и указан в DATABASE_URL
    template: api.yaml
    documentIndex: 0
    asserts:
      - contains:
          path: spec.template.spec.volumes
          content: { name: pg-ca, secret: { secretName: pg-ca, items: [{ key: ca.crt, path: ca.crt }] } }
      - contains:
          path: spec.template.spec.containers[0].volumeMounts
          content: { name: pg-ca, mountPath: /etc/carbone-reports/pg-ca, readOnly: true }
  - it: ConfigMap api — адреса, URL без пароля, S3, доверенные прокси
    template: configmap-api.yaml
    asserts:
      - equal:
          path: data.DATABASE_URL
          value: postgres://app@pg.example.com:5432/app?sslmode=verify-full&uselibpqcompat=true&sslrootcert=/etc/carbone-reports/pg-ca/ca.crt
      - equal: { path: data.REDIS_URL, value: 'rediss://redis.example.com:6380' }
      - equal: { path: data.CARBONE_URL, value: 'http://cr-carbone-reports-carbone:4000' }
      - equal: { path: data.ONLYOFFICE_INTERNAL_URL, value: 'http://cr-carbone-reports-onlyoffice' }
      - equal: { path: data.API_INTERNAL_URL, value: 'http://cr-carbone-reports-api:3000' }
      - equal: { path: data.BACKUP_AGENT_URL, value: 'http://cr-carbone-reports-backup-agent:8080' }
      - equal: { path: data.STORAGE_BACKEND, value: s3 }
      - equal: { path: data.S3_ENDPOINT, value: 'https://storage.example.com' }
      - equal: { path: data.S3_BUCKET, value: reports }
      - equal: { path: data.S3_FORCE_PATH_STYLE, value: 'true' }
      - equal: { path: data.S3_CREATE_BUCKET, value: 'false' }
      - equal: { path: data.TRUSTED_PROXY_HOPS, value: '2' }
      - equal: { path: data.COOKIE_SECURE, value: 'true' }
      - notExists: { path: data.PGHOST }
      - notExists: { path: data.PGSSLMODE }
  - it: sslMode disable — без uselibpqcompat и sslrootcert
    template: configmap-api.yaml
    set: { externalDatabase.sslMode: disable, externalDatabase.caSecret.name: '' }
    asserts:
      - equal: { path: data.DATABASE_URL, value: 'postgres://app@pg.example.com:5432/app?sslmode=disable' }
  - it: изменение настроек меняет checksum/config — поды перезапускаются
    template: api.yaml
    documentIndex: 0
    set: { config.tz: UTC }
    asserts:
      - exists: { path: 'spec.template.metadata.annotations["checksum/config"]' }
      - exists: { path: 'spec.template.metadata.annotations["checksum/secret"]' }
  - it: existingSecret — без checksum/secret, ссылки на чужой Secret
    template: api.yaml
    documentIndex: 0
    set: { existingSecret: my-secret }
    asserts:
      - notExists: { path: 'spec.template.metadata.annotations["checksum/secret"]' }
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: APP_SECRET
            valueFrom: { secretKeyRef: { name: my-secret, key: APP_SECRET } }
```

`charts/carbone-reports/tests/web_ingress_test.yaml`:

```yaml
suite: web и Ingress
templates:
  - web.yaml
  - ingress.yaml
values:
  - ../ci/external-values.yaml
release:
  name: cr
  namespace: reports
tests:
  - it: web — режим http, полные имена api и onlyoffice
    template: web.yaml
    documentIndex: 0
    asserts:
      - equal: { path: spec.replicas, value: 2 }
      - equal: { path: 'spec.template.spec.containers[0].image', value: ghcr.io/samrozhkov/carbone-report-web:0.1.0 }
      - contains: { path: 'spec.template.spec.containers[0].env', content: { name: NGINX_MODE, value: http } }
      - contains:
          path: spec.template.spec.containers[0].env
          content: { name: API_UPSTREAM, value: 'http://cr-carbone-reports-api.reports.svc.cluster.local:3000' }
      - contains:
          path: spec.template.spec.containers[0].env
          content: { name: ONLYOFFICE_UPSTREAM, value: 'http://cr-carbone-reports-onlyoffice.reports.svc.cluster.local' }
  - it: clusterDomain меняет полные имена
    template: web.yaml
    documentIndex: 0
    set: { clusterDomain: corp.local }
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: { name: API_UPSTREAM, value: 'http://cr-carbone-reports-api.reports.svc.corp.local:3000' }
  - it: внешний OnlyOffice — web проксирует на onlyoffice.internalUrl
    template: web.yaml
    documentIndex: 0
    set: { onlyoffice.enabled: false, onlyoffice.internalUrl: 'http://docs.example.com' }
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content: { name: ONLYOFFICE_UPSTREAM, value: 'http://docs.example.com' }
  - it: Service web :80
    template: web.yaml
    documentIndex: 1
    asserts:
      - isKind: { of: Service }
      - equal: { path: spec.ports[0].port, value: 80 }
  - it: Ingress — хост, класс, TLS, всё на web:80
    template: ingress.yaml
    asserts:
      - equal: { path: spec.ingressClassName, value: nginx }
      - equal: { path: 'spec.rules[0].host', value: reports.example.com }
      - equal:
          path: 'spec.rules[0].http.paths[0]'
          value: { path: /, pathType: Prefix, backend: { service: { name: cr-carbone-reports-web, port: { number: 80 } } } }
      - equal: { path: spec.tls, value: [{ hosts: [reports.example.com], secretName: reports-tls }] }
  - it: без tls.secretName — Ingress без TLS
    template: ingress.yaml
    set: { ingress.tls.secretName: '' }
    asserts:
      - notExists: { path: spec.tls }
  - it: ingress.enabled=false — Ingress нет
    template: ingress.yaml
    set: { ingress.enabled: false }
    asserts:
      - hasDocuments: { count: 0 }
```

`charts/carbone-reports/tests/secret_test.yaml`:

```yaml
suite: Secret
templates:
  - secret.yaml
values:
  - ../ci/external-values.yaml
release:
  name: cr
tests:
  - it: Secret из secrets.* с ключами из таблицы; необязательные — только заданные
    asserts:
      - isKind: { of: Secret }
      - equal: { path: metadata.name, value: cr-carbone-reports }
      - equal: { path: stringData.POSTGRES_PASSWORD, value: 'p@ss/w:rd#%' }
      - exists: { path: stringData.APP_SECRET }
      - exists: { path: stringData.BACKUP_AGENT_TOKEN }
      - notExists: { path: stringData.S3_ACCESS_KEY_ID }
      - notExists: { path: stringData.LDAP_BIND_PASSWORD }
  - it: existingSecret — чарт Secret не создаёт
    set: { existingSecret: my-secret }
    asserts:
      - hasDocuments: { count: 0 }
  - it: нет обязательного значения — ошибка с его именем
    set: { secrets.backupAgentToken: '' }
    asserts:
      - failedTemplate: { errorMessage: 'secrets.backupAgentToken: задайте значение или existingSecret' }
  - it: внешний S3 — только один ключ — ошибка
    set: { secrets.s3AccessKeyId: AKIA }
    asserts:
      - failedTemplate:
          errorMessage: 'secrets.s3AccessKeyId и secrets.s3SecretAccessKey: задаются вместе или ни один (без ключей — учётные данные пода, IRSA)'
```

`charts/carbone-reports/tests/validate_test.yaml`:

```yaml
suite: проверки значений
templates:
  - configmap-api.yaml
values:
  - ../ci/external-values.yaml
tests:
  - it: Ingress без хоста
    set: { ingress.host: '' }
    asserts:
      - failedTemplate: { errorMessage: 'ingress.host: задайте хост (например reports.example.com) или ingress.enabled=false' }
  - it: нет ни встроенного, ни внешнего Postgres
    set: { externalDatabase.host: '' }
    asserts:
      - failedTemplate: { errorMessage: 'externalDatabase.host: задайте внешний Postgres или postgresql.enabled=true' }
  - it: неверный sslMode
    set: { externalDatabase.sslMode: prefer }
    asserts:
      - failedTemplate: { errorMessage: 'externalDatabase.sslMode: disable, require, verify-ca или verify-full' }
  - it: нет Redis
    set: { externalRedis.url: '' }
    asserts:
      - failedTemplate: { errorMessage: 'externalRedis.url: задайте внешний Redis (redis://host:6379, без пароля) или redis.enabled=true' }
  - it: нет S3
    set: { externalS3.bucket: '' }
    asserts:
      - failedTemplate: { errorMessage: 'externalS3.bucket: задайте бакет внешнего S3 или s3.enabled=true' }
  - it: выключен Carbone без адреса
    set: { carbone.enabled: false }
    asserts:
      - failedTemplate: { errorMessage: 'carbone.url: задайте адрес внешнего Carbone или carbone.enabled=true' }
  - it: выключен OnlyOffice без адреса
    set: { onlyoffice.enabled: false }
    asserts:
      - failedTemplate: { errorMessage: 'onlyoffice.internalUrl: задайте адрес Document Server или onlyoffice.enabled=true' }
  - it: trustedProxyHops вне 1–5
    set: { config.trustedProxyHops: 0 }
    asserts:
      - failedTemplate: { errorMessage: 'config.trustedProxyHops: целое от 1 до 5' }
```

Run: `sh scripts/chart.sh unittest`
Expected: FAIL — шаблонов нет (`template api.yaml not exists or not selected`).

- [ ] **Step 4: Помощники и проверки**

`charts/carbone-reports/templates/_helpers.tpl`:

```gotemplate
{{/* Имя чарта и полное имя релиза (стандарт helm create). */}}
{{- define "cr.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "cr.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Имя ресурса компонента: <fullname>-<name>, не длиннее 63 символов. dict: root, name. */}}
{{- define "cr.component" -}}
{{- printf "%s-%s" (include "cr.fullname" .root | trunc 50 | trimSuffix "-") .name }}
{{- end }}

{{/* Полное имя сервиса компонента: резолвер nginx не применяет домены поиска. dict: root, name. */}}
{{- define "cr.fqdn" -}}
{{- printf "%s.%s.svc.%s" (include "cr.component" .) .root.Release.Namespace .root.Values.clusterDomain }}
{{- end }}

{{- define "cr.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "cr.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* dict: root, component. */}}
{{- define "cr.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cr.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Образ приложения api | web | backup с общим тегом. dict: root, name. */}}
{{- define "cr.image" -}}
{{- printf "%s/carbone-report-%s:%s" .root.Values.image.registry .name (default .root.Chart.AppVersion .root.Values.image.tag) }}
{{- end }}

{{- define "cr.secretName" -}}
{{- default (include "cr.fullname" .) .Values.existingSecret }}
{{- end }}

{{/* Переменная окружения из Secret. dict: root, env, key, optional. */}}
{{- define "cr.secretEnv" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ include "cr.secretName" .root }}
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end }}

{{- define "cr.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "cr.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Общее в spec пода: учётная запись без токена API и секреты для образов. */}}
{{- define "cr.podDefaults" -}}
serviceAccountName: {{ include "cr.serviceAccountName" . }}
automountServiceAccountToken: false
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* nodeSelector, tolerations, affinity компонента: аргумент — его values. */}}
{{- define "cr.scheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* Postgres: встроенный или внешний. */}}
{{- define "cr.db.host" -}}
{{- if .Values.postgresql.enabled }}{{ include "cr.component" (dict "root" . "name" "postgresql") }}{{ else }}{{ .Values.externalDatabase.host }}{{ end }}
{{- end }}
{{- define "cr.db.port" -}}
{{- if .Values.postgresql.enabled }}5432{{ else }}{{ .Values.externalDatabase.port }}{{ end }}
{{- end }}
{{- define "cr.db.name" -}}
{{- if .Values.postgresql.enabled }}{{ .Values.postgresql.database }}{{ else }}{{ .Values.externalDatabase.database }}{{ end }}
{{- end }}
{{- define "cr.db.user" -}}
{{- if .Values.postgresql.enabled }}{{ .Values.postgresql.user }}{{ else }}{{ .Values.externalDatabase.user }}{{ end }}
{{- end }}
{{- define "cr.db.sslMode" -}}
{{- if .Values.postgresql.enabled }}disable{{ else }}{{ .Values.externalDatabase.sslMode }}{{ end }}
{{- end }}
{{/* Путь к CA внешнего Postgres в контейнере; пусто — CA не задан. */}}
{{- define "cr.db.caPath" -}}
{{- if and (not .Values.postgresql.enabled) .Values.externalDatabase.caSecret.name }}/etc/carbone-reports/pg-ca/{{ .Values.externalDatabase.caSecret.key }}{{ end }}
{{- end }}

{{/*
URL базы без пароля (пароль — DATABASE_PASSWORD, его вставляет API). uselibpqcompat — режимы sslmode
как в libpq: иначе pg считает require и verify-ca синонимами verify-full.
*/}}
{{- define "cr.databaseUrl" -}}
{{- $mode := include "cr.db.sslMode" . -}}
{{- $url := printf "postgres://%s@%s:%s/%s?sslmode=%s" (include "cr.db.user" . | urlquery) (include "cr.db.host" .) (include "cr.db.port" .) (include "cr.db.name" .) $mode -}}
{{- if ne $mode "disable" }}{{ $url = printf "%s&uselibpqcompat=true" $url }}{{ end -}}
{{- with include "cr.db.caPath" . }}{{ $url = printf "%s&sslrootcert=%s" $url . }}{{ end -}}
{{- $url }}
{{- end }}

{{/* URL Redis без пароля (пароль — REDIS_PASSWORD). */}}
{{- define "cr.redisUrl" -}}
{{- if .Values.redis.enabled }}{{ printf "redis://%s:6379" (include "cr.component" (dict "root" . "name" "redis")) }}{{ else }}{{ .Values.externalRedis.url }}{{ end }}
{{- end }}

{{- define "cr.carboneUrl" -}}
{{- if .Values.carbone.enabled }}{{ printf "http://%s:4000" (include "cr.component" (dict "root" . "name" "carbone")) }}{{ else }}{{ .Values.carbone.url }}{{ end }}
{{- end }}

{{- define "cr.onlyofficeUrl" -}}
{{- if .Values.onlyoffice.enabled }}{{ printf "http://%s" (include "cr.component" (dict "root" . "name" "onlyoffice")) }}{{ else }}{{ .Values.onlyoffice.internalUrl }}{{ end }}
{{- end }}

{{/* Настройки S3 (строки data ConfigMap): встроенный SeaweedFS или внешний S3. */}}
{{- define "cr.s3Config" -}}
STORAGE_BACKEND: s3
{{- if .Values.s3.enabled }}
S3_ENDPOINT: {{ printf "http://%s:8333" (include "cr.component" (dict "root" . "name" "s3")) | quote }}
S3_REGION: us-east-1
S3_BUCKET: {{ .Values.s3.bucket | quote }}
S3_FORCE_PATH_STYLE: "true"
S3_CREATE_BUCKET: "true"
{{- else }}
S3_ENDPOINT: {{ .Values.externalS3.endpoint | quote }}
S3_REGION: {{ .Values.externalS3.region | quote }}
S3_BUCKET: {{ .Values.externalS3.bucket | quote }}
S3_FORCE_PATH_STYLE: {{ .Values.externalS3.forcePathStyle | toString | quote }}
S3_CREATE_BUCKET: {{ .Values.externalS3.createBucket | toString | quote }}
{{- end }}
{{- end }}
```

`charts/carbone-reports/templates/_validate.tpl`:

```gotemplate
{{/* Проверки значений: понятная ошибка вместо битых манифестов (как :? в compose). */}}
{{- define "cr.validate" -}}
{{- $v := .Values -}}
{{- if and $v.ingress.enabled (not $v.ingress.host) }}
{{- fail "ingress.host: задайте хост (например reports.example.com) или ingress.enabled=false" }}
{{- end }}
{{- if and (not $v.postgresql.enabled) (not $v.externalDatabase.host) }}
{{- fail "externalDatabase.host: задайте внешний Postgres или postgresql.enabled=true" }}
{{- end }}
{{- if not (has $v.externalDatabase.sslMode (list "disable" "require" "verify-ca" "verify-full")) }}
{{- fail "externalDatabase.sslMode: disable, require, verify-ca или verify-full" }}
{{- end }}
{{- if and (not $v.redis.enabled) (not $v.externalRedis.url) }}
{{- fail "externalRedis.url: задайте внешний Redis (redis://host:6379, без пароля) или redis.enabled=true" }}
{{- end }}
{{- if and (not $v.s3.enabled) (not $v.externalS3.bucket) }}
{{- fail "externalS3.bucket: задайте бакет внешнего S3 или s3.enabled=true" }}
{{- end }}
{{- if and (not $v.carbone.enabled) (not $v.carbone.url) }}
{{- fail "carbone.url: задайте адрес внешнего Carbone или carbone.enabled=true" }}
{{- end }}
{{- if and (not $v.onlyoffice.enabled) (not $v.onlyoffice.internalUrl) }}
{{- fail "onlyoffice.internalUrl: задайте адрес Document Server или onlyoffice.enabled=true" }}
{{- end }}
{{- $hops := int $v.config.trustedProxyHops }}
{{- if or (lt $hops 1) (gt $hops 5) }}
{{- fail "config.trustedProxyHops: целое от 1 до 5" }}
{{- end }}
{{- end }}
```

- [ ] **Step 5: Шаблоны**

`templates/serviceaccount.yaml`:

```gotemplate
{{- if .Values.serviceAccount.create }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "cr.serviceAccountName" . }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
  {{- with .Values.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
automountServiceAccountToken: false
{{- end }}
```

`templates/secret.yaml`:

```gotemplate
{{- if not .Values.existingSecret }}
{{- $s := .Values.secrets }}
{{- if ne (empty $s.s3AccessKeyId) (empty $s.s3SecretAccessKey) }}
{{- fail "secrets.s3AccessKeyId и secrets.s3SecretAccessKey: задаются вместе или ни один (без ключей — учётные данные пода, IRSA)" }}
{{- end }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "cr.secretName" . }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
type: Opaque
stringData:
  APP_SECRET: {{ required "secrets.appSecret: задайте значение или existingSecret" $s.appSecret | quote }}
  ENCRYPTION_KEY: {{ required "secrets.encryptionKey: задайте значение или existingSecret" $s.encryptionKey | quote }}
  ONLYOFFICE_JWT_SECRET: {{ required "secrets.onlyofficeJwtSecret: задайте значение или existingSecret" $s.onlyofficeJwtSecret | quote }}
  ADMIN_LOGIN: {{ required "secrets.adminLogin: задайте значение или existingSecret" $s.adminLogin | quote }}
  ADMIN_PASSWORD: {{ required "secrets.adminPassword: задайте значение или existingSecret" $s.adminPassword | quote }}
  POSTGRES_PASSWORD: {{ required "secrets.postgresPassword: задайте значение или existingSecret" $s.postgresPassword | quote }}
  REDIS_PASSWORD: {{ required "secrets.redisPassword: задайте значение или existingSecret" $s.redisPassword | quote }}
  BACKUP_AGENT_TOKEN: {{ required "secrets.backupAgentToken: задайте значение или existingSecret" $s.backupAgentToken | quote }}
  {{- with $s.s3AccessKeyId }}
  S3_ACCESS_KEY_ID: {{ . | quote }}
  {{- end }}
  {{- with $s.s3SecretAccessKey }}
  S3_SECRET_ACCESS_KEY: {{ . | quote }}
  {{- end }}
  {{- with $s.ldapBindPassword }}
  LDAP_BIND_PASSWORD: {{ . | quote }}
  {{- end }}
{{- end }}
```

`templates/configmap-api.yaml`:

```gotemplate
{{- include "cr.validate" . }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "cr.component" (dict "root" . "name" "api") }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
data:
  # Пароли — не здесь: DATABASE_PASSWORD и REDIS_PASSWORD из Secret API вставляет в URL сам.
  DATABASE_URL: {{ include "cr.databaseUrl" . | quote }}
  REDIS_URL: {{ include "cr.redisUrl" . | quote }}
  CARBONE_URL: {{ include "cr.carboneUrl" . | quote }}
  ONLYOFFICE_INTERNAL_URL: {{ include "cr.onlyofficeUrl" . | quote }}
  # По этому адресу Document Server скачивает файлы и шлёт callback.
  API_INTERNAL_URL: {{ printf "http://%s:3000" (include "cr.component" (dict "root" . "name" "api")) | quote }}
  BACKUP_AGENT_URL: {{ printf "http://%s:8080" (include "cr.component" (dict "root" . "name" "backup-agent")) | quote }}
  {{- include "cr.s3Config" . | nindent 2 }}
  COOKIE_SECURE: {{ .Values.config.cookieSecure | toString | quote }}
  TRUSTED_PROXY_HOPS: {{ .Values.config.trustedProxyHops | toString | quote }}
  TZ: {{ .Values.config.tz | quote }}
  QUERY_TIMEOUT_MS: {{ .Values.config.queryTimeoutMs | toString | quote }}
  QUERY_MAX_ROWS: {{ .Values.config.queryMaxRows | toString | quote }}
  RENDER_TIMEOUT_MS: {{ .Values.config.renderTimeoutMs | toString | quote }}
  REPORT_TIMEOUT_MS: {{ .Values.config.reportTimeoutMs | toString | quote }}
  REPORT_RETENTION_DAYS: {{ .Values.config.reportRetentionDays | toString | quote }}
  LDAP_ENABLED: {{ .Values.config.ldap.enabled | toString | quote }}
  LDAP_URL: {{ .Values.config.ldap.url | quote }}
  LDAP_BIND_DN: {{ .Values.config.ldap.bindDn | quote }}
  LDAP_BASE_DN: {{ .Values.config.ldap.baseDn | quote }}
  LDAP_USER_FILTER: {{ .Values.config.ldap.userFilter | quote }}
  LDAP_DEFAULT_ROLE: {{ .Values.config.ldap.defaultRole | quote }}
  LDAP_TLS_REJECT_UNAUTHORIZED: {{ .Values.config.ldap.tlsRejectUnauthorized | toString | quote }}
```

`templates/api.yaml`:

```gotemplate
{{- $name := include "cr.component" (dict "root" . "name" "api") }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: api
spec:
  replicas: {{ .Values.api.replicas }}
  # Новая реплика готова раньше, чем уходит старая; миграции — под блокировкой при старте (§27.4).
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" . "component" "api") | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "cr.selectorLabels" (dict "root" . "component" "api") | nindent 8 }}
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap-api.yaml") . | sha256sum }}
        {{- if not .Values.existingSecret }}
        checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
        {{- end }}
        {{- with .Values.api.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      {{- include "cr.podDefaults" . | nindent 6 }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: api
          image: {{ include "cr.image" (dict "root" . "name" "api") }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: 3000
          envFrom:
            - configMapRef:
                name: {{ $name }}
          env:
            {{- include "cr.secretEnv" (dict "root" . "env" "APP_SECRET" "key" "APP_SECRET") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "ENCRYPTION_KEY" "key" "ENCRYPTION_KEY") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "ONLYOFFICE_JWT_SECRET" "key" "ONLYOFFICE_JWT_SECRET") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "ADMIN_LOGIN" "key" "ADMIN_LOGIN") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "ADMIN_PASSWORD" "key" "ADMIN_PASSWORD") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "DATABASE_PASSWORD" "key" "POSTGRES_PASSWORD") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "REDIS_PASSWORD" "key" "REDIS_PASSWORD") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "BACKUP_AGENT_TOKEN" "key" "BACKUP_AGENT_TOKEN") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "S3_ACCESS_KEY_ID" "key" "S3_ACCESS_KEY_ID" "optional" true) | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "S3_SECRET_ACCESS_KEY" "key" "S3_SECRET_ACCESS_KEY" "optional" true) | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "LDAP_BIND_PASSWORD" "key" "LDAP_BIND_PASSWORD" "optional" true) | nindent 12 }}
            {{- with .Values.api.extraEnv }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          # /api/health не трогает базу и доступен в режиме обслуживания: восстановление не делает поды NotReady.
          startupProbe:
            httpGet: { path: /api/health, port: http }
            # До 5 минут: миграции и ожидание блокировки старта, пока мигрирует другая реплика.
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            httpGet: { path: /api/health, port: http }
            periodSeconds: 10
            timeoutSeconds: 5
          livenessProbe:
            httpGet: { path: /api/health, port: http }
            periodSeconds: 20
            timeoutSeconds: 5
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            {{- if include "cr.db.caPath" . }}
            - name: pg-ca
              mountPath: /etc/carbone-reports/pg-ca
              readOnly: true
            {{- end }}
          {{- with .Values.api.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      volumes:
        - name: tmp
          emptyDir: {}
        {{- if include "cr.db.caPath" . }}
        - name: pg-ca
          secret:
            secretName: {{ .Values.externalDatabase.caSecret.name }}
            items:
              - key: {{ .Values.externalDatabase.caSecret.key }}
                path: {{ .Values.externalDatabase.caSecret.key }}
        {{- end }}
      {{- include "cr.scheduling" .Values.api | nindent 6 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: api
spec:
  selector:
    {{- include "cr.selectorLabels" (dict "root" . "component" "api") | nindent 4 }}
  ports:
    - name: http
      port: 3000
      targetPort: http
{{- if gt (int .Values.api.replicas) 1 }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: api
spec:
  minAvailable: 1
  selector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" . "component" "api") | nindent 6 }}
{{- end }}
```

`templates/web.yaml`:

```gotemplate
{{- $name := include "cr.component" (dict "root" . "name" "web") }}
{{- $oo := ternary (printf "http://%s" (include "cr.fqdn" (dict "root" . "name" "onlyoffice"))) .Values.onlyoffice.internalUrl .Values.onlyoffice.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: web
spec:
  replicas: {{ .Values.web.replicas }}
  selector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" . "component" "web") | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "cr.selectorLabels" (dict "root" . "component" "web") | nindent 8 }}
      {{- with .Values.web.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      {{- include "cr.podDefaults" . | nindent 6 }}
      containers:
        - name: web
          image: {{ include "cr.image" (dict "root" . "name" "web") }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          env:
            # TLS завершает Ingress: nginx слушает только 80 (§27.2).
            - name: NGINX_MODE
              value: http
            - name: API_UPSTREAM
              value: {{ printf "http://%s:3000" (include "cr.fqdn" (dict "root" . "name" "api")) | quote }}
            - name: ONLYOFFICE_UPSTREAM
              value: {{ $oo | quote }}
            {{- with .Values.web.extraEnv }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet: { path: /, port: http }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /, port: http }
            periodSeconds: 20
          {{- with .Values.web.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      {{- include "cr.scheduling" .Values.web | nindent 6 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: web
spec:
  selector:
    {{- include "cr.selectorLabels" (dict "root" . "component" "web") | nindent 4 }}
  ports:
    - name: http
      port: 80
      targetPort: http
```

`templates/ingress.yaml`:

```gotemplate
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "cr.fullname" . }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with .Values.ingress.className }}
  ingressClassName: {{ . }}
  {{- end }}
  {{- with .Values.ingress.tls.secretName }}
  tls:
    - hosts: [{{ $.Values.ingress.host | quote }}]
      secretName: {{ . }}
  {{- end }}
  rules:
    - host: {{ .Values.ingress.host | quote }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "cr.component" (dict "root" . "name" "web") }}
                port:
                  number: 80
{{- end }}
```

`templates/NOTES.txt`:

```gotemplate
carbone-reports {{ .Chart.AppVersion }} (образы: {{ default .Chart.AppVersion .Values.image.tag }}) установлен в {{ .Release.Namespace }}.
{{- if .Values.ingress.enabled }}

Адрес: {{ if .Values.ingress.tls.secretName }}https{{ else }}http{{ end }}://{{ .Values.ingress.host }}/
{{- else }}

Ingress выключен. Проверка: kubectl -n {{ .Release.Namespace }} port-forward svc/{{ include "cr.component" (dict "root" . "name" "web") }} 8080:80
{{- end }}

Вход: логин из ADMIN_LOGIN ({{ if .Values.existingSecret }}Secret {{ .Values.existingSecret }}{{ else }}secrets.adminLogin{{ end }}).
Бэкапы — на томе {{ include "cr.component" (dict "root" . "name" "backups") }} в этом же кластере: копии вне кластера — средствами кластера (снапшоты тома, Velero).
```

- [ ] **Step 6: Проверки чарта**

Run: `sh scripts/chart.sh all`
Expected: `files` — без вывода; `helm lint` — `1 chart(s) linted, 0 chart(s) failed`; unittest — все тесты из Step 3 PASS; kubeconform — `Summary: N resources found … Valid: N, Invalid: 0, Errors: 0`.

Если helm-unittest расходится с ожиданием только формой (например, `equal` на объект с порядком ключей) — поправить тест на `isSubset`, не трогая смысл проверки.

- [ ] **Step 7: Commit**

```bash
git add charts scripts/chart.sh package.json .prettierignore
git commit -m "feat(chart): scaffold, secrets, config, api, web and ingress with helm-unittest and kubeconform

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Чарт — агент бэкапа, Carbone, OnlyOffice

**Files:**
- Create: `charts/carbone-reports/templates/configmap-backup-agent.yaml`, `templates/backup-agent.yaml`, `templates/carbone.yaml`, `templates/onlyoffice.yaml`, `tests/backup_agent_test.yaml`, `tests/components_test.yaml`

**Interfaces:**
- Consumes: помощники Task 5 (`cr.component`, `cr.selectorLabels`, `cr.labels`, `cr.image`, `cr.secretEnv`, `cr.podDefaults`, `cr.scheduling`, `cr.s3Config`, `cr.redisUrl`, `cr.db.*`); env агента из Task 3 (`REDIS_PASSWORD`, `PGSSLMODE`, `PGSSLROOTCERT`, необязательные ключи S3).
- Produces: Service `<fullname>-backup-agent:8080`, `<fullname>-carbone:4000`, `<fullname>-onlyoffice:80`; PVC `<fullname>-backups` с `helm.sh/resource-policy: keep`; ConfigMap `<fullname>-backup-agent`.

- [ ] **Step 1: Тесты (падают)**

`charts/carbone-reports/tests/backup_agent_test.yaml`:

```yaml
suite: агент бэкапа
templates:
  - backup-agent.yaml
  - configmap-backup-agent.yaml
values:
  - ../ci/external-values.yaml
release:
  name: cr
tests:
  - it: PVC бэкапов переживает helm uninstall; размер и класс из values
    template: backup-agent.yaml
    documentIndex: 0
    set: { backup.persistence.storageClass: fast, backup.persistence.size: 50Gi }
    asserts:
      - isKind: { of: PersistentVolumeClaim }
      - equal: { path: metadata.name, value: cr-carbone-reports-backups }
      - equal: { path: 'metadata.annotations["helm.sh/resource-policy"]', value: keep }
      - equal: { path: spec.accessModes, value: [ReadWriteOnce] }
      - equal: { path: spec.storageClassName, value: fast }
      - equal: { path: spec.resources.requests.storage, value: 50Gi }
  - it: Deployment — одна реплика, Recreate, режим agent, том /backups
    template: backup-agent.yaml
    documentIndex: 1
    asserts:
      - isKind: { of: Deployment }
      - equal: { path: spec.replicas, value: 1 }
      - equal: { path: spec.strategy, value: { type: Recreate } }
      - equal: { path: 'spec.template.spec.containers[0].image', value: ghcr.io/samrozhkov/carbone-report-backup:0.1.0 }
      - equal: { path: 'spec.template.spec.containers[0].args', value: [agent] }
      - contains:
          path: spec.template.spec.containers[0].volumeMounts
          content: { name: backups, mountPath: /backups }
      - contains:
          path: spec.template.spec.volumes
          content: { name: backups, persistentVolumeClaim: { claimName: cr-carbone-reports-backups } }
      - equal: { path: 'spec.template.spec.containers[0].readinessProbe.httpGet.path', value: /health }
  - it: пароль базы — PGPASSWORD (у агента нет источников данных), токен и пароль Redis из Secret
    template: backup-agent.yaml
    documentIndex: 1
    asserts:
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: PGPASSWORD
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: POSTGRES_PASSWORD } }
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: BACKUP_AGENT_TOKEN
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: BACKUP_AGENT_TOKEN } }
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: REDIS_PASSWORD
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: REDIS_PASSWORD } }
  - it: Service агента :8080
    template: backup-agent.yaml
    documentIndex: 2
    asserts:
      - isKind: { of: Service }
      - equal: { path: metadata.name, value: cr-carbone-reports-backup-agent }
      - equal: { path: spec.ports[0].port, value: 8080 }
  - it: ConfigMap агента — PG*, SSL, S3 c провайдером rclone, расписание; слушает 0.0.0.0
    template: configmap-backup-agent.yaml
    asserts:
      - equal: { path: data.PGHOST, value: pg.example.com }
      - equal: { path: data.PGPORT, value: '5432' }
      - equal: { path: data.PGUSER, value: app }
      - equal: { path: data.PGDATABASE, value: app }
      - equal: { path: data.PGSSLMODE, value: verify-full }
      - equal: { path: data.PGSSLROOTCERT, value: /etc/carbone-reports/pg-ca/ca.crt }
      - equal: { path: data.REDIS_URL, value: 'rediss://redis.example.com:6380' }
      - equal: { path: data.S3_RCLONE_PROVIDER, value: Other }
      - equal: { path: data.S3_BUCKET, value: reports }
      - equal: { path: data.BACKUP_CRON, value: '0 3 * * *' }
      - equal: { path: data.BACKUP_KEEP, value: '14' }
      - equal: { path: data.BACKUP_TIMEOUT, value: '3600' }
      - notExists: { path: data.BACKUP_AGENT_HOST }
      - notExists: { path: data.DATABASE_URL }
```

`charts/carbone-reports/tests/components_test.yaml`:

```yaml
suite: Carbone и OnlyOffice
templates:
  - carbone.yaml
  - onlyoffice.yaml
values:
  - ../ci/external-values.yaml
release:
  name: cr
tests:
  - it: Carbone — образ из values, :4000, кэш шаблонов в emptyDir
    template: carbone.yaml
    documentIndex: 0
    asserts:
      - equal: { path: 'spec.template.spec.containers[0].image', value: carbone/carbone-ee:full-5.15.3-fonts }
      - equal: { path: 'spec.template.spec.containers[0].ports[0].containerPort', value: 4000 }
      - contains:
          path: spec.template.spec.volumes
          content: { name: templates, emptyDir: {} }
  - it: carbone.enabled=false — ничего не создаётся
    template: carbone.yaml
    set: { carbone.enabled: false, carbone.url: 'http://carbone.example:4000' }
    asserts:
      - hasDocuments: { count: 0 }
  - it: OnlyOffice — StatefulSet из одной реплики, JWT из Secret, один PVC для Data и lib
    template: onlyoffice.yaml
    documentIndex: 0
    asserts:
      - isKind: { of: StatefulSet }
      - equal: { path: spec.replicas, value: 1 }
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: JWT_SECRET
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: ONLYOFFICE_JWT_SECRET } }
      - contains: { path: 'spec.template.spec.containers[0].env', content: { name: JWT_ENABLED, value: 'true' } }
      - contains:
          path: spec.template.spec.containers[0].volumeMounts
          content: { name: data, mountPath: /var/www/onlyoffice/Data, subPath: Data }
      - contains:
          path: spec.template.spec.containers[0].volumeMounts
          content: { name: data, mountPath: /var/lib/onlyoffice, subPath: lib }
      - equal: { path: 'spec.volumeClaimTemplates[0].spec.resources.requests.storage', value: 10Gi }
      - equal: { path: 'spec.template.spec.containers[0].startupProbe.httpGet.path', value: /healthcheck }
      - equal: { path: 'spec.template.spec.containers[0].startupProbe.failureThreshold', value: 30 }
  - it: Service onlyoffice :80
    template: onlyoffice.yaml
    documentIndex: 1
    asserts:
      - equal: { path: metadata.name, value: cr-carbone-reports-onlyoffice }
      - equal: { path: spec.ports[0].port, value: 80 }
  - it: onlyoffice.enabled=false — ничего не создаётся
    template: onlyoffice.yaml
    set: { onlyoffice.enabled: false, onlyoffice.internalUrl: 'http://docs.example.com' }
    asserts:
      - hasDocuments: { count: 0 }
```

Run: `sh scripts/chart.sh unittest`
Expected: FAIL — нет шаблонов `backup-agent.yaml`, `configmap-backup-agent.yaml`, `carbone.yaml`, `onlyoffice.yaml`.

- [ ] **Step 2: Шаблоны**

`templates/configmap-backup-agent.yaml`:

```gotemplate
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "cr.component" (dict "root" . "name" "backup-agent") }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
data:
  {{- include "cr.s3Config" . | nindent 2 }}
  {{- if and (not .Values.s3.enabled) .Values.externalS3.rcloneProvider }}
  S3_RCLONE_PROVIDER: {{ .Values.externalS3.rcloneProvider | quote }}
  {{- end }}
  REDIS_URL: {{ include "cr.redisUrl" . | quote }}
  # libpq (pg_dump, psql) и пул агента читают одни и те же PG* (§27.5); пароль — PGPASSWORD из Secret.
  PGHOST: {{ include "cr.db.host" . | quote }}
  PGPORT: {{ include "cr.db.port" . | quote }}
  PGUSER: {{ include "cr.db.user" . | quote }}
  PGDATABASE: {{ include "cr.db.name" . | quote }}
  PGSSLMODE: {{ include "cr.db.sslMode" . | quote }}
  {{- with include "cr.db.caPath" . }}
  PGSSLROOTCERT: {{ . | quote }}
  {{- end }}
  BACKUP_CRON: {{ .Values.backup.cron | quote }}
  BACKUP_KEEP: {{ .Values.backup.keep | toString | quote }}
  BACKUP_TIMEOUT: {{ .Values.backup.timeout | toString | quote }}
  TZ: {{ .Values.config.tz | quote }}
```

`templates/backup-agent.yaml`:

```gotemplate
{{- $name := include "cr.component" (dict "root" . "name" "backup-agent") }}
{{- $pvc := include "cr.component" (dict "root" . "name" "backups") }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $pvc }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: backup-agent
  annotations:
    # Бэкапы переживают helm uninstall: том удаляется только вручную.
    helm.sh/resource-policy: keep
spec:
  accessModes: [ReadWriteOnce]
  {{- with .Values.backup.persistence.storageClass }}
  storageClassName: {{ . }}
  {{- end }}
  resources:
    requests:
      storage: {{ .Values.backup.persistence.size }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: backup-agent
spec:
  # Один агент и том RWO: Recreate не даёт двум агентам держать /backups одновременно (§27.5).
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" . "component" "backup-agent") | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "cr.selectorLabels" (dict "root" . "component" "backup-agent") | nindent 8 }}
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap-backup-agent.yaml") . | sha256sum }}
        {{- if not .Values.existingSecret }}
        checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}
        {{- end }}
        {{- with .Values.backup.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      {{- include "cr.podDefaults" . | nindent 6 }}
      containers:
        - name: backup-agent
          image: {{ include "cr.image" (dict "root" . "name" "backup") }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          args: [agent]
          envFrom:
            - configMapRef:
                name: {{ $name }}
          env:
            {{- include "cr.secretEnv" (dict "root" . "env" "PGPASSWORD" "key" "POSTGRES_PASSWORD") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "REDIS_PASSWORD" "key" "REDIS_PASSWORD") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "BACKUP_AGENT_TOKEN" "key" "BACKUP_AGENT_TOKEN") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "S3_ACCESS_KEY_ID" "key" "S3_ACCESS_KEY_ID" "optional" true) | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "S3_SECRET_ACCESS_KEY" "key" "S3_SECRET_ACCESS_KEY" "optional" true) | nindent 12 }}
            {{- with .Values.backup.extraEnv }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet: { path: /health, port: http }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /health, port: http }
            periodSeconds: 20
            timeoutSeconds: 5
          volumeMounts:
            - name: backups
              mountPath: /backups
            {{- if include "cr.db.caPath" . }}
            - name: pg-ca
              mountPath: /etc/carbone-reports/pg-ca
              readOnly: true
            {{- end }}
          {{- with .Values.backup.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      volumes:
        - name: backups
          persistentVolumeClaim:
            claimName: {{ $pvc }}
        {{- if include "cr.db.caPath" . }}
        - name: pg-ca
          secret:
            secretName: {{ .Values.externalDatabase.caSecret.name }}
            items:
              - key: {{ .Values.externalDatabase.caSecret.key }}
                path: {{ .Values.externalDatabase.caSecret.key }}
        {{- end }}
      {{- include "cr.scheduling" .Values.backup | nindent 6 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: backup-agent
spec:
  selector:
    {{- include "cr.selectorLabels" (dict "root" . "component" "backup-agent") | nindent 4 }}
  ports:
    - name: http
      port: 8080
      targetPort: http
```

`templates/carbone.yaml`:

```gotemplate
{{- if .Values.carbone.enabled }}
{{- $name := include "cr.component" (dict "root" . "name" "carbone") }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: carbone
spec:
  replicas: 1
  selector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" . "component" "carbone") | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "cr.selectorLabels" (dict "root" . "component" "carbone") | nindent 8 }}
      {{- with .Values.carbone.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      {{- include "cr.podDefaults" . | nindent 6 }}
      containers:
        - name: carbone
          image: {{ .Values.carbone.image }}
          {{- with .Values.carbone.extraEnv }}
          env:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          ports:
            - name: http
              containerPort: 4000
          startupProbe:
            tcpSocket: { port: http }
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            tcpSocket: { port: http }
            periodSeconds: 10
          livenessProbe:
            tcpSocket: { port: http }
            periodSeconds: 20
          # Кэш шаблонов Carbone: API передаёт шаблон при каждом рендере, при пустом кэше он загружается заново.
          volumeMounts:
            - name: templates
              mountPath: /app/template
          {{- with .Values.carbone.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      volumes:
        - name: templates
          emptyDir: {}
      {{- include "cr.scheduling" .Values.carbone | nindent 6 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: carbone
spec:
  selector:
    {{- include "cr.selectorLabels" (dict "root" . "component" "carbone") | nindent 4 }}
  ports:
    - name: http
      port: 4000
      targetPort: http
{{- end }}
```

Кэш шаблонов во `emptyDir` безопасен: Carbone отвечает 404 на потерянный шаблон, API (`apps/api/src/modules/carbone/client.ts`, `TemplateMissing`) загружает его заново.

`templates/onlyoffice.yaml`:

```gotemplate
{{- if .Values.onlyoffice.enabled }}
{{- $name := include "cr.component" (dict "root" . "name" "onlyoffice") }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: onlyoffice
spec:
  # Document Server хранит состояние редактирования локально и не масштабируется.
  replicas: 1
  serviceName: {{ $name }}
  selector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" . "component" "onlyoffice") | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "cr.selectorLabels" (dict "root" . "component" "onlyoffice") | nindent 8 }}
      {{- with .Values.onlyoffice.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      {{- include "cr.podDefaults" . | nindent 6 }}
      containers:
        - name: onlyoffice
          image: {{ .Values.onlyoffice.image }}
          env:
            - name: JWT_ENABLED
              value: 'true'
            {{- include "cr.secretEnv" (dict "root" . "env" "JWT_SECRET" "key" "ONLYOFFICE_JWT_SECRET") | nindent 12 }}
            - name: JWT_HEADER
              value: Authorization
            # API в той же частной сети кластера.
            - name: ALLOW_PRIVATE_IP_ADDRESS
              value: 'true'
            {{- with .Values.onlyoffice.extraEnv }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          ports:
            - name: http
              containerPort: 80
          # Первый старт — около двух минут.
          startupProbe:
            httpGet: { path: /healthcheck, port: http }
            periodSeconds: 10
            failureThreshold: 30
          readinessProbe:
            httpGet: { path: /healthcheck, port: http }
            periodSeconds: 15
          livenessProbe:
            httpGet: { path: /healthcheck, port: http }
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 5
          volumeMounts:
            - name: data
              mountPath: /var/www/onlyoffice/Data
              subPath: Data
            - name: data
              mountPath: /var/lib/onlyoffice
              subPath: lib
            - name: logs
              mountPath: /var/log/onlyoffice
          {{- with .Values.onlyoffice.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      volumes:
        - name: logs
          emptyDir: {}
      {{- include "cr.scheduling" .Values.onlyoffice | nindent 6 }}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        {{- with .Values.onlyoffice.persistence.storageClass }}
        storageClassName: {{ . }}
        {{- end }}
        resources:
          requests:
            storage: {{ .Values.onlyoffice.persistence.size }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: onlyoffice
spec:
  selector:
    {{- include "cr.selectorLabels" (dict "root" . "component" "onlyoffice") | nindent 4 }}
  ports:
    - name: http
      port: 80
      targetPort: http
{{- end }}
```

- [ ] **Step 3: Проверки**

Run: `sh scripts/chart.sh all`
Expected: PASS — все тесты Task 5 и 6, lint и kubeconform по `ci/external-values.yaml`.

- [ ] **Step 4: Commit**

```bash
git add charts/carbone-reports
git commit -m "feat(chart): backup agent with kept PVC, Carbone, OnlyOffice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Чарт — встроенные Postgres, Redis и SeaweedFS

**Files:**
- Create: `charts/carbone-reports/templates/postgresql.yaml`, `templates/redis.yaml`, `templates/s3.yaml`, `tests/bundled_test.yaml`, `ci/bundled-values.yaml`
- Modify: `charts/carbone-reports/templates/secret.yaml` (ключи S3 обязательны при `s3.enabled`)

**Interfaces:**
- Consumes: помощники Task 5; `files/s3-entrypoint.sh` (Task 5, Step 1).
- Produces: StatefulSet и Service `<fullname>-postgresql:5432`, `<fullname>-redis:6379`, `<fullname>-s3:8333`; ConfigMap `<fullname>-s3` со скриптом; `ci/bundled-values.yaml` — основа для kind (Task 9).

- [ ] **Step 1: Набор values и тесты (падают)**

`charts/carbone-reports/ci/bundled-values.yaml`:

```yaml
# Пробная установка: встроенные Postgres, Redis и SeaweedFS.
ingress:
  host: reports.example.com
secrets:
  appSecret: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  encryptionKey: AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=
  onlyofficeJwtSecret: oooooooooooooooooooooooooooooooooooooooo
  adminLogin: admin
  adminPassword: admin-password
  postgresPassword: postgres-password
  redisPassword: 0123456789abcdef0123456789abcdef
  backupAgentToken: tttttttttttttttttttttttttttttttttttttttt
  s3AccessKeyId: 0123456789abcdef
  s3SecretAccessKey: 0123456789abcdef0123456789abcdef
postgresql:
  enabled: true
redis:
  enabled: true
s3:
  enabled: true
```

`charts/carbone-reports/tests/bundled_test.yaml`:

```yaml
suite: встроенные зависимости
templates:
  - postgresql.yaml
  - redis.yaml
  - s3.yaml
  - configmap-api.yaml
  - configmap-backup-agent.yaml
  - secret.yaml
values:
  - ../ci/bundled-values.yaml
release:
  name: cr
tests:
  - it: Postgres — StatefulSet, PGDATA в подкаталоге тома, пароль из Secret, pg_isready
    template: postgresql.yaml
    documentIndex: 0
    asserts:
      - isKind: { of: StatefulSet }
      - equal: { path: 'spec.template.spec.containers[0].image', value: postgres:17-alpine }
      - contains:
          path: spec.template.spec.containers[0].env
          content: { name: PGDATA, value: /var/lib/postgresql/data/pgdata }
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: POSTGRES_PASSWORD
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: POSTGRES_PASSWORD } }
      - equal:
          path: 'spec.template.spec.containers[0].readinessProbe.exec.command'
          value: [pg_isready, -U, app, -d, app]
      - equal: { path: 'spec.volumeClaimTemplates[0].spec.resources.requests.storage', value: 10Gi }
  - it: API и агент ходят во встроенный Postgres без SSL
    template: configmap-api.yaml
    asserts:
      - equal: { path: data.DATABASE_URL, value: 'postgres://app@cr-carbone-reports-postgresql:5432/app?sslmode=disable' }
      - equal: { path: data.REDIS_URL, value: 'redis://cr-carbone-reports-redis:6379' }
      - equal: { path: data.S3_ENDPOINT, value: 'http://cr-carbone-reports-s3:8333' }
      - equal: { path: data.S3_BUCKET, value: carbone-reports }
      - equal: { path: data.S3_FORCE_PATH_STYLE, value: 'true' }
      - equal: { path: data.S3_CREATE_BUCKET, value: 'true' }
  - it: агент — PGHOST встроенного Postgres, без PGSSLROOTCERT
    template: configmap-backup-agent.yaml
    asserts:
      - equal: { path: data.PGHOST, value: cr-carbone-reports-postgresql }
      - equal: { path: data.PGSSLMODE, value: disable }
      - notExists: { path: data.PGSSLROOTCERT }
      - notExists: { path: data.S3_RCLONE_PROVIDER }
  - it: Redis — пароль только через окружение, без персистентности (как в compose)
    template: redis.yaml
    documentIndex: 0
    asserts:
      - equal: { path: 'spec.template.spec.containers[0].image', value: redis:7-alpine }
      - matchRegex:
          path: 'spec.template.spec.containers[0].command[2]'
          pattern: 'exec redis-server --requirepass "\$REDIS_PASSWORD" --save "" --appendonly no'
      - notExists: { path: spec.volumeClaimTemplates }
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: REDISCLI_AUTH
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: REDIS_PASSWORD } }
  - it: SeaweedFS — скрипт запуска из ConfigMap, учётная запись из Secret, том /data
    template: s3.yaml
    documentIndex: 1
    asserts:
      - isKind: { of: StatefulSet }
      - equal: { path: 'spec.template.spec.containers[0].command', value: [/s3-entrypoint.sh] }
      - contains:
          path: spec.template.spec.containers[0].volumeMounts
          content: { name: entrypoint, mountPath: /s3-entrypoint.sh, subPath: entrypoint.sh }
      - contains:
          path: spec.template.spec.containers[0].env
          content:
            name: S3_ACCESS_KEY_ID
            valueFrom: { secretKeyRef: { name: cr-carbone-reports, key: S3_ACCESS_KEY_ID } }
      - equal: { path: 'spec.template.spec.containers[0].readinessProbe.httpGet.path', value: /healthz }
  - it: ConfigMap SeaweedFS содержит скрипт из files/
    template: s3.yaml
    documentIndex: 0
    asserts:
      - isKind: { of: ConfigMap }
      - matchRegex: { path: 'data["entrypoint.sh"]', pattern: 'weed|/entrypoint.sh mini' }
  - it: встроенный s3 без ключей — ошибка
    template: secret.yaml
    set: { secrets.s3AccessKeyId: '', secrets.s3SecretAccessKey: '' }
    asserts:
      - failedTemplate:
          errorMessage: 'secrets.s3AccessKeyId и secrets.s3SecretAccessKey: обязательны при s3.enabled=true (учётная запись встроенного SeaweedFS)'
  - it: встроенные выключены — их шаблоны пусты
    template: postgresql.yaml
    set: { postgresql.enabled: false, externalDatabase.host: pg.example.com }
    asserts:
      - hasDocuments: { count: 0 }
```

Run: `sh scripts/chart.sh unittest`
Expected: FAIL — нет шаблонов.

- [ ] **Step 2: Шаблоны**

`templates/postgresql.yaml`:

```gotemplate
{{- if .Values.postgresql.enabled }}
{{- $name := include "cr.component" (dict "root" . "name" "postgresql") }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: postgresql
spec:
  replicas: 1
  serviceName: {{ $name }}
  selector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" . "component" "postgresql") | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "cr.selectorLabels" (dict "root" . "component" "postgresql") | nindent 8 }}
    spec:
      {{- include "cr.podDefaults" . | nindent 6 }}
      containers:
        - name: postgresql
          image: {{ .Values.postgresql.image }}
          env:
            - name: POSTGRES_USER
              value: {{ .Values.postgresql.user | quote }}
            - name: POSTGRES_DB
              value: {{ .Values.postgresql.database | quote }}
            {{- include "cr.secretEnv" (dict "root" . "env" "POSTGRES_PASSWORD" "key" "POSTGRES_PASSWORD") | nindent 12 }}
            # Подкаталог: в корне тома бывает lost+found, и initdb отказывается его инициализировать.
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - name: postgres
              containerPort: 5432
          readinessProbe:
            exec:
              command: [pg_isready, -U, {{ .Values.postgresql.user }}, -d, {{ .Values.postgresql.database }}]
            periodSeconds: 5
          livenessProbe:
            exec:
              command: [pg_isready, -U, {{ .Values.postgresql.user }}, -d, {{ .Values.postgresql.database }}]
            periodSeconds: 20
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          {{- with .Values.postgresql.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        {{- with .Values.postgresql.persistence.storageClass }}
        storageClassName: {{ . }}
        {{- end }}
        resources:
          requests:
            storage: {{ .Values.postgresql.persistence.size }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: postgresql
spec:
  selector:
    {{- include "cr.selectorLabels" (dict "root" . "component" "postgresql") | nindent 4 }}
  ports:
    - name: postgres
      port: 5432
      targetPort: postgres
{{- end }}
```

`templates/redis.yaml`:

```gotemplate
{{- if .Values.redis.enabled }}
{{- $name := include "cr.component" (dict "root" . "name" "redis") }}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: redis
spec:
  replicas: 1
  serviceName: {{ $name }}
  selector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" . "component" "redis") | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "cr.selectorLabels" (dict "root" . "component" "redis") | nindent 8 }}
    spec:
      {{- include "cr.podDefaults" . | nindent 6 }}
      containers:
        - name: redis
          image: {{ .Values.redis.image }}
          # Как в compose: пароль подставляет shell в контейнере (его нет в спецификации пода),
          # без персистентности, флаг обслуживания агент перезаписывает каждые 5 с.
          command:
            - sh
            - -c
            - case "$REDIS_PASSWORD" in ""|*[!0-9a-fA-F]*) echo "REDIS_PASSWORD: только шестнадцатеричные символы (openssl rand -hex 32)" >&2; exit 1;; esac; exec redis-server --requirepass "$REDIS_PASSWORD" --save "" --appendonly no --maxmemory 128mb --maxmemory-policy volatile-lru
          env:
            {{- include "cr.secretEnv" (dict "root" . "env" "REDIS_PASSWORD" "key" "REDIS_PASSWORD") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "REDISCLI_AUTH" "key" "REDIS_PASSWORD") | nindent 12 }}
          ports:
            - name: redis
              containerPort: 6379
          readinessProbe:
            exec:
              command: [redis-cli, ping]
            periodSeconds: 5
          livenessProbe:
            exec:
              command: [redis-cli, ping]
            periodSeconds: 20
          {{- with .Values.redis.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: redis
spec:
  selector:
    {{- include "cr.selectorLabels" (dict "root" . "component" "redis") | nindent 4 }}
  ports:
    - name: redis
      port: 6379
      targetPort: redis
{{- end }}
```

`templates/s3.yaml`:

```gotemplate
{{- if .Values.s3.enabled }}
{{- $name := include "cr.component" (dict "root" . "name" "s3") }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: s3
data:
  # Копия docker/s3/entrypoint.sh (совпадение проверяет scripts/chart.sh files).
  entrypoint.sh: |
    {{- .Files.Get "files/s3-entrypoint.sh" | nindent 4 }}
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: s3
spec:
  replicas: 1
  serviceName: {{ $name }}
  selector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" . "component" "s3") | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "cr.selectorLabels" (dict "root" . "component" "s3") | nindent 8 }}
      annotations:
        checksum/entrypoint: {{ .Files.Get "files/s3-entrypoint.sh" | sha256sum }}
    spec:
      {{- include "cr.podDefaults" . | nindent 6 }}
      containers:
        - name: s3
          image: {{ .Values.s3.image }}
          command: [/s3-entrypoint.sh]
          env:
            {{- include "cr.secretEnv" (dict "root" . "env" "S3_ACCESS_KEY_ID" "key" "S3_ACCESS_KEY_ID") | nindent 12 }}
            {{- include "cr.secretEnv" (dict "root" . "env" "S3_SECRET_ACCESS_KEY" "key" "S3_SECRET_ACCESS_KEY") | nindent 12 }}
          ports:
            - name: s3
              containerPort: 8333
          readinessProbe:
            httpGet: { path: /healthz, port: s3 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /healthz, port: s3 }
            periodSeconds: 20
          volumeMounts:
            - name: entrypoint
              mountPath: /s3-entrypoint.sh
              subPath: entrypoint.sh
            - name: data
              mountPath: /data
          {{- with .Values.s3.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      volumes:
        - name: entrypoint
          configMap:
            name: {{ $name }}
            defaultMode: 0555
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        {{- with .Values.s3.persistence.storageClass }}
        storageClassName: {{ . }}
        {{- end }}
        resources:
          requests:
            storage: {{ .Values.s3.persistence.size }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $name }}
  labels:
    {{- include "cr.labels" . | nindent 4 }}
    app.kubernetes.io/component: s3
spec:
  selector:
    {{- include "cr.selectorLabels" (dict "root" . "component" "s3") | nindent 4 }}
  ports:
    - name: s3
      port: 8333
      targetPort: s3
{{- end }}
```

`templates/secret.yaml`: перед проверкой «задаются вместе или ни один» добавить:

```gotemplate
{{- if and .Values.s3.enabled (not (and $s.s3AccessKeyId $s.s3SecretAccessKey)) }}
{{- fail "secrets.s3AccessKeyId и secrets.s3SecretAccessKey: обязательны при s3.enabled=true (учётная запись встроенного SeaweedFS)" }}
{{- end }}
```

(сначала проверка встроенного s3, затем «вместе или ни один»).

- [ ] **Step 3: Проверки**

Run: `sh scripts/chart.sh all`
Expected: PASS; lint и kubeconform теперь проходят по двум наборам: `ci/external-values.yaml` и `ci/bundled-values.yaml`.

- [ ] **Step 4: Commit**

```bash
git add charts/carbone-reports
git commit -m "feat(chart): bundled Postgres, Redis and SeaweedFS behind flags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Чарт — NetworkPolicy и задание CI `chart`

**Files:**
- Create: `charts/carbone-reports/templates/networkpolicy.yaml`, `tests/networkpolicy_test.yaml`, `ci/netpol-values.yaml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: помощники Task 5; компоненты Task 5–7.
- Produces: задание CI `chart` (`needs: [checks]`), на него опирается `chart-kind` (Task 9).

- [ ] **Step 1: Набор values и тесты (падают)**

`charts/carbone-reports/ci/netpol-values.yaml`:

```yaml
# NetworkPolicy, встроенные зависимости, внешние Carbone и OnlyOffice, готовый Secret.
ingress:
  host: reports.example.com
existingSecret: carbone-reports
networkPolicy:
  enabled: true
postgresql:
  enabled: true
redis:
  enabled: true
s3:
  enabled: true
carbone:
  enabled: false
  url: http://carbone.example:4000
onlyoffice:
  enabled: false
  internalUrl: http://docs.example.com
```

`charts/carbone-reports/tests/networkpolicy_test.yaml`:

```yaml
suite: NetworkPolicy
templates:
  - networkpolicy.yaml
values:
  - ../ci/bundled-values.yaml
set:
  networkPolicy.enabled: true
release:
  name: cr
tests:
  - it: по умолчанию выключено
    set: { networkPolicy.enabled: false }
    asserts:
      - hasDocuments: { count: 0 }
  - it: все компоненты, кроме web, закрыты; к агенту — только api
    asserts:
      - hasDocuments: { count: 7 }
      - equal: { path: metadata.name, value: cr-carbone-reports-backup-agent }
        documentIndex: 0
      - equal:
          path: spec.ingress
          value:
            - from:
                - podSelector:
                    matchLabels:
                      app.kubernetes.io/name: carbone-reports
                      app.kubernetes.io/instance: cr
                      app.kubernetes.io/component: api
              ports: [{ port: 8080, protocol: TCP }]
        documentIndex: 0
      - equal: { path: spec.policyTypes, value: [Ingress] }
        documentIndex: 0
  - it: к api — web и onlyoffice
    documentIndex: 1
    asserts:
      - equal: { path: metadata.name, value: cr-carbone-reports-api }
      - equal: { path: 'spec.ingress[0].from[0].podSelector.matchLabels["app.kubernetes.io/component"]', value: web }
      - equal: { path: 'spec.ingress[0].from[1].podSelector.matchLabels["app.kubernetes.io/component"]', value: onlyoffice }
      - equal: { path: 'spec.ingress[0].ports', value: [{ port: 3000, protocol: TCP }] }
  - it: к redis — api и агент
    documentIndex: 5
    asserts:
      - equal: { path: metadata.name, value: cr-carbone-reports-redis }
      - equal: { path: 'spec.ingress[0].from[1].podSelector.matchLabels["app.kubernetes.io/component"]', value: backup-agent }
  - it: выключенные компоненты — без политики
    set: { carbone.enabled: false, carbone.url: 'http://c:4000', onlyoffice.enabled: false, onlyoffice.internalUrl: 'http://o' }
    asserts:
      - hasDocuments: { count: 5 }
```

Run: `sh scripts/chart.sh unittest`
Expected: FAIL — нет `networkpolicy.yaml`.

- [ ] **Step 2: Шаблон**

`templates/networkpolicy.yaml`:

```gotemplate
{{- if .Values.networkPolicy.enabled }}
{{- /*
Повторяет внутренние сети compose (§27.6): к компоненту — только перечисленные поды, на его порт.
web не закрыт: к нему ходит Ingress-контроллер. Исходящий трафик не ограничивается (внешние
Postgres, Redis, S3, LDAP). Порядок: backup-agent, api, onlyoffice, carbone, postgresql, redis, s3.
*/ -}}
{{- $root := . }}
{{- $rules := list
  (dict "to" "backup-agent" "from" (list "api") "port" 8080 "on" true)
  (dict "to" "api" "from" (list "web" "onlyoffice") "port" 3000 "on" true)
  (dict "to" "onlyoffice" "from" (list "web" "api") "port" 80 "on" .Values.onlyoffice.enabled)
  (dict "to" "carbone" "from" (list "api") "port" 4000 "on" .Values.carbone.enabled)
  (dict "to" "postgresql" "from" (list "api" "backup-agent") "port" 5432 "on" .Values.postgresql.enabled)
  (dict "to" "redis" "from" (list "api" "backup-agent") "port" 6379 "on" .Values.redis.enabled)
  (dict "to" "s3" "from" (list "api" "backup-agent") "port" 8333 "on" .Values.s3.enabled)
}}
{{- range $rules }}
{{- if .on }}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "cr.component" (dict "root" $root "name" .to) }}
  labels:
    {{- include "cr.labels" $root | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "cr.selectorLabels" (dict "root" $root "component" .to) | nindent 6 }}
  policyTypes: [Ingress]
  ingress:
    - from:
        {{- range .from }}
        - podSelector:
            matchLabels:
              {{- include "cr.selectorLabels" (dict "root" $root "component" .) | nindent 14 }}
        {{- end }}
      ports:
        - port: {{ .port }}
          protocol: TCP
{{- end }}
{{- end }}
{{- end }}
```

Run: `sh scripts/chart.sh all`
Expected: PASS, lint и kubeconform — по трём наборам `ci/*.yaml`.

- [ ] **Step 3: Задание CI**

В `.github/workflows/ci.yml` после задания `integration`:

```yaml
  chart:
    name: Чарт Helm
    needs: [checks]
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      # helm lint, helm-unittest и kubeconform — в Docker-образах с закреплёнными версиями (как локально).
      - run: sh scripts/chart.sh all
```

Задание `images` (`needs: [checks, integration]`) не меняется.

- [ ] **Step 4: Проверить workflow**

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 -color .github/workflows/ci.yml`
Expected: без ошибок. (Если образ недоступен — `gh workflow view ci.yml` после пуша ветки; синтаксис проверит GitHub.)

- [ ] **Step 5: Commit**

```bash
git add charts/carbone-reports .github/workflows/ci.yml
git commit -m "feat(chart): NetworkPolicy mirroring compose internal networks; CI chart job

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Установка в kind и smoke в CI

**Files:**
- Create: `scripts/k8s-smoke.ts`, `charts/carbone-reports/ci/kind-values.yaml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: чарт Task 5–8; образы api, web, backup текущего коммита; API: `POST /api/auth/login`, `GET /api/auth/me` (`features.backups`), `POST /api/categories` (201), `GET /api/categories`, `GET /api/admin/backups`, `POST /api/admin/backups` (202 `{ operationId }`), `POST /api/admin/backups/:name/restore` (202 `{ operationId }`), `GET /api/admin/backups/operation`, `GET /api/maintenance` (`{ active: boolean, … }`).
- Produces: задание CI `chart-kind` (`needs: [chart, integration]`); `pnpm exec tsx scripts/k8s-smoke.ts` с `BASE_URL`, `ADMIN_LOGIN`, `ADMIN_PASSWORD`.

- [ ] **Step 1: Values для kind**

`charts/carbone-reports/ci/kind-values.yaml` (самодостаточный: его тоже проверяют lint и kubeconform):

```yaml
# kind в CI (§27.9): образы текущего коммита с тегом kind, встроенные зависимости,
# без Ingress, Carbone и OnlyOffice (их образы — несколько ГБ; smoke отчёты не формирует).
image:
  tag: kind
  pullPolicy: IfNotPresent
ingress:
  enabled: false
config:
  # Smoke ходит через port-forward по HTTP.
  cookieSecure: false
secrets:
  appSecret: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  encryptionKey: AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=
  onlyofficeJwtSecret: oooooooooooooooooooooooooooooooooooooooo
  adminLogin: admin
  adminPassword: admin-password
  postgresPassword: 'p@ss/w:rd#%'
  redisPassword: 0123456789abcdef0123456789abcdef
  backupAgentToken: tttttttttttttttttttttttttttttttttttttttt
  s3AccessKeyId: 0123456789abcdef
  s3SecretAccessKey: 0123456789abcdef0123456789abcdef
carbone:
  enabled: false
  url: http://carbone.invalid:4000
onlyoffice:
  enabled: false
  internalUrl: http://onlyoffice.invalid
postgresql:
  enabled: true
  persistence: { size: 1Gi }
redis:
  enabled: true
s3:
  enabled: true
  persistence: { size: 1Gi }
backup:
  persistence: { size: 1Gi }
networkPolicy:
  enabled: true
```

(Пароль Postgres со спецсимволами — проверка Review Focus 1 на живой установке; NetworkPolicy включена, чтобы smoke прошёл через неё. Сеть kind по умолчанию — kindnet, политики он применяет начиная с kind 0.24.)

Run: `sh scripts/chart.sh lint && sh scripts/chart.sh kubeconform`
Expected: PASS по четырём наборам.

- [ ] **Step 2: Smoke-скрипт**

`scripts/k8s-smoke.ts`:

```ts
// Smoke установки чарта (CI, задание chart-kind; §27.9) через port-forward к web:
//   BASE_URL=http://127.0.0.1:8080 ADMIN_LOGIN=… ADMIN_PASSWORD=… pnpm exec tsx scripts/k8s-smoke.ts
// Проверяет: health и CSP через nginx, вход, бэкап из админки, восстановление с режимом обслуживания,
// данные из бэкапа после повторного входа. Первая ошибка останавливает проверку (код 1).
import { randomUUID } from 'node:crypto';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`не задана переменная ${k}`);
  return v;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Operation {
  id: string;
  status: string;
}
interface Backup {
  name: string;
  kind: string;
  status: string;
}

let cookie = '';

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

async function json<T>(res: Response, expected: number): Promise<T> {
  const text = await res.text();
  if (res.status !== expected)
    throw new Error(`${res.url}: HTTP ${res.status}, ожидался ${expected}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${Date.now() - t} мс)`);
  } catch (e) {
    console.error(`✗ ${name}: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function login(): Promise<void> {
  cookie = '';
  const r = await call('POST', '/api/auth/login', {
    login: need('ADMIN_LOGIN'),
    password: need('ADMIN_PASSWORD'),
  });
  if (r.status !== 200) throw new Error(`вход: HTTP ${r.status}`);
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  if (!cookie.startsWith('session=')) throw new Error('нет cookie session');
}

/** Ждёт конца операции с этим id; ответы не 200 (503 во время восстановления) пропускаются. */
async function waitOperation(id: string, timeoutMs: number): Promise<Operation> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await call('GET', '/api/admin/backups/operation').catch(() => null);
    if (r?.status === 401) await login().catch(() => {});
    else if (r?.status === 200) {
      const op = (await r.json()) as Operation;
      if (op.id === id && op.status !== 'running') return op;
    }
    if (Date.now() > until) throw new Error(`операция ${id} не завершилась за ${timeoutMs / 1000} с`);
    await sleep(2000);
  }
}

const suffix = randomUUID().slice(0, 8);
const kept = `k8s-smoke-бэкап-${suffix}`;
const later = `k8s-smoke-после-${suffix}`;
let backupName = '';

await step('API отвечает через web', async () => {
  const until = Date.now() + 60_000;
  for (;;) {
    const r = await fetch(`${BASE}/api/health`).catch(() => null);
    if (r?.status === 200) return;
    if (Date.now() > until) throw new Error(`/api/health: ${r?.status ?? 'нет соединения'}`);
    await sleep(2000);
  }
});

await step('SPA отдаётся с CSP', async () => {
  const r = await fetch(`${BASE}/`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const csp = r.headers.get('content-security-policy') ?? '';
  if (!csp.includes("default-src 'self'")) throw new Error(`нет CSP: «${csp}»`);
});

await step('вход администратора, бэкапы включены', async () => {
  await login();
  const me = await json<{ features?: { backups?: boolean } }>(await call('GET', '/api/auth/me'), 200);
  if (me.features?.backups !== true) throw new Error('features.backups не true: у api нет BACKUP_AGENT_URL');
});

await step('бэкап из админки', async () => {
  await json(await call('POST', '/api/categories', { name: kept }), 201);
  const before = new Set(
    (await json<Backup[]>(await call('GET', '/api/admin/backups'), 200)).map((b) => b.name),
  );
  const { operationId } = await json<{ operationId: string }>(
    await call('POST', '/api/admin/backups', {}),
    202,
  );
  const op = await waitOperation(operationId, 300_000);
  if (op.status !== 'succeeded') throw new Error(`бэкап: ${op.status}`);
  const created = (await json<Backup[]>(await call('GET', '/api/admin/backups'), 200)).find(
    (b) => !before.has(b.name) && b.kind === 'regular',
  );
  if (!created || created.status !== 'ok') throw new Error('новый бэкап не найден в списке');
  backupName = created.name;
});

await step('восстановление: режим обслуживания, затем данные из бэкапа', async () => {
  await json(await call('POST', '/api/categories', { name: later }), 201);
  const { operationId } = await json<{ operationId: string }>(
    await call('POST', `/api/admin/backups/${encodeURIComponent(backupName)}/restore`, {}),
    202,
  );
  // Флаг обслуживания виден всем репликам API, пока идёт восстановление.
  let sawMaintenance = false;
  const until = Date.now() + 600_000;
  for (;;) {
    const r = await fetch(`${BASE}/api/maintenance`).catch(() => null);
    if (r?.status === 200) {
      const m = (await r.json()) as { active: boolean };
      if (m.active) sawMaintenance = true;
      else if (sawMaintenance) break;
    }
    if (Date.now() > until) throw new Error('режим обслуживания не снят за 10 минут');
    await sleep(1000);
  }
  await login();
  const op = await waitOperation(operationId, 60_000);
  if (op.status !== 'succeeded') throw new Error(`восстановление: ${op.status}`);
  const names = (await json<{ name: string }[]>(await call('GET', '/api/categories'), 200)).map(
    (c) => c.name,
  );
  if (!names.includes(kept)) throw new Error(`нет категории из бэкапа ${kept}`);
  if (names.includes(later)) throw new Error(`категория после бэкапа ${later} не исчезла`);
});

await step('режим обслуживания снят', async () => {
  const m = await json<{ active: boolean }>(await fetch(`${BASE}/api/maintenance`), 200);
  if (m.active) throw new Error('cr:maintenance всё ещё установлен');
});

console.log('smoke пройден');
```

Опрос `/api/maintenance` начинается сразу после `POST …/restore`: флаг включается после бэкапа `pre-restore` (несколько секунд) и держится всю замену базы, поэтому опрос раз в секунду его видит. Если в CI шаг всё же падает с «режим обслуживания не снят» при успешной операции — выходить из цикла по «операция `succeeded` и флаг снят», а `sawMaintenance === false` печатать предупреждением; записать это в отчёт.

Run: `pnpm typecheck:scripts && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Задание CI**

В `.github/workflows/ci.yml` после задания `chart`:

```yaml
  chart-kind:
    name: Чарт в kind
    needs: [chart, integration]
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1
      # Образы текущего коммита: кэш общий с заданием images, здесь только чтение.
      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          file: docker/api.Dockerfile
          load: true
          tags: ghcr.io/samrozhkov/carbone-report-api:kind
          cache-from: type=gha,scope=api
      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          file: docker/web.Dockerfile
          load: true
          tags: ghcr.io/samrozhkov/carbone-report-web:kind
          cache-from: type=gha,scope=web
      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0
        with:
          context: .
          file: docker/backup/Dockerfile
          load: true
          tags: ghcr.io/samrozhkov/carbone-report-backup:kind
          cache-from: type=gha,scope=backup
      - uses: helm/kind-action@1544676c07bb3570fcb70166beaa07c4528fd4aa # v1.15.1
        with:
          cluster_name: cr
      - uses: azure/setup-helm@9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310 # v5.0.1
        with:
          version: v4.3.0
      - name: Образы в kind
        run: for n in api web backup; do kind load docker-image "ghcr.io/samrozhkov/carbone-report-$n:kind" --name cr; done
      - name: Установка чарта
        run: >-
          helm install cr charts/carbone-reports --namespace cr --create-namespace
          -f charts/carbone-reports/ci/kind-values.yaml --wait --timeout 10m
      - name: Smoke
        env:
          BASE_URL: http://127.0.0.1:8080
          ADMIN_LOGIN: admin
          ADMIN_PASSWORD: admin-password
        run: |
          kubectl -n cr port-forward svc/cr-carbone-reports-web 8080:80 > /tmp/port-forward.log 2>&1 &
          pnpm exec tsx scripts/k8s-smoke.ts
          # Обе реплики API пережили восстановление: /api/health доступен в режиме обслуживания.
          test "$(kubectl -n cr get deploy cr-carbone-reports-api -o jsonpath='{.status.readyReplicas}')" = 2
          test "$(kubectl -n cr get deploy cr-carbone-reports-api -o jsonpath='{.status.updatedReplicas}')" = 2
          kubectl -n cr get pods -l app.kubernetes.io/component=api -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' | grep -qv '^0$' && { echo "реплики API перезапускались" >&2; exit 1; } || true
      - name: Диагностика
        if: failure()
        run: |
          kubectl -n cr get pods,svc,pvc,networkpolicy -o wide || true
          kubectl -n cr get events --sort-by=.lastTimestamp || true
          kubectl -n cr describe pods || true
          for p in $(kubectl -n cr get pods -o name); do echo "== $p"; kubectl -n cr logs "$p" --all-containers --tail=200 || true; done
          cat /tmp/port-forward.log || true
```

Проверка «реплики API не перезапускались» допускает перезапуски при старте, пока встроенные зависимости не готовы: если на kind API падает до готовности s3 и это видно в диагностике, заменить проверку на сравнение `restartCount` до и после smoke (снять значения перед `pnpm exec tsx …`) — смысл проверки: восстановление не перезапускает реплики.

- [ ] **Step 4: Прогон на ветке**

Задание `chart-kind` нельзя прогнать локально (kind и helm — только в CI). Это внешнее действие: контроллер спрашивает пользователя, можно ли отправить ветку `feat/helm-chart` в GitHub, и только после согласия:

```bash
git push -u origin feat/helm-chart
gh workflow run ci.yml --ref feat/helm-chart
sleep 15; gh run list --branch feat/helm-chart --limit 1
gh run watch <id> --exit-status
```

Expected: все задания зелёные, в журнале `chart-kind` — строки `✓` всех шагов smoke и `smoke пройден`. При провале — читать шаг «Диагностика», чинить, повторять.

- [ ] **Step 5: Commit**

```bash
git add scripts/k8s-smoke.ts charts/carbone-reports/ci/kind-values.yaml .github/workflows/ci.yml
git commit -m "ci(chart): install into kind with bundled deps and run backup/restore smoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(коммит — до Step 4: workflow запускается с ветки).

---

### Task 10: Публикация чарта и документация

**Files:**
- Modify: `.github/workflows/ci.yml`, `README.md`, `docs/superpowers/notes/2026-10-02-backend-follow-ups.md`, `.env.example` (комментарий про `TRUSTED_PROXY_HOPS`), `docker-compose.yml` (без изменений поведения — только если README ссылается на новые переменные)

**Interfaces:**
- Consumes: всё из Task 1–9.
- Produces: задание CI `chart-publish` на тег `vX.Y.Z` → `oci://ghcr.io/samrozhkov/charts/carbone-reports:X.Y.Z`.

- [ ] **Step 1: Задание публикации**

В `.github/workflows/ci.yml` в конец `jobs`:

```yaml
  chart-publish:
    name: Публикация чарта
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [chart, chart-kind, images]
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: azure/setup-helm@9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310 # v5.0.1
        with:
          version: v4.3.0
      # Версия чарта и appVersion = тег без «v»: образы этого тега публикует задание images.
      - name: Упаковка и публикация в GHCR
        env:
          TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ACTOR: ${{ github.actor }}
        run: |
          v=${GITHUB_REF_NAME#v}
          printf '%s' "$TOKEN" | helm registry login ghcr.io -u "$ACTOR" --password-stdin
          helm package charts/carbone-reports --version "$v" --app-version "$v" -d /tmp/chart
          helm push "/tmp/chart/carbone-reports-$v.tgz" oci://ghcr.io/samrozhkov/charts
```

Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 -color .github/workflows/ci.yml`
Expected: без ошибок.

- [ ] **Step 2: README — раздел «Kubernetes (Helm)»**

Добавить раздел после раздела про запуск из готовых образов. Содержание (формулировки — в стиле README, по-русски):

1. **Установка.** Из каталога: `helm install cr charts/carbone-reports -n reports --create-namespace -f my-values.yaml`. После первого релиза — из OCI: `helm install cr oci://ghcr.io/samrozhkov/charts/carbone-reports --version X.Y.Z -n reports -f my-values.yaml`. До первого тега `v*` образов с тегом `appVersion` нет: задайте `image.tag: main` или `sha-<7 символов>`. Пакеты GHCR приватные — `imagePullSecrets` или публичная видимость.
2. **Пробная установка** — values со встроенными зависимостями (взять `ci/bundled-values.yaml`, заменить пароли на `openssl rand -hex 32`, `encryptionKey` — `openssl rand -base64 32`).
3. **Прод** — минимальные values для внешних Postgres, Redis, S3 (как `ci/external-values.yaml`), `existingSecret` и таблица ключей Secret (11 ключей из Global Constraints: имя, обязательность, требования — длина, base64, hex для встроенного Redis, допустимые символы ключей встроенного S3). Пароли Postgres и Redis могут содержать любые символы (вставляются в URL с кодированием).
4. **Ingress** — `ingress.host`, `className`, `tls.secretName`; аннотации ingress-nginx (`proxy-body-size: 100m`, таймауты 300) — без них не работает загрузка в OnlyOffice. `config.trustedProxyHops: 2` — Ingress и nginx; если перед Ingress есть ещё балансировщик, добавляющий `X-Forwarded-For`, — 3.
5. **Внешний Postgres с TLS** — `externalDatabase.sslMode` (disable/require/verify-ca/verify-full, как libpq), `caSecret`.
6. **S3 без ключей (IRSA)** — `serviceAccount.annotations` с ролью, ключи не задавать; `externalS3.rcloneProvider` для S3-совместимых хранилищ (Other, Minio, Ceph).
7. **Обновление** — `helm upgrade`; реплики API выкатываются по одной, миграции накатывает первая стартовавшая под блокировкой. Правило для разработчиков: миграция должна быть совместима с предыдущей версией приложения (добавлять, а не переименовывать и удалять) — старые реплики несколько секунд работают на новой схеме.
8. **Бэкапы в кластере** — агент с PVC `<release>-carbone-reports-backups` (размер `backup.persistence.size`); том не удаляется при `helm uninstall`; бэкапы лежат в том же кластере — копии вне его делаются средствами кластера (снапшоты тома, Velero). Восстановление из админки работает с несколькими репликами API.
9. **Восстановление в Kubernetes без админки** — если API не поднимается:

```sh
NS=reports
R=cr-carbone-reports
kubectl -n $NS port-forward svc/$R-backup-agent 18080:8080 &
TOKEN=$(kubectl -n $NS get secret $R -o jsonpath='{.data.BACKUP_AGENT_TOKEN}' | base64 -d)   # или ваш existingSecret
A="Authorization: Bearer $TOKEN"
curl -s -H "$A" http://127.0.0.1:18080/backups                       # список
curl -s -H "$A" -H 'content-type: application/json' -d '{"requestedBy":"kubectl"}' \
  -X POST http://127.0.0.1:18080/backups/<имя>/restore                 # запуск
curl -s -H "$A" http://127.0.0.1:18080/operation                      # ход и итог
```

   Если восстановление прервалось, код повтора — в `kubectl -n $NS logs deploy/$R-backup-agent | grep 'КОД ВОССТАНОВЛЕНИЯ'`; повтор — на экране обслуживания или `POST /recovery` с `{"code":"…","target":"backup"|"pre-restore"}`. Токен не вставлять в историю shell на общих машинах.
10. **Безопасность** — api совместим с Pod Security «restricted»; web, агент, OnlyOffice, Carbone и встроенные зависимости работают от root, как их образы: чарт рассчитан на «baseline». `networkPolicy.enabled: true` повторяет внутренние сети compose (к агенту — только api; к Redis, S3, Postgres — api и агент; к api — web и OnlyOffice). Пробы kubelet при этом проходят (трафик узла).
11. **Проверка чарта локально** — `pnpm chart:check` (нужен только Docker).

Также в README:
- в разделе про docker-compose.dev — `NGINX_MODE: dev` вместо монтирования `dev.conf` (если раздел упоминает файл);
- в описании переменных API (если есть таблица) — `DATABASE_PASSWORD`, `REDIS_PASSWORD`, `TRUSTED_PROXY_HOPS`; ключи S3 необязательны (оба или ни одного).

`.env.example`: рядом с прочими настройками API — закомментированная строка:

```
# Прокси перед API (X-Forwarded-For): 1 — nginx в compose. Ещё один прокси перед nginx — 2.
# TRUSTED_PROXY_HOPS=1
```

и добавить `TRUSTED_PROXY_HOPS: ${TRUSTED_PROXY_HOPS:-1}` в `environment` сервиса `api` в `docker-compose.yml`.

- [ ] **Step 3: Заметки**

В конец `docs/superpowers/notes/2026-10-02-backend-follow-ups.md` — раздел «Итоги Плана 16 (Helm-чарт)»: что сделано (по задачам), решения исполнителей из отчётов, проверенное в CI (`chart`, `chart-kind`), и открытое:
- хвост Плана 14 «отдельная учётная запись S3 только на чтение для бэкапа» снят (восстановлению из админки нужна запись);
- хвост «`restore.sh`: sed api_backend fail-open» остаётся (compose);
- OnlyOffice и Carbone в CI не проверяются (ручной прогон);
- аварийный путь в k8s — HTTP агента, без отдельного скрипта;
- web и агент от root (уровень baseline);
- остальное, что всплывёт при исполнении.

- [ ] **Step 4: Проверки и commit**

Run: `pnpm exec prettier --check . && pnpm lint && sh scripts/chart.sh all`
Expected: PASS.

```bash
git add .github/workflows/ci.yml README.md docs/superpowers/notes/2026-10-02-backend-follow-ups.md .env.example docker-compose.yml
git commit -m "docs: Kubernetes (Helm) in README, chart publish on v* tags, Plan 16 notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Ручная проверка после плана (не задача исполнителя)

Полный прогон с Carbone и OnlyOffice в kind или кластере (§27.9): открыть шаблон в редакторе OnlyOffice, сформировать отчёт, бэкап и восстановление из админки. Делает пользователь или контроллер по просьбе пользователя.
