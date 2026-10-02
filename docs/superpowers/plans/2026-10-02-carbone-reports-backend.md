# Carbone Reports — План 1 из 3: бэкенд (`apps/api` + `packages/shared`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Полностью рабочий и покрытый тестами API: авторизация с ролями, источники данных PostgreSQL, шаблоны с SQL-запросами и параметрами, генерация через Carbone, история запусков, интеграция с OnlyOffice (конфиг редактора, сохранение по callback).

**Architecture:** Fastify + TypeScript, модули по ответственности (`auth`, `users`, `datasources`, `queries`, `templates`, `carbone`, `onlyoffice`, `reports`). Внешние сервисы (Carbone, OnlyOffice Command Service, скачивание файлов, пулы источников) скрыты за интерфейсами в `src/deps.ts` и подменяются в тестах. Метаданные — PostgreSQL через Drizzle. Общие zod-схемы и DTO лежат в `packages/shared` и используются API и (в Плане 2) фронтендом.

**Tech Stack:** Node 22, pnpm 10 workspaces, TypeScript 5.9 (strict), Fastify 5, fastify-type-provider-zod 7, zod 4, Drizzle ORM 0.45 + drizzle-kit, pg + pg-cursor, argon2, jose, jszip, Vitest 5, testcontainers 12.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`

**Разбиение на планы:**
- **План 1 (этот):** бэкенд. Результат проверяется юнит- и интеграционными тестами и smoke-запуском сервера.
- **План 2:** фронтенд `apps/web` (React + GravityUI, все экраны §8). Пишется после выполнения Плана 1, опирается на реальные DTO из `shared`.
- **План 3:** `docker-compose.yml` (web/nginx, api, carbone, onlyoffice, postgres), демо-профиль, E2E на Playwright.

## Global Constraints

- Node `>=22.12` (локально `nvm use 22`), pnpm `10.34.6` через corepack.
- TypeScript `5.9.3` (typescript-eslint не поддерживает TS ≥ 6.1), `strict` + `noUncheckedIndexedAccess`.
- ESM везде (`"type": "module"`).
- Все сообщения об ошибках для пользователя — на русском. Формат ответа об ошибке: `{ error: { code, message, details? } }`.
- Значения параметров попадают в SQL **только** через bind (`$n`). Никакой конкатенации значений в SQL.
- Пароли источников хранятся только в виде AES-256-GCM (`ENCRYPTION_KEY`) и никогда не возвращаются API.
- Запросы к источникам выполняются в `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` с `SET LOCAL statement_timeout`, затем всегда `ROLLBACK`.
- Значения по умолчанию: `QUERY_TIMEOUT_MS=30000`, `QUERY_MAX_ROWS=100000`, `RENDER_TIMEOUT_MS=120000`, `REPORT_RETENTION_DAYS=30`, `TZ=Europe/Moscow`. Lang рендера — `ru-ru`.
- Carbone: образ `carbone/carbone-ee` (Community Edition), HTTP API v5, заголовок `carbone-version: 5`.
- OnlyOffice: Document Server 9.x, JWT HS256 с общим `ONLYOFFICE_JWT_SECRET`, Command Service по пути `/command`.
- Маршруты `/internal/*` предназначены только для Document Server во внутренней сети. Nginx (План 3) их наружу не проксирует.
- Интеграционные тесты требуют запущенного Docker.
- Каждая задача заканчивается зелёными `pnpm test`, `pnpm test:int` (начиная с Task 3), `pnpm -r typecheck` и коммитом.

## Review Focus

Пять ситуаций, которые спецификация подразумевает, но легко упустить. Тесты на каждую добавлены в задачу-владельца:

1. **Большие `bigint`/`numeric` из источника** (id > 2^53). Ожидание: значение не теряет точность и приходит строкой. Тест: Task 8, «bigint за пределами 2^53…».
2. **Запоздалый callback OnlyOffice со старым `key`** после закрытия сессии. Ожидание: игнорируется и не затирает более новую версию шаблона. Тест: Task 13, «устаревший ключ…».
3. **Carbone потерял шаблон** (контейнер пересоздан, кэш `templateId` в API устарел). Ожидание: шаблон загружается заново, отчёт генерируется. Тест: Task 11, «если Carbone потерял шаблон…».
4. **Шаблон удалён, а история запусков осталась.** Ожидание: история читается, есть название шаблона, `templateId = null`. Тест: Task 12, «после удаления шаблона…».
5. **OnlyOffice отдал по `url` не документ** (HTML-страницу ошибки). Ожидание: файл шаблона не перезаписывается, админ видит `lastSaveError`. Тест: Task 13, «по url пришёл не документ…».

## Уточнения спецификации, зафиксированные этим планом

- Пустой шаблон создаётся только как `docx` или `xlsx`. PPTX/ODT/ODS добавляются загрузкой файла (`POST /api/templates/upload`).
- Добавлены маршруты: `POST /api/templates/upload` (multipart), `PUT /api/templates/:id/file` (замена файла, `version++`, новый `doc_key`), `POST /api/datasources/test` (проверка соединения до сохранения).
- `report_runs.template_name` — название шаблона на момент запуска. `templates.last_save_error` — источник `lastSaveError`.
- `POST /api/templates/:id/queries/run` возвращает `{ columns, rows (≤50), truncated }` вместо `rowCount`.
- Неизвестный `:param` в SQL проверяется при выполнении (`CONFIG`, 400), а не при сохранении: запросы и параметры сохраняются независимо.
- Ошибки валидации параметров (`VALIDATION`) не пишутся в историю запусков. Остальные ошибки пишутся со `status=error`.
- Carbone вызывается в два шага: `POST /template` (с кэшем по версии), затем `POST /render/:id?download=true`. Отдельный `GET /render/:renderId` не нужен.
- `bigint`/`numeric` больше 2^53−1 по модулю передаются строкой.
- HTTP-клиенты Carbone и OnlyOffice принимают `fetch` через конструктор. В тестах вместо `undici MockAgent` используется поддельный `fetch`, потому что встроенный `fetch` Node и npm-пакет `undici` могут иметь несовместимые диспетчеры.

## Структура файлов

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, eslint.config.js, .prettierrc.json, .nvmrc, .gitignore, .env.example, README.md
packages/shared/src/index.ts                zod-схемы и DTO
apps/api/
  drizzle.config.ts, tsup.config.ts, vitest.config.ts, vitest.int.config.ts
  drizzle/                                  SQL-миграции (генерируются)
  src/
    app.ts                                  createFastify, buildApp (регистрация модулей)
    server.ts                               точка входа
    config.ts                               env → Config
    deps.ts                                 AppDeps и интерфейсы внешних сервисов
    db/schema.ts, db/client.ts
    lib/errors.ts, lib/storage.ts, lib/crypto.ts, lib/http.ts, lib/fetch-file.ts
    modules/
      auth/        password, session, guards, routes, bootstrap
      users/       routes
      datasources/ pools, routes
      queries/     sql-params, params, build-data, executor
      templates/   blank, service, routes
      carbone/     client
      reports/     service, routes, cleanup
      onlyoffice/  jwt, editor-config, callback, commands, routes
  test/
    global-setup.ts, helpers.ts, *.int.test.ts
```

---

### Task 1: Монорепо, пакет `shared`, каркас `api`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.gitignore`, `.prettierrc.json`, `tsconfig.base.json`, `eslint.config.js`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/index.test.ts`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsup.config.ts`, `apps/api/vitest.config.ts`, `apps/api/src/app.ts`
- Test: `apps/api/src/app.test.ts`

**Interfaces:**
- Produces (`@carbone-reports/shared`): `IDENT_RE`, `Role`, `TemplateExt`, `OutputFormat`, `ParamType`, `SelectOption`, `TemplateParam`, `TemplateQuery`, `outputFormatsFor(ext)`, DTO-схемы `LoginBody`, `UserDto`, `CreateUserBody`, `UpdateUserBody`, `DatasourceBody`, `DatasourceDto`, `TemplateSummary`, `TemplateDetails`, `TemplateAdminDetails`, `CreateTemplateBody`, `UpdateTemplateBody`, `RenderBody`, `PreviewBody`, `RunQueryBody`, `RunDto`, `ApiError`, и одноимённые TS-типы (`type X = z.infer<typeof X>`).
- Produces (`apps/api/src/app.ts`): `createFastify(): App`, `type App`, `buildApp(deps: AppDeps): Promise<App>` (в этой задаче `AppDeps` — временно `{}`; финальный вид задаётся в Task 3).

- [ ] **Step 1: Подготовить окружение**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh && nvm use 22
corepack enable && corepack prepare pnpm@10.34.6 --activate
node -v   # v22.17.0 или новее
pnpm -v   # 10.34.6
```

- [ ] **Step 2: Корневые файлы**

`.nvmrc`:
```
22
```

`package.json`:
```json
{
  "name": "carbone-reports",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.34.6",
  "engines": { "node": ">=22.12" },
  "scripts": {
    "test": "pnpm -r test",
    "test:int": "pnpm -r test:int",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint .",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@eslint/js": "^10.0.0",
    "eslint": "^10.11.0",
    "prettier": "^3.9.9",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.71.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - apps/*
  - packages/*
onlyBuiltDependencies:
  - argon2
  - esbuild
```

`.gitignore`:
```
node_modules/
dist/
.env
*.log
coverage/
.data/
```

`.prettierrc.json`:
```json
{ "singleQuote": true, "semi": true, "printWidth": 100, "trailingComma": "all" }
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": false,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`eslint.config.js`:
```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
```

- [ ] **Step 3: Пакет `shared` — сначала тест**

`packages/shared/package.json`:
```json
{
  "name": "@carbone-reports/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": { "zod": "^4.6.5" },
  "devDependencies": { "@types/node": "^22.20.5", "vitest": "^5.0.3" }
}
```

`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/shared/src/index.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TemplateParam, TemplateQuery, outputFormatsFor } from './index';

describe('TemplateQuery', () => {
  it('принимает корректный ключ', () => {
    expect(TemplateQuery.parse({ key: 'orders', sql: 'select 1', mode: 'list' }).key).toBe('orders');
  });
  it('отклоняет зарезервированный ключ params', () => {
    expect(TemplateQuery.safeParse({ key: 'params', sql: 'select 1', mode: 'list' }).success).toBe(false);
  });
  it('отклоняет ключ с пробелом и ключ, начинающийся с цифры', () => {
    expect(TemplateQuery.safeParse({ key: 'my key', sql: 'x', mode: 'list' }).success).toBe(false);
    expect(TemplateQuery.safeParse({ key: '1abc', sql: 'x', mode: 'list' }).success).toBe(false);
  });
});

describe('TemplateParam', () => {
  it('требует options для select', () => {
    const r = TemplateParam.safeParse({
      name: 'status', label: 'Статус', type: 'select', required: true, defaultValue: null, options: null,
    });
    expect(r.success).toBe(false);
  });
  it('принимает date-параметр без options', () => {
    const r = TemplateParam.safeParse({
      name: 'dateFrom', label: 'С', type: 'date', required: true, defaultValue: null, options: null,
    });
    expect(r.success).toBe(true);
  });
});

describe('outputFormatsFor', () => {
  it('для docx — pdf, docx, odt', () => {
    expect(outputFormatsFor('docx')).toEqual(['pdf', 'docx', 'odt']);
  });
  it('для xlsx — pdf, xlsx, ods', () => {
    expect(outputFormatsFor('xlsx')).toEqual(['pdf', 'xlsx', 'ods']);
  });
  it('для pptx — pdf, pptx', () => {
    expect(outputFormatsFor('pptx')).toEqual(['pdf', 'pptx']);
  });
});
```

- [ ] **Step 4: Установить зависимости и убедиться, что тест падает**

```bash
pnpm install
pnpm --filter @carbone-reports/shared test
```
Expected: FAIL — `Failed to resolve import "./index"` (файла ещё нет).

- [ ] **Step 5: Реализовать `shared`**

`packages/shared/src/index.ts`:
```ts
import { z } from 'zod';

export const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const Role = z.enum(['admin', 'user']);
export type Role = z.infer<typeof Role>;

export const TemplateExt = z.enum(['docx', 'xlsx', 'odt', 'ods', 'pptx']);
export type TemplateExt = z.infer<typeof TemplateExt>;

export const OutputFormat = z.enum(['pdf', 'docx', 'xlsx', 'odt', 'ods', 'pptx']);
export type OutputFormat = z.infer<typeof OutputFormat>;

const FORMATS_BY_EXT: Record<TemplateExt, OutputFormat[]> = {
  docx: ['pdf', 'docx', 'odt'],
  odt: ['pdf', 'docx', 'odt'],
  xlsx: ['pdf', 'xlsx', 'ods'],
  ods: ['pdf', 'xlsx', 'ods'],
  pptx: ['pdf', 'pptx'],
};

export function outputFormatsFor(ext: TemplateExt): OutputFormat[] {
  return FORMATS_BY_EXT[ext];
}

export const ParamType = z.enum(['string', 'number', 'date', 'boolean', 'select']);
export type ParamType = z.infer<typeof ParamType>;

export const SelectOption = z.object({ value: z.string().min(1), label: z.string().min(1) });
export type SelectOption = z.infer<typeof SelectOption>;

export const ParamValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ParamValue = z.infer<typeof ParamValue>;

export const TemplateParam = z
  .object({
    name: z.string().regex(IDENT_RE, 'имя: латиница, цифры и _'),
    label: z.string().min(1),
    type: ParamType,
    required: z.boolean(),
    defaultValue: ParamValue,
    options: z.array(SelectOption).min(1).nullable(),
  })
  .refine((p) => p.type !== 'select' || (p.options && p.options.length > 0), {
    message: 'для select нужен хотя бы один вариант',
    path: ['options'],
  });
export type TemplateParam = z.infer<typeof TemplateParam>;

export const QueryMode = z.enum(['list', 'single']);
export type QueryMode = z.infer<typeof QueryMode>;

export const TemplateQuery = z.object({
  key: z
    .string()
    .regex(IDENT_RE, 'ключ: латиница, цифры и _')
    .refine((k) => k !== 'params', 'ключ "params" зарезервирован'),
  sql: z.string().trim().min(1),
  mode: QueryMode,
});
export type TemplateQuery = z.infer<typeof TemplateQuery>;

// ---- DTO ----

export const LoginBody = z.object({ login: z.string().min(1), password: z.string().min(1) });
export type LoginBody = z.infer<typeof LoginBody>;

export const UserDto = z.object({
  id: z.string(),
  login: z.string(),
  role: Role,
  blocked: z.boolean(),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof UserDto>;

export const CreateUserBody = z.object({
  login: z.string().trim().min(3).max(64),
  password: z.string().min(8),
  role: Role,
});
export type CreateUserBody = z.infer<typeof CreateUserBody>;

export const UpdateUserBody = z.object({
  password: z.string().min(8).optional(),
  role: Role.optional(),
  blocked: z.boolean().optional(),
});
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;

export const DatasourceBody = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1),
  username: z.string().trim().min(1),
  /** При обновлении: undefined — пароль не меняется. */
  password: z.string().optional(),
  ssl: z.boolean(),
});
export type DatasourceBody = z.infer<typeof DatasourceBody>;

export const DatasourceDto = DatasourceBody.omit({ password: true }).extend({
  id: z.string(),
  createdAt: z.string(),
});
export type DatasourceDto = z.infer<typeof DatasourceDto>;

export const TemplateSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  fileExt: TemplateExt,
  defaultOutput: OutputFormat,
  updatedAt: z.string(),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

export const TemplateDetails = TemplateSummary.extend({
  params: z.array(TemplateParam),
  outputFormats: z.array(OutputFormat),
});
export type TemplateDetails = z.infer<typeof TemplateDetails>;

export const TemplateAdminDetails = TemplateDetails.extend({
  datasourceId: z.string(),
  version: z.number(),
  queries: z.array(TemplateQuery),
  lastSaveError: z.string().nullable(),
});
export type TemplateAdminDetails = z.infer<typeof TemplateAdminDetails>;

export const CreateTemplateBody = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  datasourceId: z.string(),
  blank: z.enum(['docx', 'xlsx']),
});
export type CreateTemplateBody = z.infer<typeof CreateTemplateBody>;

export const UpdateTemplateBody = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  datasourceId: z.string().optional(),
  defaultOutput: OutputFormat.optional(),
});
export type UpdateTemplateBody = z.infer<typeof UpdateTemplateBody>;

export const ParamsInput = z.record(z.string(), ParamValue);
export type ParamsInput = z.infer<typeof ParamsInput>;

export const RenderBody = z.object({ params: ParamsInput, format: OutputFormat });
export type RenderBody = z.infer<typeof RenderBody>;

export const PreviewBody = z.object({ params: ParamsInput, mode: z.enum(['data', 'pdf']) });
export type PreviewBody = z.infer<typeof PreviewBody>;

export const RunQueryBody = z.object({ sql: z.string().trim().min(1), params: ParamsInput });
export type RunQueryBody = z.infer<typeof RunQueryBody>;

export const RunQueryResult = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});
export type RunQueryResult = z.infer<typeof RunQueryResult>;

export const RunDto = z.object({
  id: z.string(),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  templateVersion: z.number(),
  userId: z.string(),
  userLogin: z.string(),
  params: ParamsInput,
  outputFormat: OutputFormat,
  status: z.enum(['ok', 'error']),
  error: z.string().nullable(),
  fileAvailable: z.boolean(),
  durationMs: z.number(),
  createdAt: z.string(),
});
export type RunDto = z.infer<typeof RunDto>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;
```

> Примечание: создание пустого шаблона поддерживает только `docx` и `xlsx`. PPTX/ODT/ODS добавляются загрузкой файла (см. Task 10). Это уточнение спецификации §5.3.

- [ ] **Step 6: Тест `shared` проходит**

```bash
pnpm --filter @carbone-reports/shared test && pnpm --filter @carbone-reports/shared typecheck
```
Expected: PASS (8 тестов), typecheck без ошибок.

- [ ] **Step 7: Каркас `api` — тест**

`apps/api/package.json`:
```json
{
  "name": "@carbone-reports/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsup",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:int": "vitest run --config vitest.int.config.ts",
    "typecheck": "tsc -p tsconfig.json",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@carbone-reports/shared": "workspace:*",
    "@fastify/cookie": "^11.1.2",
    "@fastify/multipart": "^10.1.2",
    "argon2": "^0.45.1",
    "drizzle-orm": "^0.45.3",
    "fastify": "^5.12.5",
    "fastify-type-provider-zod": "^7.0.0",
    "jose": "^6.2.12",
    "jszip": "^3.10.2",
    "pg": "^8.23.1",
    "pg-cursor": "^2.22.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^12.2.0",
    "@types/node": "^22.20.5",
    "@types/pg": "^8.23.1",
    "@types/pg-cursor": "^2.7.2",
    "drizzle-kit": "^0.31.11",
    "testcontainers": "^12.2.0",
    "tsup": "^8.5.1",
    "tsx": "^4.23.15",
    "vitest": "^5.0.3"
  }
}
```

`apps/api/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "*.ts"] }
```

`apps/api/tsup.config.ts` (пакет `shared` вшивается в сборку, остальные зависимости остаются внешними):
```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  noExternal: ['@carbone-reports/shared'],
});
```

`apps/api/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
```

`apps/api/src/app.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('buildApp', () => {
  it('GET /api/health → 200 {status:"ok"}', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
```

- [ ] **Step 8: Запустить — падает**

```bash
pnpm install && pnpm --filter @carbone-reports/api test
```
Expected: FAIL — `Failed to resolve import "./app"`.

- [ ] **Step 9: Реализовать `app.ts`**

`apps/api/src/app.ts`:
```ts
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

// Временный вид; финальный AppDeps появится в src/deps.ts (Task 3).
export type AppDeps = Record<string, never>;

export function createFastify() {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' || process.env.VITEST ? false : { level: 'info' },
    bodyLimit: 25 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

export type App = ReturnType<typeof createFastify>;

export async function buildApp(_deps: AppDeps): Promise<App> {
  const app = createFastify();
  app.get('/api/health', async () => ({ status: 'ok' }));
  await app.ready();
  return app;
}
```

- [ ] **Step 10: Тест проходит, typecheck чистый**

```bash
pnpm --filter @carbone-reports/api test && pnpm -r typecheck && pnpm lint
```
Expected: PASS; tsc и eslint без ошибок.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: monorepo scaffold, shared schemas, api skeleton"
```

---

### Task 2: Конфиг, ошибки, файловое хранилище, шифрование

**Files:**
- Create: `apps/api/src/config.ts`, `apps/api/src/lib/errors.ts`, `apps/api/src/lib/storage.ts`, `apps/api/src/lib/crypto.ts`
- Test: `apps/api/src/config.test.ts`, `apps/api/src/lib/errors.test.ts`, `apps/api/src/lib/storage.test.ts`, `apps/api/src/lib/crypto.test.ts`
- Modify: `apps/api/src/app.ts` (подключить обработчик ошибок)

**Interfaces:**
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Config`; `interface Config { databaseUrl; appSecret: Uint8Array; encryptionKey: Buffer; onlyofficeJwtSecret: Uint8Array; onlyofficeInternalUrl; apiInternalUrl; carboneUrl; adminLogin?: string; adminPassword?: string; storageDir; queryTimeoutMs; queryMaxRows; renderTimeoutMs; reportRetentionDays; tz; port; cookieSecure: boolean }`
  - `class AppError(code: string, status: number, message: string, details?: unknown)`; фабрики `badRequest(msg, details?)`, `unauthorized()`, `forbidden()`, `notFound(what)`, `conflict(msg)`; `registerErrorHandler(app: App)`
  - `class Storage(root: string)` с методами `path(rel)`, `write(rel, data: Buffer)`, `read(rel): Promise<Buffer>`, `remove(rel)`, `exists(rel): Promise<boolean>`
  - `encryptSecret(plain: string, key: Buffer): string`, `decryptSecret(enc: string, key: Buffer): string`

- [ ] **Step 1: Тесты**

`apps/api/src/config.test.ts`:
```ts
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
    expect(c.reportRetentionDays).toBe(30);
    expect(c.tz).toBe('Europe/Moscow');
    expect(c.carboneUrl).toBe('http://carbone:4000');
    expect(c.encryptionKey.length).toBe(32);
    expect(c.cookieSecure).toBe(false);
  });
  it('приводит числа из строк', () => {
    expect(loadConfig({ ...base, QUERY_MAX_ROWS: '10' }).queryMaxRows).toBe(10);
  });
  it('падает с понятной ошибкой на коротком ENCRYPTION_KEY', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'abc' })).toThrow(/ENCRYPTION_KEY/);
  });
  it('падает, если нет DATABASE_URL', () => {
    const { DATABASE_URL: _, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });
});
```

`apps/api/src/lib/crypto.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './crypto';

const key = Buffer.alloc(32, 7);

describe('crypto', () => {
  it('шифрует и расшифровывает', () => {
    const enc = encryptSecret('пароль-123', key);
    expect(enc).not.toContain('пароль');
    expect(decryptSecret(enc, key)).toBe('пароль-123');
  });
  it('каждый раз даёт разный шифротекст', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
  });
  it('падает при подмене шифротекста', () => {
    const buf = Buffer.from(encryptSecret('secret', key), 'base64');
    buf[buf.length - 1]! ^= 0xff;
    expect(() => decryptSecret(buf.toString('base64'), key)).toThrow();
  });
  it('падает на чужом ключе', () => {
    expect(() => decryptSecret(encryptSecret('s', key), Buffer.alloc(32, 8))).toThrow();
  });
});
```

`apps/api/src/lib/storage.test.ts`:
```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from './storage';

let root: string;
let storage: Storage;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'storage-'));
  storage = new Storage(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('Storage', () => {
  it('пишет и читает, создавая каталоги', async () => {
    await storage.write('templates/a.docx', Buffer.from('hello'));
    expect((await storage.read('templates/a.docx')).toString()).toBe('hello');
    expect(await storage.exists('templates/a.docx')).toBe(true);
  });
  it('не оставляет временных файлов', async () => {
    await storage.write('reports/x.pdf', Buffer.from('1'));
    expect(await readdir(join(root, 'reports'))).toEqual(['x.pdf']);
  });
  it('remove игнорирует отсутствующий файл', async () => {
    await expect(storage.remove('nope/none.bin')).resolves.toBeUndefined();
  });
  it('запрещает выход за корень', () => {
    expect(() => storage.path('../etc/passwd')).toThrow(/недопустимый путь/);
  });
});
```

`apps/api/src/lib/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFastify } from '../app';
import { AppError, registerErrorHandler } from './errors';

async function appWith(handler: () => unknown) {
  const app = createFastify();
  registerErrorHandler(app);
  app.post('/t', { schema: { body: z.object({ n: z.number() }) } }, async () => handler());
  await app.ready();
  return app;
}

describe('registerErrorHandler', () => {
  it('AppError → его статус и тело {error}', async () => {
    const app = await appWith(() => {
      throw new AppError('SQL_ERROR', 400, 'запрос "a": ошибка', { key: 'a' });
    });
    const res = await app.inject({ method: 'POST', url: '/t', payload: { n: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'SQL_ERROR', message: 'запрос "a": ошибка', details: { key: 'a' } } });
  });
  it('ошибка валидации zod → 400 VALIDATION', async () => {
    const app = await appWith(() => 'ok');
    const res = await app.inject({ method: 'POST', url: '/t', payload: { n: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
  it('неизвестная ошибка → 500 без утечки текста', async () => {
    const app = await appWith(() => {
      throw new Error('секрет в стектрейсе');
    });
    const res = await app.inject({ method: 'POST', url: '/t', payload: { n: 1 } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'внутренняя ошибка сервера' } });
  });
});
```

- [ ] **Step 2: Запустить — падают**

```bash
pnpm --filter @carbone-reports/api test
```
Expected: FAIL — не найдены модули `./config`, `./crypto`, `./storage`, `./errors`.

- [ ] **Step 3: Реализация**

`apps/api/src/config.ts`:
```ts
import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string({ error: 'DATABASE_URL обязателен' }).min(1, 'DATABASE_URL обязателен'),
  APP_SECRET: z.string().min(32, 'APP_SECRET: минимум 32 символа'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY: 32 байта в base64'),
  ONLYOFFICE_JWT_SECRET: z.string().min(32, 'ONLYOFFICE_JWT_SECRET: минимум 32 символа'),
  ONLYOFFICE_INTERNAL_URL: z.url().default('http://onlyoffice'),
  API_INTERNAL_URL: z.url().default('http://api:3000'),
  CARBONE_URL: z.url().default('http://carbone:4000'),
  ADMIN_LOGIN: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  STORAGE_DIR: z.string().default('/data'),
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  QUERY_MAX_ROWS: z.coerce.number().int().positive().default(100000),
  RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  REPORT_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  TZ: z.string().default('Europe/Moscow'),
  PORT: z.coerce.number().int().default(3000),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
});

export interface Config {
  databaseUrl: string;
  appSecret: Uint8Array;
  encryptionKey: Buffer;
  onlyofficeJwtSecret: Uint8Array;
  onlyofficeInternalUrl: string;
  apiInternalUrl: string;
  carboneUrl: string;
  adminLogin?: string;
  adminPassword?: string;
  storageDir: string;
  queryTimeoutMs: number;
  queryMaxRows: number;
  renderTimeoutMs: number;
  reportRetentionDays: number;
  tz: string;
  port: number;
  cookieSecure: boolean;
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
    adminLogin: e.ADMIN_LOGIN,
    adminPassword: e.ADMIN_PASSWORD,
    storageDir: e.STORAGE_DIR,
    queryTimeoutMs: e.QUERY_TIMEOUT_MS,
    queryMaxRows: e.QUERY_MAX_ROWS,
    renderTimeoutMs: e.RENDER_TIMEOUT_MS,
    reportRetentionDays: e.REPORT_RETENTION_DAYS,
    tz: e.TZ,
    port: e.PORT,
    cookieSecure: e.COOKIE_SECURE === 'true',
  };
}
```

`apps/api/src/lib/crypto.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Формат: base64(iv[12] | tag[16] | ciphertext)
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(enc: string, key: Buffer): string {
  const buf = Buffer.from(enc, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
```

`apps/api/src/lib/storage.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export class Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  path(rel: string): string {
    const abs = resolve(this.root, rel);
    if (!abs.startsWith(this.root + sep)) throw new Error(`недопустимый путь: ${rel}`);
    return abs;
  }

  async write(rel: string, data: Buffer): Promise<void> {
    const abs = this.path(rel);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, abs);
  }

  read(rel: string): Promise<Buffer> {
    return readFile(this.path(rel));
  }

  async remove(rel: string): Promise<void> {
    await rm(this.path(rel), { force: true });
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await access(this.path(rel));
      return true;
    } catch {
      return false;
    }
  }
}
```

`apps/api/src/lib/errors.ts`:
```ts
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { App } from '../app';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('BAD_REQUEST', 400, message, details);
export const unauthorized = () => new AppError('UNAUTHORIZED', 401, 'требуется вход');
export const forbidden = () => new AppError('FORBIDDEN', 403, 'недостаточно прав');
export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} не найден`);
export const conflict = (message: string) => new AppError('CONFLICT', 409, message);

export function registerErrorHandler(app: App): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const body: { code: string; message: string; details?: unknown } = {
        code: err.code,
        message: err.message,
      };
      if (err.details !== undefined) body.details = err.details;
      return reply.status(err.status).send({ error: body });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'неверные данные запроса',
          details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: { code: (err as { code?: string }).code ?? 'BAD_REQUEST', message: err.message },
      });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'внутренняя ошибка сервера' } });
  });
}
```

В `apps/api/src/app.ts` в `buildApp` перед регистрацией маршрутов добавить:
```ts
import { registerErrorHandler } from './lib/errors';
// ...
  const app = createFastify();
  registerErrorHandler(app);
```

- [ ] **Step 4: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api typecheck
```
Expected: PASS (все тесты Task 1–2).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): config, error handling, storage, secret encryption"
```

---

### Task 3: Схема БД, миграции, `AppDeps`, интеграционная тестовая обвязка

**Files:**
- Create: `apps/api/src/db/schema.ts`, `apps/api/src/db/client.ts`, `apps/api/drizzle.config.ts`, `apps/api/drizzle/*` (генерируется)
- Create: `apps/api/src/deps.ts`
- Create: `apps/api/vitest.int.config.ts`, `apps/api/test/global-setup.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/db.int.test.ts`
- Modify: `apps/api/src/app.ts` (использовать `AppDeps` из `deps.ts`), `apps/api/src/app.test.ts`

**Interfaces:**
- Consumes: `Config`, `Storage` (Task 2).
- Produces:
  - Таблицы drizzle: `users`, `datasources`, `templates`, `templateQueries`, `templateParams`, `reportRuns`; типы строк `UserRow`, `DatasourceRow`, `TemplateRow`, `RunRow` (`typeof t.$inferSelect`).
  - `createDb(url: string): { db: Db; pool: pg.Pool }`, `type Db`, `migrateDb(db: Db): Promise<void>`
  - `src/deps.ts`:
    ```ts
    interface TemplateFileRef { id: string; version: number; ext: TemplateExt; read(): Promise<Buffer> }
    interface RenderOptions { convertTo: OutputFormat; lang: string; timezone: string; timeoutMs: number }
    interface CarboneRenderer { render(tpl: TemplateFileRef, data: unknown, opts: RenderOptions): Promise<Buffer> }
    interface OnlyOfficeCommands { forceSave(key: string): Promise<void> }
    type FileFetcher = (url: string) => Promise<Buffer>
    interface SourcePools { get(datasourceId: string): Promise<{ pool: pg.Pool; name: string }>; invalidate(id: string): Promise<void>; closeAll(): Promise<void> }
    interface AppDeps { config: Config; db: Db; storage: Storage; sources: SourcePools; carbone: CarboneRenderer; onlyoffice: OnlyOfficeCommands; fetchFile: FileFetcher }
    ```
  - Тестовые хелперы: `createTestDatabase(): Promise<string>`, `testConfig(databaseUrl, storageDir): Config`, `createTestApp(overrides?: Partial<Omit<AppDeps,'config'|'db'|'storage'>>): Promise<TestApp>`, где `TestApp = { app: App; deps: AppDeps; close(): Promise<void> }`.

- [ ] **Step 1: Схема**

`apps/api/src/db/schema.ts`:
```ts
import type { OutputFormat, ParamType, ParamValue, QueryMode, Role, SelectOption, TemplateExt } from '@carbone-reports/shared';
import { boolean, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<Role>().notNull(),
  blocked: boolean('blocked').notNull().default(false),
  createdAt: createdAt(),
});

export const datasources = pgTable('datasources', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  database: text('database').notNull(),
  username: text('username').notNull(),
  passwordEnc: text('password_enc').notNull(),
  ssl: boolean('ssl').notNull().default(false),
  createdAt: createdAt(),
});

export const templates = pgTable('templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  datasourceId: uuid('datasource_id')
    .notNull()
    .references(() => datasources.id, { onDelete: 'restrict' }),
  fileExt: text('file_ext').$type<TemplateExt>().notNull(),
  filePath: text('file_path').notNull(),
  version: integer('version').notNull().default(1),
  docKey: text('doc_key').notNull(),
  defaultOutput: text('default_output').$type<OutputFormat>().notNull().default('pdf'),
  lastSaveError: text('last_save_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

export const templateQueries = pgTable(
  'template_queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    sql: text('sql').notNull(),
    mode: text('mode').$type<QueryMode>().notNull(),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [unique().on(t.templateId, t.key)],
);

export const templateParams = pgTable(
  'template_params',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    label: text('label').notNull(),
    type: text('type').$type<ParamType>().notNull(),
    required: boolean('required').notNull(),
    defaultValue: jsonb('default_value').$type<ParamValue>(),
    options: jsonb('options').$type<SelectOption[] | null>(),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [unique().on(t.templateId, t.name)],
);

export const reportRuns = pgTable('report_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
  templateName: text('template_name').notNull(),
  templateVersion: integer('template_version').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  params: jsonb('params').$type<Record<string, ParamValue>>().notNull(),
  outputFormat: text('output_format').$type<OutputFormat>().notNull(),
  status: text('status').$type<'ok' | 'error'>().notNull(),
  error: text('error'),
  filePath: text('file_path'),
  fileDeleted: boolean('file_deleted').notNull().default(false),
  durationMs: integer('duration_ms').notNull(),
  createdAt: createdAt(),
});

export type UserRow = typeof users.$inferSelect;
export type DatasourceRow = typeof datasources.$inferSelect;
export type TemplateRow = typeof templates.$inferSelect;
export type TemplateQueryRow = typeof templateQueries.$inferSelect;
export type TemplateParamRow = typeof templateParams.$inferSelect;
export type RunRow = typeof reportRuns.$inferSelect;
```

> Отличия от спецификации §3: `report_runs.template_name` хранит название на момент запуска (запись остаётся читаемой после удаления шаблона), `templates.last_save_error` — источник поля `lastSaveError` (§5.2).

`apps/api/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
```

`apps/api/src/db/client.ts`:
```ts
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export function createDb(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];

export async function migrateDb(db: Db): Promise<void> {
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'drizzle');
  await migrate(db, { migrationsFolder });
}
```

- [ ] **Step 2: Сгенерировать миграцию**

```bash
cd apps/api && pnpm db:generate && ls drizzle && cd ../..
```
Expected: в `apps/api/drizzle/` появились `0000_*.sql` и `meta/`. В SQL есть `CREATE TABLE "users"` … `"report_runs"`.

- [ ] **Step 3: `deps.ts` и переключение `app.ts`**

`apps/api/src/deps.ts`:
```ts
import type { OutputFormat, TemplateExt } from '@carbone-reports/shared';
import type pg from 'pg';
import type { Config } from './config';
import type { Db } from './db/client';
import type { Storage } from './lib/storage';

export interface TemplateFileRef {
  id: string;
  version: number;
  ext: TemplateExt;
  read(): Promise<Buffer>;
}

export interface RenderOptions {
  convertTo: OutputFormat;
  lang: string;
  timezone: string;
  timeoutMs: number;
}

export interface CarboneRenderer {
  render(tpl: TemplateFileRef, data: unknown, opts: RenderOptions): Promise<Buffer>;
}

export interface OnlyOfficeCommands {
  forceSave(key: string): Promise<void>;
}

export type FileFetcher = (url: string) => Promise<Buffer>;

export interface SourcePools {
  get(datasourceId: string): Promise<{ pool: pg.Pool; name: string }>;
  invalidate(datasourceId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface AppDeps {
  config: Config;
  db: Db;
  storage: Storage;
  sources: SourcePools;
  carbone: CarboneRenderer;
  onlyoffice: OnlyOfficeCommands;
  fetchFile: FileFetcher;
}
```

В `apps/api/src/app.ts` удалить временный `export type AppDeps = Record<string, never>;` и добавить:
```ts
import type { AppDeps } from './deps';
export type { AppDeps };
```

`apps/api/src/app.test.ts` перенести в интеграционный набор: удалить файл `apps/api/src/app.test.ts` (health проверяется в `test/db.int.test.ts` ниже).

- [ ] **Step 4: Интеграционная обвязка**

`apps/api/vitest.int.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
```

`apps/api/test/global-setup.ts`:
```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUri: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

export default async function setup(project: TestProject) {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  project.provide('pgUri', container.getConnectionUri());
  return async () => {
    await container?.stop();
  };
}
```

`apps/api/test/helpers.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp, type App } from '../src/app';
import type { Config } from '../src/config';
import { createDb, migrateDb } from '../src/db/client';
import type { AppDeps } from '../src/deps';
import { Storage } from '../src/lib/storage';

const enc = new TextEncoder();

export async function createTestDatabase(): Promise<string> {
  const uri = inject('pgUri');
  const admin = new pg.Client({ connectionString: uri });
  await admin.connect();
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(uri);
  url.pathname = `/${name}`;
  return url.toString();
}

export function testConfig(databaseUrl: string, storageDir: string): Config {
  return {
    databaseUrl,
    appSecret: enc.encode('test-app-secret-'.repeat(3)),
    encryptionKey: Buffer.alloc(32, 3),
    onlyofficeJwtSecret: enc.encode('test-onlyoffice-secret-'.repeat(2)),
    onlyofficeInternalUrl: 'http://onlyoffice',
    apiInternalUrl: 'http://api:3000',
    carboneUrl: 'http://carbone:4000',
    storageDir,
    queryTimeoutMs: 2000,
    queryMaxRows: 1000,
    renderTimeoutMs: 5000,
    reportRetentionDays: 30,
    tz: 'Europe/Moscow',
    port: 0,
    cookieSecure: false,
  };
}

const notConfigured = (what: string) => () => {
  throw new Error(`${what} не настроен в тесте`);
};

export interface TestApp {
  app: App;
  deps: AppDeps;
  close(): Promise<void>;
}

export async function createTestApp(
  overrides: Partial<Omit<AppDeps, 'config' | 'db' | 'storage'>> = {},
): Promise<TestApp> {
  const databaseUrl = await createTestDatabase();
  const storageDir = await mkdtemp(join(tmpdir(), 'cr-test-'));
  const config = testConfig(databaseUrl, storageDir);
  const { db, pool } = createDb(databaseUrl);
  await migrateDb(db);
  const deps: AppDeps = {
    config,
    db,
    storage: new Storage(storageDir),
    sources: {
      get: notConfigured('sources'),
      invalidate: async () => {},
      closeAll: async () => {},
    },
    carbone: { render: notConfigured('carbone') },
    onlyoffice: { forceSave: notConfigured('onlyoffice') },
    fetchFile: notConfigured('fetchFile'),
    ...overrides,
  };
  const app = await buildApp(deps);
  return {
    app,
    deps,
    async close() {
      await app.close();
      await deps.sources.closeAll();
      await pool.end();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 5: Интеграционный тест (падает, пока Docker не запущен или миграция не применяется)**

`apps/api/test/db.int.test.ts`:
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('база данных', () => {
  it('миграции создали все таблицы', async () => {
    const r = await t.deps.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(r.rows.map((x) => x.table_name)).toEqual(
      expect.arrayContaining(['datasources', 'report_runs', 'template_params', 'template_queries', 'templates', 'users']),
    );
  });
  it('GET /api/health работает', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 6: Запустить Docker и интеграционные тесты**

Docker Desktop должен быть запущен (`docker info` без ошибки).

```bash
pnpm --filter @carbone-reports/api test:int
```
Expected: PASS (2 теста). Если ошибка `Could not find a working container runtime strategy` — не запущен Docker.

- [ ] **Step 7: typecheck и commit**

```bash
pnpm -r typecheck && pnpm --filter @carbone-reports/api test
git add -A
git commit -m "feat(api): db schema, migrations, deps contract, integration test harness"
```

---

### Task 4: Аутентификация, сессии, первый админ

**Files:**
- Create: `apps/api/src/modules/auth/password.ts`, `apps/api/src/modules/auth/session.ts`, `apps/api/src/modules/auth/guards.ts`, `apps/api/src/modules/auth/routes.ts`, `apps/api/src/modules/auth/bootstrap.ts`
- Test: `apps/api/src/modules/auth/session.test.ts`, `apps/api/test/auth.int.test.ts`
- Modify: `apps/api/src/app.ts` (cookie-плагин, маршруты auth), `apps/api/test/helpers.ts` (`loginAs`)

**Interfaces:**
- Consumes: `AppDeps`, `users`, `AppError`-фабрики.
- Produces:
  - `hashPassword(p): Promise<string>`, `verifyPassword(hash, p): Promise<boolean>`
  - `signSession(user: SessionUser, secret: Uint8Array): Promise<string>`, `verifySession(token, secret): Promise<SessionUser | null>`; `interface SessionUser { id: string; login: string; role: Role }`; `SESSION_COOKIE = 'session'`
  - `makeGuards(deps): { requireUser: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }` — устанавливают `req.user: SessionUser`
  - Расширение типов: `FastifyRequest.user?: SessionUser`; в маршрутах после guard'а использовать хелпер `currentUser(req): SessionUser`
  - `ensureAdmin(deps): Promise<void>`
  - Маршруты: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`
  - Хелпер теста: `loginAs(t: TestApp, role: Role): Promise<{ cookie: string; user: UserRow }>`

- [ ] **Step 1: Юнит-тест сессии**

`apps/api/src/modules/auth/session.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from './session';

const secret = new TextEncoder().encode('s'.repeat(32));
const user = { id: '00000000-0000-0000-0000-000000000001', login: 'admin', role: 'admin' as const };

describe('session', () => {
  it('подписывает и проверяет', async () => {
    expect(await verifySession(await signSession(user, secret), secret)).toEqual(user);
  });
  it('null на чужой подписи', async () => {
    const other = new TextEncoder().encode('x'.repeat(32));
    expect(await verifySession(await signSession(user, other), secret)).toBeNull();
  });
  it('null на мусоре', async () => {
    expect(await verifySession('garbage', secret)).toBeNull();
  });
});
```

- [ ] **Step 2: Интеграционный тест**

`apps/api/test/auth.int.test.ts`:
```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { ensureAdmin } from '../src/modules/auth/bootstrap';
import { createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('auth', () => {
  it('ensureAdmin создаёт админа при пустой таблице и не дублирует', async () => {
    t.deps.config.adminLogin = 'root';
    t.deps.config.adminPassword = 'rootpass123';
    await ensureAdmin(t.deps);
    await ensureAdmin(t.deps);
    const rows = await t.deps.db.select().from(users).where(eq(users.login, 'root'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('admin');
  });

  it('вход с верным паролем ставит httpOnly cookie, /me возвращает пользователя', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'root', password: 'rootpass123' },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    const cookie = setCookie.split(';')[0]!;
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ login: 'root', role: 'admin' });
  });

  it('неверный пароль → 401 без подсказки, существует ли логин', async () => {
    const a = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'root', password: 'bad' } });
    const b = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'nobody', password: 'bad' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it('без cookie /me → 401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('заблокированный пользователь теряет доступ с уже выданной cookie', async () => {
    const { cookie, user } = await loginAs(t, 'user');
    await t.deps.db.update(users).set({ blocked: true }).where(eq(users.id, user.id));
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('logout очищает cookie', async () => {
    const { cookie } = await loginAs(t, 'user');
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/session=;/);
  });
});
```

Добавить в `apps/api/test/helpers.ts`:
```ts
import type { Role } from '@carbone-reports/shared';
import { users, type UserRow } from '../src/db/schema';
import { hashPassword } from '../src/modules/auth/password';

export async function loginAs(t: TestApp, role: Role): Promise<{ cookie: string; user: UserRow }> {
  const login = `${role}_${randomUUID().slice(0, 8)}`;
  const [user] = await t.deps.db
    .insert(users)
    .values({ login, passwordHash: await hashPassword('password123'), role })
    .returning();
  const res = await t.app.inject({
    method: 'POST', url: '/api/auth/login', payload: { login, password: 'password123' },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { cookie, user: user! };
}
```

- [ ] **Step 3: Запустить — падают**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api test:int
```
Expected: FAIL — нет модулей `./session`, `../src/modules/auth/*`.

- [ ] **Step 4: Реализация**

`apps/api/src/modules/auth/password.ts`:
```ts
import argon2 from 'argon2';

export const hashPassword = (p: string) => argon2.hash(p, { type: argon2.argon2id });

export async function verifyPassword(hash: string, p: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, p);
  } catch {
    return false;
  }
}

// Хеш для выравнивания времени ответа при несуществующем логине.
export const DUMMY_HASH_PROMISE = hashPassword('dummy-password-for-timing');
```

`apps/api/src/modules/auth/session.ts`:
```ts
import { Role } from '@carbone-reports/shared';
import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionUser {
  id: string;
  login: string;
  role: Role;
}

export function signSession(user: SessionUser, secret: Uint8Array): Promise<string> {
  return new SignJWT({ login: user.login, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifySession(token: string, secret: Uint8Array): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    const role = Role.safeParse(payload.role);
    if (!payload.sub || typeof payload.login !== 'string' || !role.success) return null;
    return { id: payload.sub, login: payload.login, role: role.data };
  } catch {
    return null;
  }
}
```

`apps/api/src/modules/auth/guards.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { forbidden, unauthorized } from '../../lib/errors';
import { SESSION_COOKIE, verifySession, type SessionUser } from './session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function makeGuards(deps: AppDeps) {
  async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = req.cookies[SESSION_COOKIE];
    const session = token ? await verifySession(token, deps.config.appSecret) : null;
    if (!session) throw unauthorized();
    // Роль и блокировка берутся из БД: изменения применяются сразу, без перевыпуска cookie.
    const [row] = await deps.db.select().from(users).where(eq(users.id, session.id));
    if (!row || row.blocked) throw unauthorized();
    req.user = { id: row.id, login: row.login, role: row.role };
  }

  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireUser(req, reply);
    if (req.user!.role !== 'admin') throw forbidden();
  }

  return { requireUser, requireAdmin };
}

export type Guards = ReturnType<typeof makeGuards>;
```

`apps/api/src/modules/auth/routes.ts`:
```ts
import { LoginBody } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import type { App } from '../../app';
import { users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { currentUser, type Guards } from './guards';
import { DUMMY_HASH_PROMISE, verifyPassword } from './password';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from './session';

export function registerAuthRoutes(app: App, deps: AppDeps, guards: Guards): void {
  app.post('/api/auth/login', { schema: { body: LoginBody } }, async (req, reply) => {
    const [row] = await deps.db.select().from(users).where(eq(users.login, req.body.login));
    const ok = await verifyPassword(row?.passwordHash ?? (await DUMMY_HASH_PROMISE), req.body.password);
    if (!row || !ok || row.blocked) {
      throw new AppError('INVALID_CREDENTIALS', 401, 'неверный логин или пароль');
    }
    const user = { id: row.id, login: row.login, role: row.role };
    reply.setCookie(SESSION_COOKIE, await signSession(user, deps.config.appSecret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.config.cookieSecure,
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return user;
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: guards.requireUser }, async (req) => currentUser(req));
}
```

`apps/api/src/modules/auth/bootstrap.ts`:
```ts
import { count } from 'drizzle-orm';
import { users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { hashPassword } from './password';

export async function ensureAdmin(deps: AppDeps): Promise<void> {
  const { adminLogin, adminPassword } = deps.config;
  if (!adminLogin || !adminPassword) return;
  const [r] = await deps.db.select({ n: count() }).from(users);
  if (r && r.n > 0) return;
  await deps.db
    .insert(users)
    .values({ login: adminLogin, passwordHash: await hashPassword(adminPassword), role: 'admin' })
    .onConflictDoNothing();
}
```

Изменить `apps/api/src/app.ts` — итоговый `buildApp`:
```ts
import cookie from '@fastify/cookie';
import { makeGuards } from './modules/auth/guards';
import { registerAuthRoutes } from './modules/auth/routes';
// ...
export async function buildApp(deps: AppDeps): Promise<App> {
  const app = createFastify();
  registerErrorHandler(app);
  await app.register(cookie);
  const guards = makeGuards(deps);

  app.get('/api/health', async () => ({ status: 'ok' }));
  registerAuthRoutes(app, deps, guards);

  await app.ready();
  return app;
}
```

- [ ] **Step 5: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api test:int && pnpm -r typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): login/logout/me with JWT cookie sessions, role guards, admin bootstrap"
```

---

### Task 5: Пользователи (CRUD для админа)

**Files:**
- Create: `apps/api/src/modules/users/routes.ts`
- Test: `apps/api/test/users.int.test.ts`
- Modify: `apps/api/src/app.ts` (регистрация)

**Interfaces:**
- Consumes: `Guards`, `hashPassword`, `CreateUserBody`, `UpdateUserBody`, `UserDto`.
- Produces: `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id`; `toUserDto(row: UserRow): UserDto`.

- [ ] **Step 1: Тест**

`apps/api/test/users.int.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: { cookie: string; user: { id: string } };
let user: { cookie: string };
beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t, 'admin');
  user = await loginAs(t, 'user');
});
afterAll(() => t.close());

describe('users', () => {
  it('user получает 403', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('создание, список без хешей паролей, дубликат логина → 409', async () => {
    const create = await t.app.inject({
      method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { login: 'ivanov', password: 'password1', role: 'user' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).not.toHaveProperty('passwordHash');

    const dup = await t.app.inject({
      method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { login: 'ivanov', password: 'password1', role: 'user' },
    });
    expect(dup.statusCode).toBe(409);

    const list = await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin.cookie } });
    expect(list.json().map((u: { login: string }) => u.login)).toContain('ivanov');
    expect(JSON.stringify(list.json())).not.toMatch(/argon2/);
  });

  it('смена пароля и блокировка', async () => {
    const created = await t.app.inject({
      method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { login: 'petrov', password: 'password1', role: 'user' },
    });
    const id = created.json().id;
    await t.app.inject({
      method: 'PATCH', url: `/api/users/${id}`, headers: { cookie: admin.cookie },
      payload: { password: 'newpassword' },
    });
    const login = await t.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'petrov', password: 'newpassword' },
    });
    expect(login.statusCode).toBe(200);

    const blocked = await t.app.inject({
      method: 'PATCH', url: `/api/users/${id}`, headers: { cookie: admin.cookie }, payload: { blocked: true },
    });
    expect(blocked.json().blocked).toBe(true);
  });

  it('админ не может заблокировать, понизить или удалить сам себя', async () => {
    const self = `/api/users/${admin.user.id}`;
    const block = await t.app.inject({ method: 'PATCH', url: self, headers: { cookie: admin.cookie }, payload: { blocked: true } });
    const demote = await t.app.inject({ method: 'PATCH', url: self, headers: { cookie: admin.cookie }, payload: { role: 'user' } });
    const del = await t.app.inject({ method: 'DELETE', url: self, headers: { cookie: admin.cookie } });
    expect([block.statusCode, demote.statusCode, del.statusCode]).toEqual([400, 400, 400]);
  });

  it('несуществующий id → 404, невалидный uuid → 400', async () => {
    const r404 = await t.app.inject({
      method: 'PATCH', url: '/api/users/00000000-0000-0000-0000-000000000000',
      headers: { cookie: admin.cookie }, payload: { blocked: true },
    });
    const r400 = await t.app.inject({
      method: 'PATCH', url: '/api/users/not-a-uuid', headers: { cookie: admin.cookie }, payload: { blocked: true },
    });
    expect(r404.statusCode).toBe(404);
    expect(r400.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Запустить — падает** (`404` вместо `403`/`201`: маршрутов нет)

```bash
pnpm --filter @carbone-reports/api test:int -- users
```

- [ ] **Step 3: Реализация**

Добавить в `packages/shared/src/index.ts`:
```ts
export const IdParams = z.object({ id: z.uuid('неверный идентификатор') });
export type IdParams = z.infer<typeof IdParams>;
```

`apps/api/src/modules/users/routes.ts`:
```ts
import { CreateUserBody, IdParams, UpdateUserBody, type UserDto } from '@carbone-reports/shared';
import { asc, eq } from 'drizzle-orm';
import type { App } from '../../app';
import { users, type UserRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import { hashPassword } from '../auth/password';

export const toUserDto = (r: UserRow): UserDto => ({
  id: r.id,
  login: r.login,
  role: r.role,
  blocked: r.blocked,
  createdAt: r.createdAt.toISOString(),
});

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505'
  || (e as { cause?: { code?: string } })?.cause?.code === '23505';

export function registerUserRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const pre = { preHandler: guards.requireAdmin };

  app.get('/api/users', pre, async () => {
    const rows = await deps.db.select().from(users).orderBy(asc(users.login));
    return rows.map(toUserDto);
  });

  app.post('/api/users', { ...pre, schema: { body: CreateUserBody } }, async (req, reply) => {
    try {
      const [row] = await deps.db
        .insert(users)
        .values({ login: req.body.login, role: req.body.role, passwordHash: await hashPassword(req.body.password) })
        .returning();
      return reply.status(201).send(toUserDto(row!));
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('пользователь с таким логином уже существует');
      throw e;
    }
  });

  app.patch('/api/users/:id', { ...pre, schema: { params: IdParams, body: UpdateUserBody } }, async (req) => {
    const me = currentUser(req);
    const { password, role, blocked } = req.body;
    if (req.params.id === me.id && (blocked === true || role === 'user')) {
      throw badRequest('нельзя заблокировать или понизить собственную учётную запись');
    }
    const patch: Partial<UserRow> = {};
    if (password !== undefined) patch.passwordHash = await hashPassword(password);
    if (role !== undefined) patch.role = role;
    if (blocked !== undefined) patch.blocked = blocked;
    if (Object.keys(patch).length === 0) throw badRequest('нет изменений');
    const [row] = await deps.db.update(users).set(patch).where(eq(users.id, req.params.id)).returning();
    if (!row) throw notFound('пользователь');
    return toUserDto(row);
  });

  app.delete('/api/users/:id', { ...pre, schema: { params: IdParams } }, async (req, reply) => {
    if (req.params.id === currentUser(req).id) throw badRequest('нельзя удалить собственную учётную запись');
    const [row] = await deps.db.delete(users).where(eq(users.id, req.params.id)).returning();
    if (!row) throw notFound('пользователь');
    return reply.status(204).send();
  });
}
```

В `apps/api/src/app.ts` после `registerAuthRoutes(...)`:
```ts
import { registerUserRoutes } from './modules/users/routes';
// ...
  registerUserRoutes(app, deps, guards);
```

- [ ] **Step 4: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test:int && pnpm -r typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): admin user management"
```

---
### Task 6: Парсер именованных SQL-параметров

**Files:**
- Create: `apps/api/src/modules/queries/sql-params.ts`
- Test: `apps/api/src/modules/queries/sql-params.test.ts`

**Interfaces:**
- Produces: `parseSqlParams(sql: string): ParsedSql`, где `interface ParsedSql { text: string; names: string[] }` (`names[i]` соответствует `$${i+1}`); `class SqlParamError extends Error`.

- [ ] **Step 1: Тест**

`apps/api/src/modules/queries/sql-params.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseSqlParams, SqlParamError } from './sql-params';

const p = parseSqlParams;

describe('parseSqlParams', () => {
  it('заменяет параметры на $n по порядку первого появления', () => {
    expect(p('select * from t where a = :a and b > :b')).toEqual({
      text: 'select * from t where a = $1 and b > $2',
      names: ['a', 'b'],
    });
  });
  it('одинаковые имена получают один номер', () => {
    expect(p('where a = :x or b = :x or c = :y')).toEqual({
      text: 'where a = $1 or b = $1 or c = $2',
      names: ['x', 'y'],
    });
  });
  it('не трогает приведения типов ::', () => {
    expect(p('select :d::date, x::text')).toEqual({ text: 'select $1::date, x::text', names: ['d'] });
  });
  it('не трогает строковые литералы, включая экранированные кавычки', () => {
    expect(p("select ':no', 'it''s :no', :yes")).toEqual({
      text: "select ':no', 'it''s :no', $1",
      names: ['yes'],
    });
  });
  it("не трогает E'...' со слешами", () => {
    expect(p("select E'a\\' :no', :yes")).toEqual({ text: "select E'a\\' :no', $1", names: ['yes'] });
  });
  it('не трогает dollar-quoted строки', () => {
    expect(p('select $$ :no $$, $tag$ :no $tag$, :yes')).toEqual({
      text: 'select $$ :no $$, $tag$ :no $tag$, $1',
      names: ['yes'],
    });
  });
  it('не трогает идентификаторы в кавычках', () => {
    expect(p('select "col:no" from t where x = :yes')).toEqual({
      text: 'select "col:no" from t where x = $1',
      names: ['yes'],
    });
  });
  it('не трогает комментарии обоих видов, включая вложенные', () => {
    expect(p('select 1 -- :no\n, :yes /* :no /* :no */ :no */')).toEqual({
      text: 'select 1 -- :no\n, $1 /* :no /* :no */ :no */',
      names: ['yes'],
    });
  });
  it('не трогает срезы массивов с числами', () => {
    expect(p('select arr[1:2] from t')).toEqual({ text: 'select arr[1:2] from t', names: [] });
  });
  it('параметр в конце строки и рядом со скобками', () => {
    expect(p('where id in (:a,:b)')).toEqual({ text: 'where id in ($1,$2)', names: ['a', 'b'] });
  });
  it('запрещает позиционные $1', () => {
    expect(() => p('select $1')).toThrow(SqlParamError);
  });
  it('незакрытая строка не зацикливается', () => {
    expect(p("select ':x")).toEqual({ text: "select ':x", names: [] });
  });
  it('SQL без параметров возвращается как есть', () => {
    expect(p('select now()')).toEqual({ text: 'select now()', names: [] });
  });
});
```

- [ ] **Step 2: Запустить — падает**

```bash
pnpm --filter @carbone-reports/api test -- sql-params
```
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

`apps/api/src/modules/queries/sql-params.ts`:
```ts
export interface ParsedSql {
  text: string;
  names: string[];
}

export class SqlParamError extends Error {}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Заменяет :name на $n, пропуская строки, идентификаторы в кавычках, комментарии и ::cast. */
export function parseSqlParams(sql: string): ParsedSql {
  const names: string[] = [];
  const n = sql.length;
  let out = '';
  let i = 0;

  const copyTo = (end: number) => {
    const e = Math.min(end, n);
    out += sql.slice(i, e);
    i = e;
  };
  const prevIsIdent = (pos: number) => pos > 0 && IDENT_PART.test(sql[pos - 1]!);

  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      const e = sql.indexOf('\n', i);
      copyTo(e === -1 ? n : e + 1);
      continue;
    }

    if (c === '/' && next === '*') {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else {
          j++;
        }
      }
      copyTo(j);
      continue;
    }

    if (c === "'") {
      const isEscape = i > 0 && /[eE]/.test(sql[i - 1]!) && !prevIsIdent(i - 1);
      let j = i + 1;
      while (j < n) {
        if (isEscape && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      copyTo(j);
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      copyTo(j);
      continue;
    }

    if (c === '$' && !prevIsIdent(i)) {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        copyTo(end === -1 ? n : end + tag.length);
        continue;
      }
      if (next !== undefined && /[0-9]/.test(next)) {
        throw new SqlParamError('используйте именованные параметры :name вместо $1');
      }
    }

    if (c === ':') {
      if (next === ':') {
        out += '::';
        i += 2;
        continue;
      }
      if (next !== undefined && IDENT_START.test(next)) {
        let j = i + 1;
        while (j < n && IDENT_PART.test(sql[j]!)) j++;
        const name = sql.slice(i + 1, j);
        let idx = names.indexOf(name);
        if (idx === -1) idx = names.push(name) - 1;
        out += `$${idx + 1}`;
        i = j;
        continue;
      }
    }

    out += c;
    i++;
  }

  return { text: out, names };
}
```

- [ ] **Step 4: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test -- sql-params
```
Expected: PASS (13 тестов).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): named SQL parameter parser"
```

---

### Task 7: Валидация параметров отчёта и сборка данных

**Files:**
- Create: `apps/api/src/modules/queries/params.ts`, `apps/api/src/modules/queries/build-data.ts`
- Test: `apps/api/src/modules/queries/params.test.ts`, `apps/api/src/modules/queries/build-data.test.ts`

**Interfaces:**
- Consumes: `TemplateParam`, `ParamValue`, `ParamsInput`, `QueryMode`, `AppError`.
- Produces:
  - `resolveParams(defs: TemplateParam[], input: ParamsInput): Record<string, ParamValue>` — бросает `AppError('VALIDATION', 400, 'неверные параметры', { fields: Record<string,string> })`
  - `checkParamDefaults(defs: TemplateParam[]): void` — бросает тот же `VALIDATION`, если `defaultValue` не соответствует типу
  - `interface QueryResult { key: string; mode: QueryMode; columns: string[]; rows: Record<string, unknown>[] }`
  - `buildReportData(results: QueryResult[], params: Record<string, ParamValue>): Record<string, unknown>`

- [ ] **Step 1: Тесты**

`apps/api/src/modules/queries/params.test.ts`:
```ts
import type { TemplateParam } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { checkParamDefaults, resolveParams } from './params';

const def = (over: Partial<TemplateParam> & Pick<TemplateParam, 'name' | 'type'>): TemplateParam => ({
  label: over.name, required: false, defaultValue: null, options: null, ...over,
});

function fieldsOf(fn: () => unknown): Record<string, string> {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return ((e as AppError).details as { fields: Record<string, string> }).fields;
  }
  throw new Error('ожидалась ошибка');
}

describe('resolveParams', () => {
  it('принимает значения правильных типов', () => {
    const defs = [
      def({ name: 's', type: 'string' }),
      def({ name: 'n', type: 'number' }),
      def({ name: 'd', type: 'date' }),
      def({ name: 'b', type: 'boolean' }),
      def({ name: 'sel', type: 'select', options: [{ value: 'new', label: 'Новый' }] }),
    ];
    expect(resolveParams(defs, { s: 'x', n: 1.5, d: '2026-01-31', b: false, sel: 'new' })).toEqual({
      s: 'x', n: 1.5, d: '2026-01-31', b: false, sel: 'new',
    });
  });

  it('подставляет default, затем null для необязательных', () => {
    const defs = [def({ name: 'a', type: 'number', defaultValue: 10 }), def({ name: 'b', type: 'string' })];
    expect(resolveParams(defs, {})).toEqual({ a: 10, b: null });
  });

  it('пустая строка считается отсутствующим значением', () => {
    expect(resolveParams([def({ name: 'a', type: 'string', defaultValue: 'x' })], { a: '' })).toEqual({ a: 'x' });
  });

  it('обязательный без значения и без default → ошибка поля', () => {
    expect(fieldsOf(() => resolveParams([def({ name: 'a', type: 'date', required: true })], {}))).toEqual({
      a: 'обязательный параметр',
    });
  });

  it('несуществующая дата и неверный формат даты → ошибка', () => {
    const defs = [def({ name: 'a', type: 'date' }), def({ name: 'b', type: 'date' })];
    expect(fieldsOf(() => resolveParams(defs, { a: '2026-02-30', b: '31.01.2026' }))).toEqual({
      a: 'ожидается дата ГГГГ-ММ-ДД',
      b: 'ожидается дата ГГГГ-ММ-ДД',
    });
  });

  it('строка вместо числа, NaN-подобное и значение вне select → ошибки', () => {
    const defs = [
      def({ name: 'n', type: 'number' }),
      def({ name: 's', type: 'select', options: [{ value: 'a', label: 'A' }] }),
      def({ name: 'b', type: 'boolean' }),
    ];
    expect(fieldsOf(() => resolveParams(defs, { n: '5', s: 'zzz', b: 'true' }))).toEqual({
      n: 'ожидается число',
      s: 'недопустимое значение',
      b: 'ожидается да/нет',
    });
  });

  it('лишние ключи во входе игнорируются', () => {
    expect(resolveParams([], { hacker: "'; drop table x; --" })).toEqual({});
  });
});

describe('checkParamDefaults', () => {
  it('отклоняет default неверного типа', () => {
    expect(fieldsOf(() => checkParamDefaults([def({ name: 'n', type: 'number', defaultValue: 'abc' })]))).toEqual({
      n: 'значение по умолчанию: ожидается число',
    });
  });
  it('принимает null default', () => {
    expect(() => checkParamDefaults([def({ name: 'n', type: 'number' })])).not.toThrow();
  });
});
```

`apps/api/src/modules/queries/build-data.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildReportData } from './build-data';

describe('buildReportData', () => {
  it('list → массив, single → объект, params добавляются', () => {
    const data = buildReportData(
      [
        { key: 'orders', mode: 'list', columns: ['id'], rows: [{ id: 1 }, { id: 2 }] },
        { key: 'company', mode: 'single', columns: ['name'], rows: [{ name: 'ООО Ромашка' }] },
      ],
      { dateFrom: '2026-01-01' },
    );
    expect(data).toEqual({
      orders: [{ id: 1 }, { id: 2 }],
      company: { name: 'ООО Ромашка' },
      params: { dateFrom: '2026-01-01' },
    });
  });
  it('single без строк → null, list без строк → []', () => {
    expect(
      buildReportData(
        [
          { key: 'a', mode: 'single', columns: [], rows: [] },
          { key: 'b', mode: 'list', columns: [], rows: [] },
        ],
        {},
      ),
    ).toEqual({ a: null, b: [], params: {} });
  });
});
```

- [ ] **Step 2: Запустить — падают**

```bash
pnpm --filter @carbone-reports/api test -- params build-data
```
Expected: FAIL — модули не найдены.

- [ ] **Step 3: Реализация**

`apps/api/src/modules/queries/params.ts`:
```ts
import { DATE_RE, type ParamValue, type ParamsInput, type TemplateParam } from '@carbone-reports/shared';
import { AppError } from '../../lib/errors';

function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Возвращает текст ошибки или null, если значение подходит под тип. */
function checkValue(def: TemplateParam, v: Exclude<ParamValue, null>): string | null {
  switch (def.type) {
    case 'string':
      return typeof v === 'string' ? null : 'ожидается строка';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'ожидается число';
    case 'date':
      return typeof v === 'string' && isValidDate(v) ? null : 'ожидается дата ГГГГ-ММ-ДД';
    case 'boolean':
      return typeof v === 'boolean' ? null : 'ожидается да/нет';
    case 'select':
      return typeof v === 'string' && (def.options ?? []).some((o) => o.value === v)
        ? null
        : 'недопустимое значение';
  }
}

const isEmpty = (v: ParamValue | undefined): v is null | undefined | '' =>
  v === undefined || v === null || v === '';

function fail(fields: Record<string, string>): never {
  throw new AppError('VALIDATION', 400, 'неверные параметры', { fields });
}

export function resolveParams(defs: TemplateParam[], input: ParamsInput): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const fields: Record<string, string> = {};
  for (const def of defs) {
    const raw = input[def.name];
    const value = isEmpty(raw) ? def.defaultValue : raw;
    if (isEmpty(value)) {
      if (def.required) fields[def.name] = 'обязательный параметр';
      out[def.name] = null;
      continue;
    }
    const err = checkValue(def, value);
    if (err) fields[def.name] = err;
    else out[def.name] = value;
  }
  if (Object.keys(fields).length > 0) fail(fields);
  return out;
}

export function checkParamDefaults(defs: TemplateParam[]): void {
  const fields: Record<string, string> = {};
  for (const def of defs) {
    if (isEmpty(def.defaultValue)) continue;
    const err = checkValue(def, def.defaultValue);
    if (err) fields[def.name] = `значение по умолчанию: ${err}`;
  }
  if (Object.keys(fields).length > 0) fail(fields);
}
```

`apps/api/src/modules/queries/build-data.ts`:
```ts
import type { ParamValue, QueryMode } from '@carbone-reports/shared';

export interface QueryResult {
  key: string;
  mode: QueryMode;
  columns: string[];
  rows: Record<string, unknown>[];
}

export function buildReportData(
  results: QueryResult[],
  params: Record<string, ParamValue>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const r of results) {
    data[r.key] = r.mode === 'single' ? (r.rows[0] ?? null) : r.rows;
  }
  data.params = params;
  return data;
}
```

- [ ] **Step 4: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): report parameter validation and data assembly"
```

---

### Task 8: Источники данных — CRUD, пулы соединений, проверка соединения

**Files:**
- Create: `apps/api/src/modules/datasources/pools.ts`, `apps/api/src/modules/datasources/routes.ts`
- Test: `apps/api/test/datasources.int.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Consumes: `SourcePools` (`deps.ts`), `encryptSecret`/`decryptSecret`, `DatasourceBody`, `DatasourceDto`, `IdParams`.
- Produces:
  - `createSourcePools(deps: { db: Db; config: Config }): SourcePools`
  - `SOURCE_TYPES: pg.CustomTypesConfig` (int8/numeric → number, если |x| ≤ 2^53−1, иначе строка; date → строка `YYYY-MM-DD`), `toSafeNumber(v: string): number | string`
  - Маршруты: `GET /api/datasources`, `POST /api/datasources`, `PATCH /api/datasources/:id`, `DELETE /api/datasources/:id`, `POST /api/datasources/test` (проверка без сохранения), `POST /api/datasources/:id/test` → `{ ok: true } | { ok: false; message: string }`
  - Хелперы тестов: `createSourceDatabase(seedSql: string): Promise<SourceConn>`, `interface SourceConn { host: string; port: number; database: string; username: string; password: string }`; `createTestApp` по умолчанию использует настоящие `createSourcePools`.

- [ ] **Step 1: Хелперы тестов**

В `apps/api/test/helpers.ts`:

Добавить импорт и функцию:
```ts
import { createSourcePools } from '../src/modules/datasources/pools';

export interface SourceConn {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export async function createSourceDatabase(seedSql: string): Promise<SourceConn> {
  const url = new URL(await createTestDatabase());
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(seedSql);
  await client.end();
  return {
    host: url.hostname,
    port: Number(url.port),
    database: url.pathname.slice(1),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
```

В `createTestApp` заменить заглушку `sources` на реальные пулы:
```ts
    sources: createSourcePools({ db, config }),
```

- [ ] **Step 2: Тест**

`apps/api/test/datasources.int.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSourceDatabase, createTestApp, loginAs, type SourceConn, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let user: string;
let src: SourceConn;
beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
  src = await createSourceDatabase('create table items(id int, price numeric, d date); insert into items values (1, 9.5, \'2026-01-31\');');
});
afterAll(() => t.close());

const body = () => ({ name: 'Склад', ...src, ssl: false });

describe('datasources', () => {
  it('user → 403', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/datasources', headers: { cookie: user } });
    expect(r.statusCode).toBe(403);
  });

  it('создание без пароля → 400', async () => {
    const { password: _, ...noPass } = body();
    const r = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: noPass });
    expect(r.statusCode).toBe(400);
  });

  it('создание, пароль не возвращается и хранится зашифрованным', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    expect(r.statusCode).toBe(201);
    expect(r.json()).not.toHaveProperty('password');
    expect(r.json()).not.toHaveProperty('passwordEnc');
    const list = await t.app.inject({ method: 'GET', url: '/api/datasources', headers: { cookie: admin } });
    expect(JSON.stringify(list.json())).not.toContain(src.password);
  });

  it('проверка соединения: успешная и с неверным паролем', async () => {
    const ok = await t.app.inject({ method: 'POST', url: '/api/datasources/test', headers: { cookie: admin }, payload: body() });
    expect(ok.json()).toEqual({ ok: true });
    const bad = await t.app.inject({
      method: 'POST', url: '/api/datasources/test', headers: { cookie: admin }, payload: { ...body(), password: 'wrong' },
    });
    expect(bad.json().ok).toBe(false);
    expect(bad.json().message).toMatch(/password|парол/i);
  });

  it('пул применяет парсеры типов: numeric → number, date → строка', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    const { pool } = await t.deps.sources.get(created.json().id);
    const r = await pool.query('select price, d from items');
    expect(r.rows[0]).toEqual({ price: 9.5, d: '2026-01-31' });
  });

  it('bigint за пределами 2^53 остаётся строкой без потери точности', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    const { pool } = await t.deps.sources.get(created.json().id);
    const r = await pool.query("select 9007199254740993::int8 as big, 42::int8 as small, 12345678901234567890.5::numeric as huge");
    expect(r.rows[0]).toEqual({ big: '9007199254740993', small: 42, huge: '12345678901234567890.5' });
  });

  it('PATCH без пароля сохраняет старый пароль, проверка по id проходит', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    const id = created.json().id;
    const { password: _, ...noPass } = body();
    const upd = await t.app.inject({
      method: 'PATCH', url: `/api/datasources/${id}`, headers: { cookie: admin }, payload: { ...noPass, name: 'Склад 2' },
    });
    expect(upd.json().name).toBe('Склад 2');
    const test = await t.app.inject({ method: 'POST', url: `/api/datasources/${id}/test`, headers: { cookie: admin } });
    expect(test.json()).toEqual({ ok: true });
  });

  it('PATCH с новым паролем сбрасывает закэшированный пул', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    const id = created.json().id;
    await t.deps.sources.get(id);
    await t.app.inject({
      method: 'PATCH', url: `/api/datasources/${id}`, headers: { cookie: admin }, payload: { ...body(), password: 'wrong' },
    });
    const test = await t.app.inject({ method: 'POST', url: `/api/datasources/${id}/test`, headers: { cookie: admin } });
    expect(test.json().ok).toBe(false);
  });

  it('удаление несуществующего → 404', async () => {
    const r = await t.app.inject({
      method: 'DELETE', url: '/api/datasources/00000000-0000-0000-0000-000000000000', headers: { cookie: admin },
    });
    expect(r.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Запустить — падает**

```bash
pnpm --filter @carbone-reports/api test:int -- datasources
```
Expected: FAIL — `Cannot find module '../src/modules/datasources/pools'`.

- [ ] **Step 4: Реализация**

`apps/api/src/modules/datasources/pools.ts`:
```ts
import { eq } from 'drizzle-orm';
import pg from 'pg';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { datasources, type DatasourceRow } from '../../db/schema';
import type { SourcePools } from '../../deps';
import { decryptSecret } from '../../lib/crypto';
import { notFound } from '../../lib/errors';

const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082 } as const;

/** Число, если оно представимо без потери целой части; иначе исходная строка. */
export function toSafeNumber(v: string): number | string {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : v;
}

/** Числа приходят в Carbone числами, даты без времени — строками ГГГГ-ММ-ДД. */
export const SOURCE_TYPES: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (oid === OID.INT8 || oid === OID.NUMERIC) return toSafeNumber;
    if (oid === OID.DATE) return (v: string) => v;
    return pg.types.getTypeParser(oid, format as 'text');
  }) as pg.CustomTypesConfig['getTypeParser'],
};

export interface ConnParams {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

export function poolConfig(c: ConnParams): pg.PoolConfig {
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.username,
    password: c.password,
    // Источники во внутренней сети часто с самоподписанными сертификатами.
    ssl: c.ssl ? { rejectUnauthorized: false } : false,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 60_000,
    types: SOURCE_TYPES,
  };
}

export function connParamsFromRow(row: DatasourceRow, key: Buffer): ConnParams {
  return {
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    password: decryptSecret(row.passwordEnc, key),
    ssl: row.ssl,
  };
}

export async function testConnection(c: ConnParams): Promise<{ ok: true } | { ok: false; message: string }> {
  const { max: _max, idleTimeoutMillis: _idle, ...cfg } = poolConfig(c);
  const client = new pg.Client(cfg);
  try {
    await client.connect();
    await client.query('select 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  } finally {
    await client.end().catch(() => {});
  }
}

export function createSourcePools(deps: { db: Db; config: Config }): SourcePools {
  const cache = new Map<string, Promise<{ pool: pg.Pool; name: string }>>();

  async function open(id: string) {
    const [row] = await deps.db.select().from(datasources).where(eq(datasources.id, id));
    if (!row) throw notFound('источник данных');
    const pool = new pg.Pool(poolConfig(connParamsFromRow(row, deps.config.encryptionKey)));
    // Ошибки простаивающих соединений не должны ронять процесс.
    pool.on('error', () => {});
    return { pool, name: row.name };
  }

  return {
    get(id) {
      let entry = cache.get(id);
      if (!entry) {
        entry = open(id);
        cache.set(id, entry);
        entry.catch(() => cache.delete(id));
      }
      return entry;
    },
    async invalidate(id) {
      const entry = cache.get(id);
      cache.delete(id);
      if (entry) await entry.then((e) => e.pool.end()).catch(() => {});
    },
    async closeAll() {
      const ids = [...cache.keys()];
      await Promise.all(ids.map((id) => this.invalidate(id)));
    },
  };
}
```

`apps/api/src/modules/datasources/routes.ts`:
```ts
import { DatasourceBody, IdParams, type DatasourceDto } from '@carbone-reports/shared';
import { asc, eq } from 'drizzle-orm';
import type { App } from '../../app';
import { datasources, templates, type DatasourceRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { encryptSecret } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { Guards } from '../auth/guards';
import { connParamsFromRow, testConnection } from './pools';

export const toDatasourceDto = (r: DatasourceRow): DatasourceDto => ({
  id: r.id,
  name: r.name,
  host: r.host,
  port: r.port,
  database: r.database,
  username: r.username,
  ssl: r.ssl,
  createdAt: r.createdAt.toISOString(),
});

export function registerDatasourceRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const pre = { preHandler: guards.requireAdmin };
  const key = deps.config.encryptionKey;

  app.get('/api/datasources', pre, async () => {
    const rows = await deps.db.select().from(datasources).orderBy(asc(datasources.name));
    return rows.map(toDatasourceDto);
  });

  app.post('/api/datasources', { ...pre, schema: { body: DatasourceBody } }, async (req, reply) => {
    const { password, ...rest } = req.body;
    if (!password) throw badRequest('пароль обязателен');
    const [row] = await deps.db
      .insert(datasources)
      .values({ ...rest, passwordEnc: encryptSecret(password, key) })
      .returning();
    return reply.status(201).send(toDatasourceDto(row!));
  });

  app.patch(
    '/api/datasources/:id',
    { ...pre, schema: { params: IdParams, body: DatasourceBody } },
    async (req) => {
      const { password, ...rest } = req.body;
      const patch: Partial<DatasourceRow> = { ...rest };
      if (password) patch.passwordEnc = encryptSecret(password, key);
      const [row] = await deps.db
        .update(datasources)
        .set(patch)
        .where(eq(datasources.id, req.params.id))
        .returning();
      if (!row) throw notFound('источник данных');
      await deps.sources.invalidate(row.id);
      return toDatasourceDto(row);
    },
  );

  app.delete('/api/datasources/:id', { ...pre, schema: { params: IdParams } }, async (req, reply) => {
    const used = await deps.db
      .select({ id: templates.id })
      .from(templates)
      .where(eq(templates.datasourceId, req.params.id))
      .limit(1);
    if (used.length > 0) throw conflict('источник используется шаблонами');
    const [row] = await deps.db.delete(datasources).where(eq(datasources.id, req.params.id)).returning();
    if (!row) throw notFound('источник данных');
    await deps.sources.invalidate(row.id);
    return reply.status(204).send();
  });

  app.post('/api/datasources/test', { ...pre, schema: { body: DatasourceBody } }, async (req) => {
    if (!req.body.password) throw badRequest('пароль обязателен');
    return testConnection({ ...req.body, password: req.body.password });
  });

  app.post('/api/datasources/:id/test', { ...pre, schema: { params: IdParams } }, async (req) => {
    const [row] = await deps.db.select().from(datasources).where(eq(datasources.id, req.params.id));
    if (!row) throw notFound('источник данных');
    return testConnection(connParamsFromRow(row, key));
  });
}
```

В `apps/api/src/app.ts`:
```ts
import { registerDatasourceRoutes } from './modules/datasources/routes';
// ...
  registerDatasourceRoutes(app, deps, guards);
```

- [ ] **Step 5: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test:int && pnpm -r typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): datasources CRUD, connection pools with type parsers, connection test"
```

---

### Task 9: Выполнение запросов в read-only транзакции

**Files:**
- Create: `apps/api/src/modules/queries/executor.ts`
- Test: `apps/api/test/executor.int.test.ts`

**Interfaces:**
- Consumes: `parseSqlParams`, `SqlParamError` (Task 6), `QueryResult` (Task 7), `TemplateQuery`, `ParamValue`, `RunQueryResult`, `SOURCE_TYPES`/`poolConfig` (Task 8), `AppError`.
- Produces:
  - `interface QueryLimits { timeoutMs: number; maxRows: number }`
  - `runQueries(pool: pg.Pool, sourceName: string, queries: TemplateQuery[], params: Record<string, ParamValue>, limits: QueryLimits): Promise<QueryResult[]>`
  - `previewQuery(pool: pg.Pool, sourceName: string, sql: string, params: Record<string, ParamValue>, limits: QueryLimits & { previewRows: number }): Promise<RunQueryResult>`
  - Коды ошибок: `SQL_ERROR` (400), `CONFIG` (400, неизвестный параметр), `TOO_MANY_ROWS` (400), `TIMEOUT` (504), `DATASOURCE_UNAVAILABLE` (502).

- [ ] **Step 1: Тест**

`apps/api/test/executor.int.test.ts`:
```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import { poolConfig } from '../src/modules/datasources/pools';
import { previewQuery, runQueries } from '../src/modules/queries/executor';
import { createSourceDatabase } from './helpers';

let pool: pg.Pool;
const limits = { timeoutMs: 1000, maxRows: 5 };

beforeAll(async () => {
  const src = await createSourceDatabase(`
    create table orders(id int primary key, total numeric, created date);
    insert into orders select g, g * 10, date '2026-01-01' + g from generate_series(1, 3) g;
    create table company(name text);
    insert into company values ('ООО Ромашка');
    create table big as select generate_series(1, 20) as n;
  `);
  pool = new pg.Pool(poolConfig({ ...src, ssl: false }));
});
afterAll(() => pool.end());

async function err(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('ожидалась ошибка');
}

describe('runQueries', () => {
  it('выполняет несколько запросов с параметрами', async () => {
    const r = await runQueries(
      pool, 'src',
      [
        { key: 'orders', mode: 'list', sql: 'select id, total from orders where created >= :from order by id' },
        { key: 'company', mode: 'single', sql: 'select name from company' },
      ],
      { from: '2026-01-03' },
      limits,
    );
    expect(r).toEqual([
      { key: 'orders', mode: 'list', columns: ['id', 'total'], rows: [{ id: 2, total: 20 }, { id: 3, total: 30 }] },
      { key: 'company', mode: 'single', columns: ['name'], rows: [{ name: 'ООО Ромашка' }] },
    ]);
  });

  it('колонки возвращаются и для пустого результата', async () => {
    const [r] = await runQueries(pool, 'src', [{ key: 'o', mode: 'list', sql: 'select id from orders where false' }], {}, limits);
    expect(r).toMatchObject({ columns: ['id'], rows: [] });
  });

  it('запрет записи: INSERT падает с понятной ошибкой', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 'w', mode: 'list', sql: 'insert into company values (\'x\') returning *' }], {}, limits));
    expect(e.code).toBe('SQL_ERROR');
    expect(e.message).toMatch(/^запрос "w": .*только на чтение/);
    const { rows } = await pool.query('select count(*)::int as n from company');
    expect(rows[0].n).toBe(1);
  });

  it('statement_timeout → TIMEOUT 504', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 's', mode: 'list', sql: 'select pg_sleep(3)' }], {}, limits));
    expect([e.code, e.status]).toEqual(['TIMEOUT', 504]);
  });

  it('превышение maxRows в list → TOO_MANY_ROWS', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 'big', mode: 'list', sql: 'select n from big' }], {}, limits));
    expect(e.code).toBe('TOO_MANY_ROWS');
    expect(e.message).toBe('запрос "big" вернул больше 5 строк');
  });

  it('single читает только первую строку и не упирается в лимит', async () => {
    const [r] = await runQueries(pool, 'src', [{ key: 'b', mode: 'single', sql: 'select n from big order by n' }], {}, limits);
    expect(r!.rows).toEqual([{ n: 1 }]);
  });

  it('синтаксическая ошибка → SQL_ERROR с ключом запроса', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 'bad', mode: 'list', sql: 'selec 1' }], {}, limits));
    expect(e.code).toBe('SQL_ERROR');
    expect(e.message).toMatch(/^запрос "bad": /);
  });

  it('неизвестный параметр → CONFIG', async () => {
    const e = await err(runQueries(pool, 'src', [{ key: 'q', mode: 'list', sql: 'select :nope' }], {}, limits));
    expect(e.code).toBe('CONFIG');
    expect(e.message).toBe('запрос "q": неизвестный параметр :nope');
  });

  it('значение параметра не интерпретируется как SQL', async () => {
    const [r] = await runQueries(pool, 'src', [{ key: 'q', mode: 'single', sql: 'select :v::text as v' }], { v: "'; drop table orders; --" }, limits);
    expect(r!.rows[0]).toEqual({ v: "'; drop table orders; --" });
    const { rows } = await pool.query('select count(*)::int as n from orders');
    expect(rows[0].n).toBe(3);
  });

  it('недоступный источник → DATASOURCE_UNAVAILABLE 502', async () => {
    const dead = new pg.Pool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 500 });
    const e = await err(runQueries(dead, 'Склад', [{ key: 'q', mode: 'list', sql: 'select 1' }], {}, limits));
    expect([e.code, e.status, e.message]).toEqual(['DATASOURCE_UNAVAILABLE', 502, 'не удалось подключиться к источнику "Склад"']);
    await dead.end();
  });

  it('после ошибки соединение возвращается в пул исправным', async () => {
    await err(runQueries(pool, 'src', [{ key: 'bad', mode: 'list', sql: 'selec 1' }], {}, limits));
    const [r] = await runQueries(pool, 'src', [{ key: 'ok', mode: 'single', sql: 'select 1 as x' }], {}, limits);
    expect(r!.rows).toEqual([{ x: 1 }]);
  });
});

describe('previewQuery', () => {
  it('возвращает не больше previewRows строк и флаг truncated', async () => {
    const r = await previewQuery(pool, 'src', 'select n from big order by n', {}, { ...limits, previewRows: 3 });
    expect(r).toEqual({ columns: ['n'], rows: [{ n: 1 }, { n: 2 }, { n: 3 }], truncated: true });
  });
  it('truncated=false, если строк меньше лимита', async () => {
    const r = await previewQuery(pool, 'src', 'select 1 as a', {}, { ...limits, previewRows: 3 });
    expect(r.truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Запустить — падает**

```bash
pnpm --filter @carbone-reports/api test:int -- executor
```
Expected: FAIL — модуль `executor` не найден.

- [ ] **Step 3: Реализация**

`apps/api/src/modules/queries/executor.ts`:
```ts
import type { ParamValue, RunQueryResult, TemplateQuery } from '@carbone-reports/shared';
import type pg from 'pg';
import Cursor from 'pg-cursor';
import { AppError } from '../../lib/errors';
import type { QueryResult } from './build-data';
import { parseSqlParams, SqlParamError } from './sql-params';

export interface QueryLimits {
  timeoutMs: number;
  maxRows: number;
}

type Row = Record<string, unknown>;

function mapPgError(key: string, e: unknown): unknown {
  const code = (e as { code?: string }).code;
  if (code === '57014') return new AppError('TIMEOUT', 504, 'превышено время ожидания');
  if (code === '25006') {
    return new AppError('SQL_ERROR', 400, `запрос "${key}": запись запрещена — запросы выполняются только на чтение`);
  }
  if (code) return new AppError('SQL_ERROR', 400, `запрос "${key}": ${(e as Error).message}`);
  return e;
}

async function withReadOnly<T>(
  pool: pg.Pool,
  sourceName: string,
  timeoutMs: number,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (e) {
    throw new AppError('DATASOURCE_UNAVAILABLE', 502, `не удалось подключиться к источнику "${sourceName}"`, {
      reason: (e as Error).message,
    });
  }
  let broken = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    return await fn(client);
  } catch (e) {
    broken = !(e instanceof AppError);
    throw e;
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    client.release(broken);
  }
}

function readBatch(cursor: Cursor, n: number): Promise<{ rows: Row[]; fields?: { name: string }[] }> {
  return new Promise((resolve, reject) => {
    cursor.read(n, (err, rows, result) => (err ? reject(err) : resolve({ rows, fields: result?.fields })));
  });
}

async function readQuery(
  client: pg.PoolClient,
  key: string,
  sql: string,
  params: Record<string, ParamValue>,
  limit: number,
): Promise<{ columns: string[]; rows: Row[]; truncated: boolean }> {
  let parsed;
  try {
    parsed = parseSqlParams(sql);
  } catch (e) {
    if (e instanceof SqlParamError) throw new AppError('SQL_ERROR', 400, `запрос "${key}": ${e.message}`);
    throw e;
  }
  const values = parsed.names.map((name) => {
    if (!(name in params)) throw new AppError('CONFIG', 400, `запрос "${key}": неизвестный параметр :${name}`);
    return params[name];
  });

  const cursor = client.query(new Cursor(parsed.text, values));
  try {
    const rows: Row[] = [];
    let columns: string[] = [];
    for (;;) {
      const size = Math.min(1000, limit + 1 - rows.length);
      const batch = await readBatch(cursor, size);
      if (columns.length === 0 && batch.fields) columns = batch.fields.map((f) => f.name);
      rows.push(...batch.rows);
      if (rows.length > limit) return { columns, rows: rows.slice(0, limit), truncated: true };
      if (batch.rows.length < size) {
        if (columns.length === 0 && rows[0]) columns = Object.keys(rows[0]);
        return { columns, rows, truncated: false };
      }
    }
  } catch (e) {
    throw mapPgError(key, e);
  } finally {
    await cursor.close().catch(() => {});
  }
}

export function runQueries(
  pool: pg.Pool,
  sourceName: string,
  queries: TemplateQuery[],
  params: Record<string, ParamValue>,
  limits: QueryLimits,
): Promise<QueryResult[]> {
  return withReadOnly(pool, sourceName, limits.timeoutMs, async (client) => {
    const results: QueryResult[] = [];
    for (const q of queries) {
      const limit = q.mode === 'single' ? 1 : limits.maxRows;
      const r = await readQuery(client, q.key, q.sql, params, limit);
      if (q.mode === 'list' && r.truncated) {
        throw new AppError('TOO_MANY_ROWS', 400, `запрос "${q.key}" вернул больше ${limits.maxRows} строк`);
      }
      results.push({ key: q.key, mode: q.mode, columns: r.columns, rows: r.rows });
    }
    return results;
  });
}

export function previewQuery(
  pool: pg.Pool,
  sourceName: string,
  sql: string,
  params: Record<string, ParamValue>,
  limits: QueryLimits & { previewRows: number },
): Promise<RunQueryResult> {
  return withReadOnly(pool, sourceName, limits.timeoutMs, (client) =>
    readQuery(client, 'preview', sql, params, limits.previewRows),
  );
}
```

> `cursor.close()` в `@types/pg-cursor` объявлен как `close(): Promise<void>`. Если typecheck сообщит, что `close` требует callback, использовать `new Promise<void>((r) => cursor.close(() => r()))`.

- [ ] **Step 4: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test:int -- executor && pnpm -r typecheck
```
Expected: PASS (13 тестов).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): read-only query executor with timeout, row limit and error mapping"
```

---

### Task 10: Шаблоны — CRUD, файлы, пустые заготовки, запросы и параметры

**Files:**
- Create: `apps/api/src/modules/templates/blank.ts`, `apps/api/src/modules/templates/service.ts`, `apps/api/src/modules/templates/routes.ts`, `apps/api/src/lib/http.ts`
- Test: `apps/api/src/modules/templates/blank.test.ts`, `apps/api/test/templates.int.test.ts`
- Modify: `apps/api/src/app.ts` (multipart, регистрация), `apps/api/test/helpers.ts` (`createTemplate`)

**Interfaces:**
- Consumes: `templates`, `templateQueries`, `templateParams`, `Storage`, `Guards`, `checkParamDefaults`, DTO из `shared`.
- Produces:
  - `createBlankDocument(ext: 'docx' | 'xlsx'): Promise<Buffer>`
  - `lib/http.ts`: `MIME: Record<OutputFormat | TemplateExt, string>`, `contentDisposition(filename: string): string`, `isZip(buf: Buffer): boolean`
  - `service.ts`:
    - `templateFilePath(id: string, ext: TemplateExt): string` → `templates/${id}.${ext}`
    - `loadTemplate(db, id): Promise<TemplateRow>` (404, если нет)
    - `loadTemplateFull(db, id): Promise<{ row: TemplateRow; queries: TemplateQuery[]; params: TemplateParam[] }>`
    - `toSummary(row): TemplateSummary`, `toDetails(full): TemplateDetails`, `toAdminDetails(full): TemplateAdminDetails`
    - `templateFileRef(deps, row): TemplateFileRef`
  - Маршруты: `GET /api/templates`, `GET /api/templates/:id`, `POST /api/templates` (JSON, пустой), `POST /api/templates/upload` (multipart: `name`, `description`, `datasourceId`, `file`), `PUT /api/templates/:id/file` (multipart `file`, замена), `PATCH /api/templates/:id`, `DELETE /api/templates/:id`, `POST /api/templates/:id/duplicate`, `GET /api/templates/:id/download`, `PUT /api/templates/:id/queries`, `PUT /api/templates/:id/params`
  - Хелпер тестов: `createTemplate(t, adminCookie, datasourceId, opts?: { queries?: TemplateQuery[]; params?: TemplateParam[] }): Promise<string>` (возвращает id)

- [ ] **Step 1: Юнит-тест пустых документов**

`apps/api/src/modules/templates/blank.test.ts`:
```ts
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { createBlankDocument } from './blank';

describe('createBlankDocument', () => {
  it('docx содержит обязательные части OOXML', async () => {
    const zip = await JSZip.loadAsync(await createBlankDocument('docx'));
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']),
    );
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<w:body>');
  });
  it('xlsx содержит книгу и лист', async () => {
    const zip = await JSZip.loadAsync(await createBlankDocument('xlsx'));
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']),
    );
  });
});
```

- [ ] **Step 2: Интеграционный тест**

`apps/api/test/templates.int.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlankDocument } from '../src/modules/templates/blank';
import { createSourceDatabase, createTemplate, createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let user: string;
let dsId: string;

function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer }) {
  const boundary = '----cr' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase('select 1');
  const ds = await t.app.inject({
    method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: { name: 'src', ...src, ssl: false },
  });
  dsId = ds.json().id;
});
afterAll(() => t.close());

describe('templates', () => {
  it('создание пустого docx: файл на диске, version=1, outputFormats', async () => {
    const r = await t.app.inject({
      method: 'POST', url: '/api/templates', headers: { cookie: admin },
      payload: { name: 'Счёт', datasourceId: dsId, blank: 'docx' },
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    const d = await t.app.inject({ method: 'GET', url: `/api/templates/${id}`, headers: { cookie: admin } });
    expect(d.json()).toMatchObject({
      name: 'Счёт', fileExt: 'docx', version: 1, queries: [], params: [], outputFormats: ['pdf', 'docx', 'odt'],
    });
    expect(await t.deps.storage.exists(`templates/${id}.docx`)).toBe(true);
  });

  it('user видит список и детали без SQL', async () => {
    const id = await createTemplate(t, admin, dsId, {
      queries: [{ key: 'q', mode: 'list', sql: 'select secret from t' }],
    });
    const list = await t.app.inject({ method: 'GET', url: '/api/templates', headers: { cookie: user } });
    expect(list.json().some((x: { id: string }) => x.id === id)).toBe(true);
    const d = await t.app.inject({ method: 'GET', url: `/api/templates/${id}`, headers: { cookie: user } });
    expect(d.statusCode).toBe(200);
    expect(d.json()).not.toHaveProperty('queries');
    expect(JSON.stringify(d.json())).not.toContain('secret');
  });

  it('user не может создавать и менять шаблоны', async () => {
    const r = await t.app.inject({
      method: 'POST', url: '/api/templates', headers: { cookie: user }, payload: { name: 'x', datasourceId: dsId, blank: 'docx' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('загрузка файла: xlsx принимается, текстовый файл с расширением .docx — 400', async () => {
    const xlsx = await createBlankDocument('xlsx');
    const good = multipart({ name: 'Таблица', description: '', datasourceId: dsId }, { name: 'Отчёт.xlsx', data: xlsx });
    const ok = await t.app.inject({
      method: 'POST', url: '/api/templates/upload', headers: { cookie: admin, ...good.headers }, payload: good.payload,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().fileExt).toBe('xlsx');

    const fake = multipart({ name: 'Фейк', description: '', datasourceId: dsId }, { name: 'a.docx', data: Buffer.from('hello') });
    const bad = await t.app.inject({ method: 'POST', url: '/api/templates/upload', headers: { cookie: admin, ...fake.headers }, payload: fake.payload });
    expect(bad.statusCode).toBe(400);

    const exe = multipart({ name: 'Exe', description: '', datasourceId: dsId }, { name: 'a.exe', data: xlsx });
    const badExt = await t.app.inject({ method: 'POST', url: '/api/templates/upload', headers: { cookie: admin, ...exe.headers }, payload: exe.payload });
    expect(badExt.statusCode).toBe(400);
  });

  it('PUT queries: дубликаты ключей → 400, повторное сохранение заменяет список', async () => {
    const id = await createTemplate(t, admin, dsId);
    const dup = await t.app.inject({
      method: 'PUT', url: `/api/templates/${id}/queries`, headers: { cookie: admin },
      payload: [{ key: 'a', mode: 'list', sql: 'select 1' }, { key: 'a', mode: 'single', sql: 'select 2' }],
    });
    expect(dup.statusCode).toBe(400);
    await t.app.inject({
      method: 'PUT', url: `/api/templates/${id}/queries`, headers: { cookie: admin },
      payload: [{ key: 'a', mode: 'list', sql: 'select 1' }, { key: 'b', mode: 'single', sql: 'select 2' }],
    });
    await t.app.inject({
      method: 'PUT', url: `/api/templates/${id}/queries`, headers: { cookie: admin },
      payload: [{ key: 'b', mode: 'single', sql: 'select 3' }],
    });
    const d = await t.app.inject({ method: 'GET', url: `/api/templates/${id}`, headers: { cookie: admin } });
    expect(d.json().queries).toEqual([{ key: 'b', mode: 'single', sql: 'select 3' }]);
  });

  it('PUT params: default неверного типа → 400 с полем', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await t.app.inject({
      method: 'PUT', url: `/api/templates/${id}/params`, headers: { cookie: admin },
      payload: [{ name: 'n', label: 'N', type: 'number', required: false, defaultValue: 'abc', options: null }],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fields).toHaveProperty('n');
  });

  it('PATCH defaultOutput, недопустимый для расширения → 400', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await t.app.inject({
      method: 'PATCH', url: `/api/templates/${id}`, headers: { cookie: admin }, payload: { defaultOutput: 'xlsx' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('дублирование копирует файл, запросы и параметры, но с новым doc key', async () => {
    const id = await createTemplate(t, admin, dsId, {
      queries: [{ key: 'q', mode: 'list', sql: 'select 1' }],
      params: [{ name: 'p', label: 'P', type: 'string', required: false, defaultValue: null, options: null }],
    });
    const r = await t.app.inject({ method: 'POST', url: `/api/templates/${id}/duplicate`, headers: { cookie: admin } });
    expect(r.statusCode).toBe(201);
    const copy = await t.app.inject({ method: 'GET', url: `/api/templates/${r.json().id}`, headers: { cookie: admin } });
    expect(copy.json()).toMatchObject({ queries: [{ key: 'q' }], params: [{ name: 'p' }] });
    expect(copy.json().name).toMatch(/\(копия\)$/);
    expect(await t.deps.storage.exists(`templates/${r.json().id}.docx`)).toBe(true);
  });

  it('скачивание: правильный MIME и кириллица в имени файла', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await t.app.inject({ method: 'GET', url: `/api/templates/${id}/download`, headers: { cookie: admin } });
    expect(r.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(r.headers['content-disposition']).toContain("filename*=UTF-8''");
  });

  it('удаление убирает файл', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await t.app.inject({ method: 'DELETE', url: `/api/templates/${id}`, headers: { cookie: admin } });
    expect(r.statusCode).toBe(204);
    expect(await t.deps.storage.exists(`templates/${id}.docx`)).toBe(false);
  });

  it('замена файла через PUT /file увеличивает version и меняет doc key', async () => {
    const id = await createTemplate(t, admin, dsId);
    const before = await t.app.inject({ method: 'GET', url: `/api/templates/${id}`, headers: { cookie: admin } });
    const docx = await createBlankDocument('docx');
    const mp = multipart({}, { name: 'new.docx', data: docx });
    const r = await t.app.inject({ method: 'PUT', url: `/api/templates/${id}/file`, headers: { cookie: admin, ...mp.headers }, payload: mp.payload });
    expect(r.statusCode).toBe(200);
    expect(r.json().version).toBe(before.json().version + 1);
  });
});
```

Добавить в `apps/api/test/helpers.ts`:
```ts
import type { TemplateParam, TemplateQuery } from '@carbone-reports/shared';

export async function createTemplate(
  t: TestApp,
  cookie: string,
  datasourceId: string,
  opts: { queries?: TemplateQuery[]; params?: TemplateParam[] } = {},
): Promise<string> {
  const r = await t.app.inject({
    method: 'POST', url: '/api/templates', headers: { cookie },
    payload: { name: `Шаблон ${randomUUID().slice(0, 4)}`, datasourceId, blank: 'docx' },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  const id = r.json().id as string;
  if (opts.queries) {
    await t.app.inject({ method: 'PUT', url: `/api/templates/${id}/queries`, headers: { cookie }, payload: opts.queries });
  }
  if (opts.params) {
    await t.app.inject({ method: 'PUT', url: `/api/templates/${id}/params`, headers: { cookie }, payload: opts.params });
  }
  return id;
}
```

- [ ] **Step 3: Запустить — падают**

```bash
pnpm --filter @carbone-reports/api test -- blank; pnpm --filter @carbone-reports/api test:int -- templates
```
Expected: FAIL — модули не найдены / 404.

- [ ] **Step 4: Реализация**

`apps/api/src/modules/templates/blank.ts`:
```ts
import JSZip from 'jszip';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

async function zip(files: Record<string, string>): Promise<Buffer> {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function docx(): Promise<Buffer> {
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_DOC}" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  });
}

function xlsx(): Promise<Buffer> {
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_DOC}" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
  });
}

export function createBlankDocument(ext: 'docx' | 'xlsx'): Promise<Buffer> {
  return ext === 'docx' ? docx() : xlsx();
}
```

`apps/api/src/lib/http.ts`:
```ts
import type { OutputFormat, TemplateExt } from '@carbone-reports/shared';

export const MIME: Record<OutputFormat | TemplateExt, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** OOXML и ODF — zip-архивы; сигнатура PK\x03\x04. */
export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}
```

`apps/api/src/modules/templates/service.ts`:
```ts
import {
  outputFormatsFor,
  type TemplateAdminDetails,
  type TemplateDetails,
  type TemplateExt,
  type TemplateParam,
  type TemplateQuery,
  type TemplateSummary,
} from '@carbone-reports/shared';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { templateParams, templateQueries, templates, type TemplateRow } from '../../db/schema';
import type { AppDeps, TemplateFileRef } from '../../deps';
import { notFound } from '../../lib/errors';

export interface TemplateFull {
  row: TemplateRow;
  queries: TemplateQuery[];
  params: TemplateParam[];
}

export const templateFilePath = (id: string, ext: TemplateExt) => `templates/${id}.${ext}`;

export async function loadTemplate(db: Db, id: string): Promise<TemplateRow> {
  const [row] = await db.select().from(templates).where(eq(templates.id, id));
  if (!row) throw notFound('шаблон');
  return row;
}

export async function loadTemplateFull(db: Db, id: string): Promise<TemplateFull> {
  const row = await loadTemplate(db, id);
  const [qs, ps] = await Promise.all([
    db.select().from(templateQueries).where(eq(templateQueries.templateId, id)).orderBy(asc(templateQueries.sortOrder)),
    db.select().from(templateParams).where(eq(templateParams.templateId, id)).orderBy(asc(templateParams.sortOrder)),
  ]);
  return {
    row,
    queries: qs.map((q) => ({ key: q.key, sql: q.sql, mode: q.mode })),
    params: ps.map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      required: p.required,
      defaultValue: p.defaultValue ?? null,
      options: p.options ?? null,
    })),
  };
}

export const toSummary = (r: TemplateRow): TemplateSummary => ({
  id: r.id,
  name: r.name,
  description: r.description,
  fileExt: r.fileExt,
  defaultOutput: r.defaultOutput,
  updatedAt: r.updatedAt.toISOString(),
});

export const toDetails = (f: TemplateFull): TemplateDetails => ({
  ...toSummary(f.row),
  params: f.params,
  outputFormats: outputFormatsFor(f.row.fileExt),
});

export const toAdminDetails = (f: TemplateFull): TemplateAdminDetails => ({
  ...toDetails(f),
  datasourceId: f.row.datasourceId,
  version: f.row.version,
  queries: f.queries,
  lastSaveError: f.row.lastSaveError,
});

export function templateFileRef(deps: AppDeps, row: TemplateRow): TemplateFileRef {
  return {
    id: row.id,
    version: row.version,
    ext: row.fileExt,
    read: () => deps.storage.read(row.filePath),
  };
}
```

`apps/api/src/modules/templates/routes.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  CreateTemplateBody,
  IdParams,
  outputFormatsFor,
  TemplateExt,
  TemplateParam,
  TemplateQuery,
  UpdateTemplateBody,
} from '@carbone-reports/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from '../../app';
import { datasources, templateParams, templateQueries, templates } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { badRequest } from '../../lib/errors';
import { contentDisposition, isZip, MIME } from '../../lib/http';
import { currentUser, type Guards } from '../auth/guards';
import { checkParamDefaults } from '../queries/params';
import { createBlankDocument } from './blank';
import { loadTemplate, loadTemplateFull, templateFilePath, toAdminDetails, toDetails, toSummary } from './service';

const MAX_FILE = 20 * 1024 * 1024;

function uniqueOrFail(values: string[], what: string): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) throw badRequest(`${what} "${v}" повторяется`);
    seen.add(v);
  }
}

export function registerTemplateRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const admin = { preHandler: guards.requireAdmin };
  const anyUser = { preHandler: guards.requireUser };
  const { db, storage } = deps;

  async function ensureDatasource(id: string) {
    const [ds] = await db.select({ id: datasources.id }).from(datasources).where(eq(datasources.id, id));
    if (!ds) throw badRequest('источник данных не найден');
  }

  async function readUpload(req: FastifyRequest) {
    const fields: Record<string, string> = {};
    let file: { filename: string; data: Buffer } | undefined;
    for await (const part of req.parts({ limits: { fileSize: MAX_FILE } })) {
      if (part.type === 'file') {
        const data = await part.toBuffer();
        if (part.file.truncated) throw badRequest('файл больше 20 МБ');
        file = { filename: part.filename, data };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (!file) throw badRequest('файл не передан');
    const ext = TemplateExt.safeParse(extname(file.filename).slice(1).toLowerCase());
    if (!ext.success) throw badRequest('поддерживаются файлы docx, xlsx, odt, ods, pptx');
    if (!isZip(file.data)) throw badRequest('файл повреждён или не является документом Office');
    return { fields, ext: ext.data, data: file.data };
  }

  async function insertTemplate(v: { name: string; description: string; datasourceId: string; ext: TemplateExt; data: Buffer; userId: string }) {
    await ensureDatasource(v.datasourceId);
    const id = randomUUID();
    const filePath = templateFilePath(id, v.ext);
    await storage.write(filePath, v.data);
    const [row] = await db
      .insert(templates)
      .values({
        id,
        name: v.name,
        description: v.description,
        datasourceId: v.datasourceId,
        fileExt: v.ext,
        filePath,
        docKey: randomUUID(),
        updatedBy: v.userId,
      })
      .returning();
    return row!;
  }

  app.get('/api/templates', anyUser, async () => {
    const rows = await db.select().from(templates).orderBy(asc(templates.name));
    return rows.map(toSummary);
  });

  app.get('/api/templates/:id', { ...anyUser, schema: { params: IdParams } }, async (req) => {
    const full = await loadTemplateFull(db, req.params.id);
    return currentUser(req).role === 'admin' ? toAdminDetails(full) : toDetails(full);
  });

  app.post('/api/templates', { ...admin, schema: { body: CreateTemplateBody } }, async (req, reply) => {
    const row = await insertTemplate({
      ...req.body,
      ext: req.body.blank,
      data: await createBlankDocument(req.body.blank),
      userId: currentUser(req).id,
    });
    return reply.status(201).send(toSummary(row));
  });

  app.post('/api/templates/upload', admin, async (req, reply) => {
    const { fields, ext, data } = await readUpload(req);
    const meta = z
      .object({ name: z.string().trim().min(1), description: z.string().default(''), datasourceId: z.uuid() })
      .safeParse(fields);
    if (!meta.success) throw badRequest('укажите название и источник данных');
    const row = await insertTemplate({ ...meta.data, ext, data, userId: currentUser(req).id });
    return reply.status(201).send(toSummary(row));
  });

  app.put('/api/templates/:id/file', { ...admin, schema: { params: IdParams } }, async (req) => {
    const row = await loadTemplate(db, req.params.id);
    const { ext, data } = await readUpload(req);
    if (ext !== row.fileExt) throw badRequest(`ожидается файл .${row.fileExt}`);
    await storage.write(row.filePath, data);
    const [updated] = await db
      .update(templates)
      .set({
        version: sql`${templates.version} + 1`,
        docKey: randomUUID(),
        updatedAt: new Date(),
        updatedBy: currentUser(req).id,
        lastSaveError: null,
      })
      .where(eq(templates.id, row.id))
      .returning();
    return toAdminDetails(await loadTemplateFull(db, updated!.id));
  });

  app.patch('/api/templates/:id', { ...admin, schema: { params: IdParams, body: UpdateTemplateBody } }, async (req) => {
    const row = await loadTemplate(db, req.params.id);
    if (req.body.defaultOutput && !outputFormatsFor(row.fileExt).includes(req.body.defaultOutput)) {
      throw badRequest(`формат ${req.body.defaultOutput} недоступен для .${row.fileExt}`);
    }
    if (req.body.datasourceId) await ensureDatasource(req.body.datasourceId);
    await db
      .update(templates)
      .set({ ...req.body, updatedAt: new Date(), updatedBy: currentUser(req).id })
      .where(eq(templates.id, row.id));
    return toAdminDetails(await loadTemplateFull(db, row.id));
  });

  app.delete('/api/templates/:id', { ...admin, schema: { params: IdParams } }, async (req, reply) => {
    const row = await loadTemplate(db, req.params.id);
    await db.delete(templates).where(eq(templates.id, row.id));
    await storage.remove(row.filePath);
    return reply.status(204).send();
  });

  app.post('/api/templates/:id/duplicate', { ...admin, schema: { params: IdParams } }, async (req, reply) => {
    const src = await loadTemplateFull(db, req.params.id);
    const row = await insertTemplate({
      name: `${src.row.name} (копия)`,
      description: src.row.description,
      datasourceId: src.row.datasourceId,
      ext: src.row.fileExt,
      data: await storage.read(src.row.filePath),
      userId: currentUser(req).id,
    });
    await db.update(templates).set({ defaultOutput: src.row.defaultOutput }).where(eq(templates.id, row.id));
    if (src.queries.length) {
      await db.insert(templateQueries).values(src.queries.map((q, i) => ({ ...q, templateId: row.id, sortOrder: i })));
    }
    if (src.params.length) {
      await db.insert(templateParams).values(src.params.map((p, i) => ({ ...p, templateId: row.id, sortOrder: i })));
    }
    return reply.status(201).send(toSummary(row));
  });

  app.get('/api/templates/:id/download', { ...admin, schema: { params: IdParams } }, async (req, reply) => {
    const row = await loadTemplate(db, req.params.id);
    const data = await storage.read(row.filePath);
    return reply
      .header('content-type', MIME[row.fileExt])
      .header('content-disposition', contentDisposition(`${row.name}.${row.fileExt}`))
      .send(data);
  });

  app.put(
    '/api/templates/:id/queries',
    { ...admin, schema: { params: IdParams, body: z.array(TemplateQuery) } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      uniqueOrFail(req.body.map((q) => q.key), 'ключ запроса');
      await db.transaction(async (tx) => {
        await tx.delete(templateQueries).where(eq(templateQueries.templateId, row.id));
        if (req.body.length) {
          await tx.insert(templateQueries).values(req.body.map((q, i) => ({ ...q, templateId: row.id, sortOrder: i })));
        }
        await tx.update(templates).set({ updatedAt: new Date(), updatedBy: currentUser(req).id }).where(eq(templates.id, row.id));
      });
      return toAdminDetails(await loadTemplateFull(db, row.id));
    },
  );

  app.put(
    '/api/templates/:id/params',
    { ...admin, schema: { params: IdParams, body: z.array(TemplateParam) } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      uniqueOrFail(req.body.map((p) => p.name), 'параметр');
      checkParamDefaults(req.body);
      await db.transaction(async (tx) => {
        await tx.delete(templateParams).where(eq(templateParams.templateId, row.id));
        if (req.body.length) {
          await tx.insert(templateParams).values(req.body.map((p, i) => ({ ...p, templateId: row.id, sortOrder: i })));
        }
        await tx.update(templates).set({ updatedAt: new Date(), updatedBy: currentUser(req).id }).where(eq(templates.id, row.id));
      });
      return toAdminDetails(await loadTemplateFull(db, row.id));
    },
  );
}
```

В `apps/api/src/app.ts`:
```ts
import multipart from '@fastify/multipart';
import { registerTemplateRoutes } from './modules/templates/routes';
// ... после регистрации cookie:
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
// ... после registerDatasourceRoutes:
  registerTemplateRoutes(app, deps, guards);
```

- [ ] **Step 5: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api test:int && pnpm -r typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): templates CRUD, uploads, blank documents, queries and params"
```

---
### Task 11: Клиент Carbone

**Files:**
- Create: `apps/api/src/modules/carbone/client.ts`
- Test: `apps/api/src/modules/carbone/client.test.ts`

**Interfaces:**
- Consumes: `CarboneRenderer`, `TemplateFileRef`, `RenderOptions` (`deps.ts`), `AppError`.
- Produces: `class CarboneClient implements CarboneRenderer`, конструктор `new CarboneClient({ baseUrl: string; fetch?: typeof fetch })`.

Протокол Carbone 5 (образ `carbone/carbone-ee`, Community Edition без лицензии):
- все запросы с заголовком `carbone-version: 5`;
- `POST /template` (multipart, поле `template`) → `{"success":true,"data":{"templateId":"…"}}`;
- `POST /render/:templateId?download=true` с JSON `{ data, convertTo, lang, timezone }` → сразу бинарный файл; при ошибке JSON `{"success":false,"error":"…"}`;
- если шаблон исчез из хранилища Carbone (например, контейнер пересоздан), ответ — `404` или `error` с текстом `Template not found`. Тогда клиент загружает шаблон заново и повторяет рендер один раз.

- [ ] **Step 1: Тест (на поддельном `fetch`)**

`apps/api/src/modules/carbone/client.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { CarboneClient } from './client';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
    };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pdf = () => new Response(Buffer.from('%PDF-1.7 test'), { status: 200, headers: { 'content-type': 'application/pdf' } });

const tpl = (version = 1) => ({ id: 'tpl-1', version, ext: 'docx' as const, read: async () => Buffer.from('PK\x03\x04docx') });
const opts = { convertTo: 'pdf' as const, lang: 'ru-ru', timezone: 'Europe/Moscow', timeoutMs: 1000 };

describe('CarboneClient', () => {
  it('загружает шаблон, затем рендерит с download=true и заголовком версии', async () => {
    const { fn, calls } = fakeFetch((c) =>
      c.url.endsWith('/template') ? json(200, { success: true, data: { templateId: 'abc' } }) : pdf(),
    );
    const client = new CarboneClient({ baseUrl: 'http://carbone:4000', fetch: fn });
    const out = await client.render(tpl(), { a: 1 }, opts);
    expect(out.toString()).toBe('%PDF-1.7 test');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://carbone:4000/template',
      'POST http://carbone:4000/render/abc?download=true',
    ]);
    expect(calls.every((c) => c.headers['carbone-version'] === '5')).toBe(true);
    expect(calls[0]!.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(calls[1]!.body))).toEqual({
      data: { a: 1 }, convertTo: 'pdf', lang: 'ru-ru', timezone: 'Europe/Moscow',
    });
  });

  it('кэширует templateId для той же версии и перезагружает для новой', async () => {
    let uploads = 0;
    const { fn } = fakeFetch((c) => {
      if (c.url.endsWith('/template')) return json(200, { success: true, data: { templateId: `id${++uploads}` } });
      return pdf();
    });
    const client = new CarboneClient({ baseUrl: 'http://c', fetch: fn });
    await client.render(tpl(1), {}, opts);
    await client.render(tpl(1), {}, opts);
    expect(uploads).toBe(1);
    await client.render(tpl(2), {}, opts);
    expect(uploads).toBe(2);
  });

  it('если Carbone потерял шаблон — загружает заново и повторяет один раз', async () => {
    let renders = 0;
    const { fn, calls } = fakeFetch((c) => {
      if (c.url.endsWith('/template')) return json(200, { success: true, data: { templateId: 'new' } });
      renders++;
      return renders === 2 ? json(404, { success: false, error: 'Template not found' }) : pdf();
    });
    const client = new CarboneClient({ baseUrl: 'http://c', fetch: fn });
    await client.render(tpl(), {}, opts);
    await client.render(tpl(), {}, opts);
    expect(calls.filter((c) => c.url.endsWith('/template'))).toHaveLength(2);
  });

  it('ошибка рендера → AppError CARBONE_ERROR 502 с текстом Carbone', async () => {
    const { fn } = fakeFetch((c) =>
      c.url.endsWith('/template')
        ? json(200, { success: true, data: { templateId: 'x' } })
        : json(400, { success: false, error: 'Error: formatter "foo" does not exist' }),
    );
    const client = new CarboneClient({ baseUrl: 'http://c', fetch: fn });
    const e = await client.render(tpl(), {}, opts).catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect([e.code, e.status]).toEqual(['CARBONE_ERROR', 502]);
    expect(e.message).toContain('formatter "foo" does not exist');
  });

  it('Carbone недоступен → CARBONE_ERROR 502', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const e = await new CarboneClient({ baseUrl: 'http://c', fetch: fn }).render(tpl(), {}, opts).catch((x) => x);
    expect([e.code, e.status]).toEqual(['CARBONE_ERROR', 502]);
    expect(e.message).toBe('сервис генерации недоступен');
  });

  it('таймаут → TIMEOUT 504', async () => {
    const fn = (async (_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const e = await new CarboneClient({ baseUrl: 'http://c', fetch: fn })
      .render(tpl(), {}, { ...opts, timeoutMs: 50 })
      .catch((x) => x);
    expect([e.code, e.status]).toEqual(['TIMEOUT', 504]);
  });
});
```

- [ ] **Step 2: Запустить — падает**

```bash
pnpm --filter @carbone-reports/api test -- carbone
```
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

`apps/api/src/modules/carbone/client.ts`:
```ts
import type { CarboneRenderer, RenderOptions, TemplateFileRef } from '../../deps';
import { AppError } from '../../lib/errors';

const VERSION_HEADER = { 'carbone-version': '5' };

class TemplateMissing extends Error {}

export class CarboneClient implements CarboneRenderer {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  /** `${templateId}` → { version, carboneId } */
  private readonly ids = new Map<string, { version: number; carboneId: string }>();

  constructor(opts: { baseUrl: string; fetch?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetch = opts.fetch ?? fetch;
  }

  async render(tpl: TemplateFileRef, data: unknown, opts: RenderOptions): Promise<Buffer> {
    const signal = AbortSignal.timeout(opts.timeoutMs);
    try {
      const cached = this.ids.get(tpl.id);
      let carboneId = cached?.version === tpl.version ? cached.carboneId : await this.upload(tpl, signal);
      try {
        return await this.renderWith(carboneId, data, opts, signal);
      } catch (e) {
        if (!(e instanceof TemplateMissing)) throw e;
        carboneId = await this.upload(tpl, signal);
        return await this.renderWith(carboneId, data, opts, signal);
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (e instanceof TemplateMissing) throw new AppError('CARBONE_ERROR', 502, 'ошибка генерации: шаблон не найден');
      if (signal.aborted) throw new AppError('TIMEOUT', 504, 'превышено время ожидания');
      throw new AppError('CARBONE_ERROR', 502, 'сервис генерации недоступен');
    }
  }

  private async upload(tpl: TemplateFileRef, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append('template', new Blob([await tpl.read()]), `template.${tpl.ext}`);
    const res = await this.fetch(`${this.baseUrl}/template`, {
      method: 'POST',
      headers: VERSION_HEADER,
      body: form,
      signal,
    });
    const body = (await res.json().catch(() => null)) as
      | { success?: boolean; error?: string; data?: { templateId?: string } }
      | null;
    const id = body?.data?.templateId;
    if (!res.ok || !body?.success || !id) {
      throw new AppError('CARBONE_ERROR', 502, `ошибка загрузки шаблона: ${body?.error ?? res.status}`);
    }
    this.ids.set(tpl.id, { version: tpl.version, carboneId: id });
    return id;
  }

  private async renderWith(
    carboneId: string,
    data: unknown,
    opts: RenderOptions,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const res = await this.fetch(`${this.baseUrl}/render/${encodeURIComponent(carboneId)}?download=true`, {
      method: 'POST',
      headers: { ...VERSION_HEADER, 'content-type': 'application/json' },
      body: JSON.stringify({ data, convertTo: opts.convertTo, lang: opts.lang, timezone: opts.timezone }),
      signal,
    });
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    if (res.ok && !isJson) return Buffer.from(await res.arrayBuffer());

    const body = (isJson ? await res.json().catch(() => null) : null) as { error?: string } | null;
    const error = body?.error ?? `HTTP ${res.status}`;
    if (res.status === 404 || /template not found/i.test(error)) throw new TemplateMissing(error);
    throw new AppError('CARBONE_ERROR', 502, `ошибка генерации: ${error}`);
  }
}
```

- [ ] **Step 4: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test -- carbone && pnpm -r typecheck
```
Expected: PASS (6 тестов).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): Carbone 5 HTTP client with template cache and re-upload"
```

---

### Task 12: Генерация отчётов, история запусков, предпросмотр для админа

**Files:**
- Create: `apps/api/src/modules/reports/service.ts`, `apps/api/src/modules/reports/routes.ts`
- Test: `apps/api/test/reports.int.test.ts`
- Modify: `apps/api/src/app.ts`, `packages/shared/src/index.ts` (`RunsQuery`, `RunsPage`)

**Interfaces:**
- Consumes: `loadTemplateFull`, `templateFileRef`, `TemplateFull` (Task 10); `resolveParams` (Task 7); `buildReportData` (Task 7); `runQueries`, `previewQuery` (Task 9); `deps.sources`, `deps.carbone`; `MIME`, `contentDisposition`.
- Produces:
  - `collectReportData(deps, full: TemplateFull, input: ParamsInput): Promise<{ data: Record<string, unknown>; params: Record<string, ParamValue> }>`
  - `renderReport(deps, full: TemplateFull, data: unknown, format: OutputFormat): Promise<Buffer>`
  - Маршруты: `POST /api/reports/:id/render` → `201 { runId }`; `GET /api/runs?templateId&userId&status&page` → `RunsPage`; `GET /api/runs/:id/file[?inline=1]`; `POST /api/templates/:id/queries/run` → `RunQueryResult`; `POST /api/templates/:id/preview` → JSON-данные (`mode=data`) или `application/pdf` (`mode=pdf`)
  - `shared`: `RunsQuery = { templateId?: uuid; userId?: uuid; status?: 'ok'|'error'; page: number ≥1 (default 1) }`, `RunsPage = { items: RunDto[]; total: number; page: number; pageSize: number }`

- [ ] **Step 1: Схемы в `shared`**

Добавить в `packages/shared/src/index.ts`:
```ts
export const RunsQuery = z.object({
  templateId: z.uuid().optional(),
  userId: z.uuid().optional(),
  status: z.enum(['ok', 'error']).optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type RunsQuery = z.infer<typeof RunsQuery>;

export const RUNS_PAGE_SIZE = 50;

export const RunsPage = z.object({
  items: z.array(RunDto),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type RunsPage = z.infer<typeof RunsPage>;
```

- [ ] **Step 2: Интеграционный тест**

`apps/api/test/reports.int.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors';
import type { CarboneRenderer } from '../src/deps';
import { createSourceDatabase, createTemplate, createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let userA: string;
let userB: string;
let dsId: string;
let tplId: string;
let carboneFails = false;

// Поддельный Carbone возвращает JSON того, что ему передали.
const carbone: CarboneRenderer = {
  async render(tpl, data, opts) {
    if (carboneFails) throw new AppError('CARBONE_ERROR', 502, 'ошибка генерации: boom');
    return Buffer.from(JSON.stringify({ version: tpl.version, data, convertTo: opts.convertTo, tz: opts.timezone }));
  },
};

const render = (cookie: string, id: string, payload: unknown) =>
  t.app.inject({ method: 'POST', url: `/api/reports/${id}/render`, headers: { cookie }, payload });

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = (await loginAs(t, 'admin')).cookie;
  userA = (await loginAs(t, 'user')).cookie;
  userB = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase(`
    create table orders(id int, total numeric, created date);
    insert into orders values (1, 100, '2026-01-10'), (2, 250.5, '2026-02-10');
    create table company(name text); insert into company values ('ООО Ромашка');
  `);
  const ds = await t.app.inject({
    method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: { name: 'src', ...src, ssl: false },
  });
  dsId = ds.json().id;
  tplId = await createTemplate(t, admin, dsId, {
    queries: [
      { key: 'orders', mode: 'list', sql: 'select id, total from orders where created >= :from order by id' },
      { key: 'company', mode: 'single', sql: 'select name from company' },
    ],
    params: [{ name: 'from', label: 'С даты', type: 'date', required: true, defaultValue: null, options: null }],
  });
});
afterAll(() => t.close());

describe('генерация', () => {
  it('user генерирует отчёт; данные собраны из SQL и параметров; файл скачивается', async () => {
    const r = await render(userA, tplId, { params: { from: '2026-02-01' }, format: 'pdf' });
    expect(r.statusCode).toBe(201);
    const file = await t.app.inject({ method: 'GET', url: `/api/runs/${r.json().runId}/file`, headers: { cookie: userA } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(JSON.parse(file.body)).toEqual({
      version: 1,
      data: { orders: [{ id: 2, total: 250.5 }], company: { name: 'ООО Ромашка' }, params: { from: '2026-02-01' } },
      convertTo: 'pdf',
      tz: 'Europe/Moscow',
    });
  });

  it('inline=1 отдаёт inline для предпросмотра PDF', async () => {
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    const file = await t.app.inject({ method: 'GET', url: `/api/runs/${r.json().runId}/file?inline=1`, headers: { cookie: userA } });
    expect(file.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('неверные параметры → 400 с полями и без записи в историю', async () => {
    const before = await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: admin } });
    const r = await render(userA, tplId, { params: {}, format: 'pdf' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fields).toEqual({ from: 'обязательный параметр' });
    const after = await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: admin } });
    expect(after.json().total).toBe(before.json().total);
  });

  it('формат, недоступный для шаблона → 400', async () => {
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'xlsx' });
    expect(r.statusCode).toBe(400);
  });

  it('ошибка Carbone → 502 и запись со status=error', async () => {
    carboneFails = true;
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    carboneFails = false;
    expect(r.statusCode).toBe(502);
    const runs = await t.app.inject({ method: 'GET', url: '/api/runs?status=error', headers: { cookie: userA } });
    expect(runs.json().items[0]).toMatchObject({ status: 'error', error: 'ошибка генерации: boom', fileAvailable: false });
  });

  it('ошибка SQL → 400 и запись со status=error', async () => {
    const bad = await createTemplate(t, admin, dsId, { queries: [{ key: 'x', mode: 'list', sql: 'select nope from orders' }] });
    const r = await render(userA, bad, { params: {}, format: 'pdf' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/^запрос "x": /);
  });

  it('шаблон без запросов генерируется только с params', async () => {
    const empty = await createTemplate(t, admin, dsId);
    const r = await render(userA, empty, { params: {}, format: 'pdf' });
    const file = await t.app.inject({ method: 'GET', url: `/api/runs/${r.json().runId}/file`, headers: { cookie: userA } });
    expect(JSON.parse(file.body).data).toEqual({ params: {} });
  });
});

describe('история', () => {
  it('user видит только свои запуски и не может скачать чужой файл', async () => {
    const r = await render(userB, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    const runId = r.json().runId;
    const listA = await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: userA } });
    expect(listA.json().items.some((x: { id: string }) => x.id === runId)).toBe(false);
    const steal = await t.app.inject({ method: 'GET', url: `/api/runs/${runId}/file`, headers: { cookie: userA } });
    expect(steal.statusCode).toBe(404);
    const asAdmin = await t.app.inject({ method: 'GET', url: `/api/runs/${runId}/file`, headers: { cookie: admin } });
    expect(asAdmin.statusCode).toBe(200);
  });

  it('user не может подсмотреть чужие запуски через ?userId', async () => {
    const listB = await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: userB } });
    const otherUserId = listB.json().items[0].userId;
    const listA = await t.app.inject({ method: 'GET', url: `/api/runs?userId=${otherUserId}`, headers: { cookie: userA } });
    expect(listA.json().items.every((x: { userId: string }) => x.userId !== otherUserId)).toBe(true);
  });

  it('admin фильтрует по пользователю; в записи есть логин и название шаблона', async () => {
    const listB = await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: userB } });
    const uid = listB.json().items[0].userId;
    const r = await t.app.inject({ method: 'GET', url: `/api/runs?userId=${uid}`, headers: { cookie: admin } });
    expect(r.json().items.every((x: { userId: string }) => x.userId === uid)).toBe(true);
    expect(r.json().items[0]).toMatchObject({ userLogin: expect.stringMatching(/^user_/), templateName: expect.any(String) });
  });

  it('после удаления шаблона история остаётся читаемой', async () => {
    const tmp = await createTemplate(t, admin, dsId);
    const r = await render(userA, tmp, { params: {}, format: 'pdf' });
    await t.app.inject({ method: 'DELETE', url: `/api/templates/${tmp}`, headers: { cookie: admin } });
    const runs = await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: userA } });
    const run = runs.json().items.find((x: { id: string }) => x.id === r.json().runId);
    expect(run).toMatchObject({ templateId: null, templateName: expect.stringMatching(/^Шаблон /) });
  });
});

describe('инструменты админа', () => {
  it('queries/run выполняет произвольный SQL с параметрами и обрезает до 50 строк', async () => {
    const r = await t.app.inject({
      method: 'POST', url: `/api/templates/${tplId}/queries/run`, headers: { cookie: admin },
      payload: { sql: 'select g from generate_series(1, :n) g', params: { n: 60 } },
    });
    expect(r.json()).toMatchObject({ columns: ['g'], truncated: true });
    expect(r.json().rows).toHaveLength(50);
  });

  it('queries/run и preview недоступны user', async () => {
    const r = await t.app.inject({
      method: 'POST', url: `/api/templates/${tplId}/queries/run`, headers: { cookie: userA },
      payload: { sql: 'select 1', params: {} },
    });
    expect(r.statusCode).toBe(403);
  });

  it('preview mode=data возвращает собранный JSON и не пишет историю', async () => {
    const before = (await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: admin } })).json().total;
    const r = await t.app.inject({
      method: 'POST', url: `/api/templates/${tplId}/preview`, headers: { cookie: admin },
      payload: { params: { from: '2026-01-01' }, mode: 'data' },
    });
    expect(r.json()).toMatchObject({ orders: [{ id: 1 }, { id: 2 }], company: { name: 'ООО Ромашка' } });
    const after = (await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: admin } })).json().total;
    expect(after).toBe(before);
  });

  it('preview mode=pdf отдаёт application/pdf inline', async () => {
    const r = await t.app.inject({
      method: 'POST', url: `/api/templates/${tplId}/preview`, headers: { cookie: admin },
      payload: { params: { from: '2026-01-01' }, mode: 'pdf' },
    });
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toMatch(/^inline;/);
  });
});
```

- [ ] **Step 3: Запустить — падает**

```bash
pnpm --filter @carbone-reports/api test:int -- reports
```
Expected: FAIL — 404 на `/api/reports/...`.

- [ ] **Step 4: Реализация**

`apps/api/src/modules/reports/service.ts`:
```ts
import { outputFormatsFor, type OutputFormat, type ParamValue, type ParamsInput } from '@carbone-reports/shared';
import type { AppDeps } from '../../deps';
import { badRequest } from '../../lib/errors';
import { buildReportData } from '../queries/build-data';
import { runQueries } from '../queries/executor';
import { resolveParams } from '../queries/params';
import { templateFileRef, type TemplateFull } from '../templates/service';

export async function collectReportData(
  deps: AppDeps,
  full: TemplateFull,
  input: ParamsInput,
): Promise<{ data: Record<string, unknown>; params: Record<string, ParamValue> }> {
  const params = resolveParams(full.params, input);
  if (full.queries.length === 0) return { data: buildReportData([], params), params };
  const { pool, name } = await deps.sources.get(full.row.datasourceId);
  const results = await runQueries(pool, name, full.queries, params, {
    timeoutMs: deps.config.queryTimeoutMs,
    maxRows: deps.config.queryMaxRows,
  });
  return { data: buildReportData(results, params), params };
}

export function assertFormat(full: TemplateFull, format: OutputFormat): void {
  if (!outputFormatsFor(full.row.fileExt).includes(format)) {
    throw badRequest(`формат ${format} недоступен для шаблона .${full.row.fileExt}`);
  }
}

export function renderReport(deps: AppDeps, full: TemplateFull, data: unknown, format: OutputFormat): Promise<Buffer> {
  return deps.carbone.render(templateFileRef(deps, full.row), data, {
    convertTo: format,
    lang: 'ru-ru',
    timezone: deps.config.tz,
    timeoutMs: deps.config.renderTimeoutMs,
  });
}
```

`apps/api/src/modules/reports/routes.ts`:
```ts
import { randomUUID } from 'node:crypto';
import {
  IdParams,
  PreviewBody,
  RenderBody,
  RunQueryBody,
  RUNS_PAGE_SIZE,
  RunsQuery,
  type RunDto,
  type RunsPage,
} from '@carbone-reports/shared';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { App } from '../../app';
import { reportRuns, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError, notFound } from '../../lib/errors';
import { contentDisposition, MIME } from '../../lib/http';
import { currentUser, type Guards } from '../auth/guards';
import { previewQuery } from '../queries/executor';
import { loadTemplateFull } from '../templates/service';
import { assertFormat, collectReportData, renderReport } from './service';

const PREVIEW_ROWS = 50;

export function registerReportRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const { db, storage } = deps;

  app.post(
    '/api/reports/:id/render',
    { preHandler: guards.requireUser, schema: { params: IdParams, body: RenderBody } },
    async (req, reply) => {
      const user = currentUser(req);
      const full = await loadTemplateFull(db, req.params.id);
      assertFormat(full, req.body.format);
      const runId = randomUUID();
      const started = Date.now();
      const base = {
        id: runId,
        templateId: full.row.id,
        templateName: full.row.name,
        templateVersion: full.row.version,
        userId: user.id,
        outputFormat: req.body.format,
      };
      try {
        const { data, params } = await collectReportData(deps, full, req.body.params);
        const file = await renderReport(deps, full, data, req.body.format);
        const filePath = `reports/${runId}.${req.body.format}`;
        await storage.write(filePath, file);
        await db.insert(reportRuns).values({ ...base, params, status: 'ok', filePath, durationMs: Date.now() - started });
        return reply.status(201).send({ runId });
      } catch (e) {
        // Ошибки ввода пользователя историю не засоряют.
        if (!(e instanceof AppError && e.code === 'VALIDATION')) {
          await db.insert(reportRuns).values({
            ...base,
            params: req.body.params,
            status: 'error',
            error: e instanceof AppError ? e.message : 'внутренняя ошибка сервера',
            durationMs: Date.now() - started,
          });
        }
        throw e;
      }
    },
  );

  app.get('/api/runs', { preHandler: guards.requireUser, schema: { querystring: RunsQuery } }, async (req): Promise<RunsPage> => {
    const me = currentUser(req);
    const q = req.query;
    const where: SQL[] = [];
    // Обычный пользователь всегда видит только свои запуски, фильтр userId игнорируется.
    if (me.role !== 'admin') where.push(eq(reportRuns.userId, me.id));
    else if (q.userId) where.push(eq(reportRuns.userId, q.userId));
    if (q.templateId) where.push(eq(reportRuns.templateId, q.templateId));
    if (q.status) where.push(eq(reportRuns.status, q.status));
    const cond = where.length ? and(...where) : undefined;

    const [rows, [totalRow]] = await Promise.all([
      db
        .select({ run: reportRuns, login: users.login })
        .from(reportRuns)
        .innerJoin(users, eq(users.id, reportRuns.userId))
        .where(cond)
        .orderBy(desc(reportRuns.createdAt))
        .limit(RUNS_PAGE_SIZE)
        .offset((q.page - 1) * RUNS_PAGE_SIZE),
      db.select({ n: count() }).from(reportRuns).where(cond),
    ]);

    const items: RunDto[] = rows.map(({ run, login }) => ({
      id: run.id,
      templateId: run.templateId,
      templateName: run.templateName,
      templateVersion: run.templateVersion,
      userId: run.userId,
      userLogin: login,
      params: run.params,
      outputFormat: run.outputFormat,
      status: run.status,
      error: run.error,
      fileAvailable: run.status === 'ok' && !!run.filePath && !run.fileDeleted,
      durationMs: run.durationMs,
      createdAt: run.createdAt.toISOString(),
    }));
    return { items, total: totalRow?.n ?? 0, page: q.page, pageSize: RUNS_PAGE_SIZE };
  });

  app.get(
    '/api/runs/:id/file',
    {
      preHandler: guards.requireUser,
      schema: { params: IdParams, querystring: z.object({ inline: z.enum(['0', '1']).optional() }) },
    },
    async (req, reply) => {
      const me = currentUser(req);
      const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, req.params.id));
      // Чужой запуск для пользователя неотличим от несуществующего.
      if (!run || (me.role !== 'admin' && run.userId !== me.id)) throw notFound('запуск');
      if (run.status !== 'ok' || !run.filePath) throw notFound('файл');
      if (run.fileDeleted) throw new AppError('GONE', 410, 'файл удалён по сроку хранения');
      const date = run.createdAt.toISOString().slice(0, 10);
      return reply
        .header('content-type', MIME[run.outputFormat])
        .header(
          'content-disposition',
          contentDisposition(`${run.templateName} ${date}.${run.outputFormat}`, req.query.inline === '1'),
        )
        .send(await storage.read(run.filePath));
    },
  );

  app.post(
    '/api/templates/:id/queries/run',
    { preHandler: guards.requireAdmin, schema: { params: IdParams, body: RunQueryBody } },
    async (req) => {
      const full = await loadTemplateFull(db, req.params.id);
      const { pool, name } = await deps.sources.get(full.row.datasourceId);
      return previewQuery(pool, name, req.body.sql, req.body.params, {
        timeoutMs: deps.config.queryTimeoutMs,
        maxRows: deps.config.queryMaxRows,
        previewRows: PREVIEW_ROWS,
      });
    },
  );

  app.post(
    '/api/templates/:id/preview',
    { preHandler: guards.requireAdmin, schema: { params: IdParams, body: PreviewBody } },
    async (req, reply) => {
      const full = await loadTemplateFull(db, req.params.id);
      const { data } = await collectReportData(deps, full, req.body.params);
      if (req.body.mode === 'data') return data;
      const pdf = await renderReport(deps, full, data, 'pdf');
      return reply
        .header('content-type', MIME.pdf)
        .header('content-disposition', contentDisposition(`${full.row.name}.pdf`, true))
        .send(pdf);
    },
  );
}
```

В `apps/api/src/app.ts`:
```ts
import { registerReportRoutes } from './modules/reports/routes';
// ...
  registerReportRoutes(app, deps, guards);
```

- [ ] **Step 5: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test:int && pnpm -r typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): report rendering, run history, admin query/preview tools"
```

---

### Task 13: Интеграция с OnlyOffice — конфиг редактора, выдача файла, callback, forcesave

**Files:**
- Create: `apps/api/src/modules/onlyoffice/jwt.ts`, `apps/api/src/modules/onlyoffice/editor-config.ts`, `apps/api/src/modules/onlyoffice/callback.ts`, `apps/api/src/modules/onlyoffice/commands.ts`, `apps/api/src/modules/onlyoffice/routes.ts`
- Test: `apps/api/src/modules/onlyoffice/commands.test.ts`, `apps/api/test/onlyoffice.int.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `OnlyOfficeCommands`, `FileFetcher` (`deps.ts`), `loadTemplate` (Task 10), `isZip`, `MIME`, `SessionUser`.
- Produces:
  - `signOnlyOffice(payload: Record<string, unknown>, secret: Uint8Array): Promise<string>`, `verifyOnlyOffice(token: string, secret: Uint8Array): Promise<Record<string, unknown>>`
  - `buildEditorConfig(deps, row: TemplateRow, user: SessionUser): Promise<EditorConfig>`; `type EditorConfig = { document: {...}; documentType: 'word'|'cell'|'slide'; editorConfig: {...}; token: string }`
  - `signFileToken(templateId, secret): Promise<string>`, `verifyFileToken(token, templateId, secret): Promise<boolean>` (подпись `appSecret`, срок 10 минут)
  - `handleCallback(deps, templateId: string, body: unknown, authorization: string | undefined): Promise<void>`
  - `createOnlyOfficeCommands(opts: { baseUrl: string; secret: Uint8Array; fetch?: typeof fetch }): OnlyOfficeCommands`
  - Маршруты: `GET /api/templates/:id/editor-config`, `POST /api/templates/:id/save` (204), `GET /internal/templates/:id/file?t=`, `POST /internal/onlyoffice/callback/:id` → `{"error":0}`

Протокол OnlyOffice (Document Server 9.x):
- Callback: `status` 1 — редактируется, 2 — готов к сохранению (все закрыли), 3 — ошибка сохранения, 4 — закрыт без изменений, 6 — forcesave, 7 — ошибка forcesave. Для 2/3/6/7 есть `url`. JWT приходит в поле `token` тела (claims = тело) и/или в `Authorization: Bearer` (claims обёрнуты в `{ payload: {...} }`). Ответ — `{"error":0}`.
- Command Service: `POST {DS}/command`, тело `{"c":"forcesave","key":"…","token":"<jwt тела>"}`. Ответ `{"error":0}`; `error:4` — нет изменений (не ошибка).

- [ ] **Step 1: Юнит-тест команд**

`apps/api/src/modules/onlyoffice/commands.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { createOnlyOfficeCommands } from './commands';
import { verifyOnlyOffice } from './jwt';

const secret = new TextEncoder().encode('o'.repeat(32));

function fake(response: unknown) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('createOnlyOfficeCommands.forceSave', () => {
  it('шлёт подписанную команду на /command', async () => {
    const { fn, calls } = fake({ error: 0 });
    await createOnlyOfficeCommands({ baseUrl: 'http://oo', secret, fetch: fn }).forceSave('k1');
    expect(calls[0]!.url).toBe('http://oo/command');
    expect(calls[0]!.body).toMatchObject({ c: 'forcesave', key: 'k1' });
    expect(await verifyOnlyOffice(calls[0]!.body.token as string, secret)).toMatchObject({ c: 'forcesave', key: 'k1' });
    const header = await verifyOnlyOffice(calls[0]!.auth!.replace('Bearer ', ''), secret);
    expect(header.payload).toMatchObject({ c: 'forcesave', key: 'k1' });
  });
  it('error 4 (нет изменений) — не ошибка', async () => {
    const { fn } = fake({ error: 4 });
    await expect(createOnlyOfficeCommands({ baseUrl: 'http://oo', secret, fetch: fn }).forceSave('k')).resolves.toBeUndefined();
  });
  it('error 1 (документ не открыт) → понятная ошибка 409', async () => {
    const { fn } = fake({ error: 1 });
    const e = await createOnlyOfficeCommands({ baseUrl: 'http://oo', secret, fetch: fn }).forceSave('k').catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect([e.code, e.status]).toEqual(['NOT_OPEN', 409]);
  });
  it('другая ошибка → 502', async () => {
    const { fn } = fake({ error: 6 });
    const e = await createOnlyOfficeCommands({ baseUrl: 'http://oo', secret, fetch: fn }).forceSave('k').catch((x) => x);
    expect([e.code, e.status]).toEqual(['ONLYOFFICE_ERROR', 502]);
  });
});
```

- [ ] **Step 2: Интеграционный тест**

`apps/api/test/onlyoffice.int.test.ts`:
```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { templates } from '../src/db/schema';
import { signOnlyOffice, verifyOnlyOffice } from '../src/modules/onlyoffice/jwt';
import { createBlankDocument } from '../src/modules/templates/blank';
import { createSourceDatabase, createTemplate, createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let adminId: string;
let user: string;
let dsId: string;
let tplId: string;
let fetched: Buffer;
const forceSaved: string[] = [];

beforeAll(async () => {
  t = await createTestApp({
    fetchFile: async () => fetched,
    onlyoffice: { forceSave: async (key) => void forceSaved.push(key) },
  });
  const a = await loginAs(t, 'admin');
  admin = a.cookie;
  adminId = a.user.id;
  user = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase('select 1');
  dsId = (await t.app.inject({
    method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: { name: 's', ...src, ssl: false },
  })).json().id;
});
beforeEach(async () => {
  tplId = await createTemplate(t, admin, dsId);
  fetched = await createBlankDocument('docx');
});
afterAll(() => t.close());

const secret = () => t.deps.config.onlyofficeJwtSecret;
const row = async () => (await t.deps.db.select().from(templates).where(eq(templates.id, tplId)))[0]!;

async function callback(body: Record<string, unknown>, via: 'body' | 'header' = 'body') {
  const headers: Record<string, string> = {};
  let payload: Record<string, unknown> = body;
  if (via === 'body') payload = { ...body, token: await signOnlyOffice(body, secret()) };
  else headers.authorization = `Bearer ${await signOnlyOffice({ payload: body }, secret())}`;
  return t.app.inject({ method: 'POST', url: `/internal/onlyoffice/callback/${tplId}`, headers, payload });
}

describe('editor-config', () => {
  it('подписанный конфиг с внутренними URL; user → 403', async () => {
    const r = await t.app.inject({ method: 'GET', url: `/api/templates/${tplId}/editor-config`, headers: { cookie: admin } });
    const cfg = r.json();
    expect(cfg).toMatchObject({
      documentType: 'word',
      document: { fileType: 'docx', key: (await row()).docKey },
      editorConfig: {
        callbackUrl: `http://api:3000/internal/onlyoffice/callback/${tplId}`,
        lang: 'ru',
        customization: { forcesave: true },
        user: { id: adminId },
      },
    });
    expect(cfg.document.url).toMatch(new RegExp(`^http://api:3000/internal/templates/${tplId}/file\\?t=`));
    const claims = await verifyOnlyOffice(cfg.token, secret());
    expect(claims).toMatchObject({ document: { key: cfg.document.key } });

    const forbidden = await t.app.inject({ method: 'GET', url: `/api/templates/${tplId}/editor-config`, headers: { cookie: user } });
    expect(forbidden.statusCode).toBe(403);
  });

  it('файл отдаётся по токену из конфига и не отдаётся без него или с токеном другого шаблона', async () => {
    const cfg = (await t.app.inject({ method: 'GET', url: `/api/templates/${tplId}/editor-config`, headers: { cookie: admin } })).json();
    const path = new URL(cfg.document.url).pathname + new URL(cfg.document.url).search;
    const ok = await t.app.inject({ method: 'GET', url: path });
    expect(ok.statusCode).toBe(200);
    const noToken = await t.app.inject({ method: 'GET', url: `/internal/templates/${tplId}/file` });
    expect(noToken.statusCode).toBe(403);
    const other = await createTemplate(t, admin, dsId);
    const wrong = await t.app.inject({ method: 'GET', url: path.replace(tplId, other) });
    expect(wrong.statusCode).toBe(403);
  });
});

describe('callback', () => {
  it('без подписи → 403, файл не меняется', async () => {
    const r = await t.app.inject({
      method: 'POST', url: `/internal/onlyoffice/callback/${tplId}`, payload: { key: (await row()).docKey, status: 2, url: 'http://x' },
    });
    expect(r.statusCode).toBe(403);
    expect((await row()).version).toBe(1);
  });

  it('status 1 и 4 — только подтверждение', async () => {
    const key = (await row()).docKey;
    expect((await callback({ key, status: 1 })).json()).toEqual({ error: 0 });
    expect((await callback({ key, status: 4 })).json()).toEqual({ error: 0 });
    expect((await row()).version).toBe(1);
  });

  it('status 6 (forcesave, JWT в теле) — сохраняет файл, version++, ключ не меняется', async () => {
    const before = await row();
    fetched = Buffer.concat([await createBlankDocument('docx'), Buffer.from('changed')]);
    const r = await callback({ key: before.docKey, status: 6, url: 'http://oo/cache/file.docx', users: [adminId] });
    expect(r.json()).toEqual({ error: 0 });
    const after = await row();
    expect(after.version).toBe(2);
    expect(after.docKey).toBe(before.docKey);
    expect(after.updatedBy).toBe(adminId);
    expect((await t.deps.storage.read(after.filePath)).equals(fetched)).toBe(true);
  });

  it('status 2 (JWT в заголовке) — сохраняет и выдаёт новый ключ', async () => {
    const before = await row();
    const r = await callback({ key: before.docKey, status: 2, url: 'http://oo/f.docx', users: [adminId] }, 'header');
    expect(r.json()).toEqual({ error: 0 });
    const after = await row();
    expect(after.version).toBe(2);
    expect(after.docKey).not.toBe(before.docKey);
  });

  it('устаревший ключ (после закрытия сессии) игнорируется и не затирает новую версию', async () => {
    const old = (await row()).docKey;
    await callback({ key: old, status: 2, url: 'http://oo/f.docx' });
    const v = (await row()).version;
    const r = await callback({ key: old, status: 6, url: 'http://oo/stale.docx' });
    expect(r.json()).toEqual({ error: 0 });
    expect((await row()).version).toBe(v);
  });

  it('по url пришёл не документ — файл не перезаписывается, lastSaveError заполнен', async () => {
    const before = await row();
    const original = await t.deps.storage.read(before.filePath);
    fetched = Buffer.from('<html>error</html>');
    await callback({ key: before.docKey, status: 6, url: 'http://oo/f' });
    const after = await row();
    expect(after.version).toBe(1);
    expect(after.lastSaveError).toMatch(/не является документом/);
    expect((await t.deps.storage.read(after.filePath)).equals(original)).toBe(true);
  });

  it('status 3 — lastSaveError виден админу в деталях шаблона, следующее сохранение его сбрасывает', async () => {
    const key = (await row()).docKey;
    await callback({ key, status: 3, url: 'http://oo/f' });
    const d = await t.app.inject({ method: 'GET', url: `/api/templates/${tplId}`, headers: { cookie: admin } });
    expect(d.json().lastSaveError).toBe('OnlyOffice не смог сохранить документ');
    await callback({ key, status: 6, url: 'http://oo/f.docx' });
    expect((await row()).lastSaveError).toBeNull();
  });
});

describe('save', () => {
  it('POST /save отправляет forcesave с текущим ключом', async () => {
    const r = await t.app.inject({ method: 'POST', url: `/api/templates/${tplId}/save`, headers: { cookie: admin } });
    expect(r.statusCode).toBe(204);
    expect(forceSaved.at(-1)).toBe((await row()).docKey);
  });
});
```

- [ ] **Step 3: Запустить — падают**

```bash
pnpm --filter @carbone-reports/api test -- commands; pnpm --filter @carbone-reports/api test:int -- onlyoffice
```
Expected: FAIL — модули не найдены.

- [ ] **Step 4: Реализация**

`apps/api/src/modules/onlyoffice/jwt.ts`:
```ts
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

export function signOnlyOffice(payload: Record<string, unknown>, secret: Uint8Array): Promise<string> {
  return new SignJWT(payload as JWTPayload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(secret);
}

export async function verifyOnlyOffice(token: string, secret: Uint8Array): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  return payload as Record<string, unknown>;
}

export function signFileToken(templateId: string, secret: Uint8Array): Promise<string> {
  return new SignJWT({ purpose: 'oo-file' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(templateId)
    .setExpirationTime('10m')
    .sign(secret);
}

export async function verifyFileToken(token: string, templateId: string, secret: Uint8Array): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], subject: templateId });
    return payload.purpose === 'oo-file';
  } catch {
    return false;
  }
}
```

`apps/api/src/modules/onlyoffice/editor-config.ts`:
```ts
import type { TemplateExt } from '@carbone-reports/shared';
import type { TemplateRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import type { SessionUser } from '../auth/session';
import { signFileToken, signOnlyOffice } from './jwt';

const DOCUMENT_TYPE: Record<TemplateExt, 'word' | 'cell' | 'slide'> = {
  docx: 'word',
  odt: 'word',
  xlsx: 'cell',
  ods: 'cell',
  pptx: 'slide',
};

export async function buildEditorConfig(deps: AppDeps, row: TemplateRow, user: SessionUser) {
  const base = deps.config.apiInternalUrl;
  const t = await signFileToken(row.id, deps.config.appSecret);
  const config = {
    document: {
      fileType: row.fileExt,
      key: row.docKey,
      title: `${row.name}.${row.fileExt}`,
      url: `${base}/internal/templates/${row.id}/file?t=${encodeURIComponent(t)}`,
      permissions: { edit: true, download: true, print: true },
    },
    documentType: DOCUMENT_TYPE[row.fileExt],
    editorConfig: {
      callbackUrl: `${base}/internal/onlyoffice/callback/${row.id}`,
      user: { id: user.id, name: user.login },
      lang: 'ru',
      region: 'ru-RU',
      customization: { forcesave: true, autosave: true },
    },
  };
  return { ...config, token: await signOnlyOffice(config, deps.config.onlyofficeJwtSecret) };
}

export type EditorConfig = Awaited<ReturnType<typeof buildEditorConfig>>;
```

`apps/api/src/modules/onlyoffice/callback.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { templates, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { isZip } from '../../lib/http';
import { loadTemplate } from '../templates/service';
import { verifyOnlyOffice } from './jwt';

const Callback = z.object({
  key: z.string(),
  status: z.number().int(),
  url: z.string().optional(),
  users: z.array(z.string()).optional(),
});

const SAVE_ERRORS: Record<number, string> = {
  3: 'OnlyOffice не смог сохранить документ',
  7: 'ошибка принудительного сохранения OnlyOffice',
};

async function verifiedPayload(deps: AppDeps, body: unknown, authorization?: string): Promise<unknown> {
  const secret = deps.config.onlyofficeJwtSecret;
  const bodyToken = (body as { token?: unknown } | null)?.token;
  try {
    if (typeof bodyToken === 'string') return await verifyOnlyOffice(bodyToken, secret);
    if (authorization?.startsWith('Bearer ')) {
      const claims = await verifyOnlyOffice(authorization.slice(7), secret);
      return claims.payload ?? claims;
    }
  } catch {
    // неверная подпись — ниже
  }
  throw new AppError('FORBIDDEN', 403, 'неверная подпись OnlyOffice');
}

async function existingUserId(deps: AppDeps, id: string | undefined): Promise<string | null> {
  if (!id || !z.uuid().safeParse(id).success) return null;
  const [u] = await deps.db.select({ id: users.id }).from(users).where(eq(users.id, id));
  return u?.id ?? null;
}

export async function handleCallback(
  deps: AppDeps,
  templateId: string,
  body: unknown,
  authorization: string | undefined,
): Promise<void> {
  const cb = Callback.parse(await verifiedPayload(deps, body, authorization));
  const row = await loadTemplate(deps.db, templateId);
  // Колбэк от закрытой сессии (ключ уже сменился) не должен затирать новую версию.
  if (cb.key !== row.docKey) return;

  if (cb.status === 3 || cb.status === 7) {
    await deps.db.update(templates).set({ lastSaveError: SAVE_ERRORS[cb.status]! }).where(eq(templates.id, row.id));
    return;
  }
  if (cb.status !== 2 && cb.status !== 6) return;

  if (!cb.url) {
    await deps.db.update(templates).set({ lastSaveError: 'OnlyOffice не передал ссылку на файл' }).where(eq(templates.id, row.id));
    return;
  }
  const file = await deps.fetchFile(cb.url);
  if (!isZip(file)) {
    await deps.db
      .update(templates)
      .set({ lastSaveError: 'полученный от OnlyOffice файл не является документом' })
      .where(eq(templates.id, row.id));
    return;
  }
  await deps.storage.write(row.filePath, file);
  await deps.db
    .update(templates)
    .set({
      version: sql`${templates.version} + 1`,
      updatedAt: new Date(),
      updatedBy: await existingUserId(deps, cb.users?.[0]),
      lastSaveError: null,
      ...(cb.status === 2 ? { docKey: randomUUID() } : {}),
    })
    .where(eq(templates.id, row.id));
}
```

`apps/api/src/modules/onlyoffice/commands.ts`:
```ts
import type { OnlyOfficeCommands } from '../../deps';
import { AppError } from '../../lib/errors';
import { signOnlyOffice } from './jwt';

export function createOnlyOfficeCommands(opts: {
  baseUrl: string;
  secret: Uint8Array;
  fetch?: typeof fetch;
}): OnlyOfficeCommands {
  const doFetch = opts.fetch ?? fetch;
  return {
    async forceSave(key) {
      const body = { c: 'forcesave', key };
      let res: Response;
      try {
        res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/command`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await signOnlyOffice({ payload: body }, opts.secret)}`,
          },
          body: JSON.stringify({ ...body, token: await signOnlyOffice(body, opts.secret) }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new AppError('ONLYOFFICE_ERROR', 502, 'сервер документов недоступен');
      }
      const { error } = (await res.json().catch(() => ({ error: -1 }))) as { error: number };
      if (error === 0 || error === 4) return; // 4 — изменений нет
      if (error === 1) throw new AppError('NOT_OPEN', 409, 'документ не открыт в редакторе');
      throw new AppError('ONLYOFFICE_ERROR', 502, `сервер документов вернул ошибку ${error}`);
    },
  };
}
```

`apps/api/src/modules/onlyoffice/routes.ts`:
```ts
import { IdParams } from '@carbone-reports/shared';
import { z } from 'zod';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { MIME } from '../../lib/http';
import { currentUser, type Guards } from '../auth/guards';
import { loadTemplate } from '../templates/service';
import { handleCallback } from './callback';
import { buildEditorConfig } from './editor-config';
import { verifyFileToken } from './jwt';

export function registerOnlyOfficeRoutes(app: App, deps: AppDeps, guards: Guards): void {
  app.get(
    '/api/templates/:id/editor-config',
    { preHandler: guards.requireAdmin, schema: { params: IdParams } },
    async (req) => buildEditorConfig(deps, await loadTemplate(deps.db, req.params.id), currentUser(req)),
  );

  app.post(
    '/api/templates/:id/save',
    { preHandler: guards.requireAdmin, schema: { params: IdParams } },
    async (req, reply) => {
      const row = await loadTemplate(deps.db, req.params.id);
      await deps.onlyoffice.forceSave(row.docKey);
      return reply.status(204).send();
    },
  );

  // Маршруты /internal/* не проксируются nginx наружу: их вызывает только Document Server.
  app.get(
    '/internal/templates/:id/file',
    { schema: { params: IdParams, querystring: z.object({ t: z.string().optional() }) } },
    async (req, reply) => {
      const ok = req.query.t && (await verifyFileToken(req.query.t, req.params.id, deps.config.appSecret));
      if (!ok) throw new AppError('FORBIDDEN', 403, 'неверный токен файла');
      const row = await loadTemplate(deps.db, req.params.id);
      return reply.header('content-type', MIME[row.fileExt]).send(await deps.storage.read(row.filePath));
    },
  );

  app.post('/internal/onlyoffice/callback/:id', { schema: { params: IdParams } }, async (req) => {
    await handleCallback(deps, req.params.id, req.body, req.headers.authorization);
    return { error: 0 };
  });
}
```

В `apps/api/src/app.ts`:
```ts
import { registerOnlyOfficeRoutes } from './modules/onlyoffice/routes';
// ...
  registerOnlyOfficeRoutes(app, deps, guards);
```

- [ ] **Step 5: Тесты проходят**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api test:int && pnpm -r typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(api): OnlyOffice editor config, signed file access, save callback, forcesave"
```

---

### Task 14: Очистка старых отчётов, точка входа сервера, сборка и smoke-проверка

**Files:**
- Create: `apps/api/src/modules/reports/cleanup.ts`, `apps/api/src/lib/fetch-file.ts`, `apps/api/src/server.ts`, `.env.example`, `README.md`
- Test: `apps/api/test/cleanup.int.test.ts`

**Interfaces:**
- Consumes: всё вышеперечисленное.
- Produces:
  - `cleanupOldReports(deps: AppDeps, now?: Date): Promise<number>` (сколько файлов удалено)
  - `startCleanupTimer(deps: AppDeps, log: { error(o: unknown, msg?: string): void }): () => void`
  - `fetchFile: FileFetcher` (реальная реализация)
  - `server.ts` — запуск: конфиг → миграции → первый админ → HTTP на `0.0.0.0:PORT` → корректное завершение по SIGTERM/SIGINT

- [ ] **Step 1: Тест очистки**

`apps/api/test/cleanup.int.test.ts`:
```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportRuns } from '../src/db/schema';
import { cleanupOldReports } from '../src/modules/reports/cleanup';
import { createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let userId: string;
beforeAll(async () => {
  t = await createTestApp();
  userId = (await loginAs(t, 'user')).user.id;
});
afterAll(() => t.close());

async function run(daysAgo: number) {
  const id = crypto.randomUUID();
  const filePath = `reports/${id}.pdf`;
  await t.deps.storage.write(filePath, Buffer.from('pdf'));
  await t.deps.db.insert(reportRuns).values({
    id, templateId: null, templateName: 'x', templateVersion: 1, userId, params: {}, outputFormat: 'pdf',
    status: 'ok', filePath, durationMs: 1, createdAt: new Date(Date.now() - daysAgo * 86_400_000),
  });
  return { id, filePath };
}

describe('cleanupOldReports', () => {
  it('удаляет файлы старше срока хранения, запись помечает file_deleted', async () => {
    const old = await run(31);
    const fresh = await run(1);
    expect(await cleanupOldReports(t.deps)).toBe(1);
    expect(await t.deps.storage.exists(old.filePath)).toBe(false);
    expect(await t.deps.storage.exists(fresh.filePath)).toBe(true);
    const [row] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, old.id));
    expect(row!.fileDeleted).toBe(true);
  });
  it('повторный запуск ничего не делает', async () => {
    expect(await cleanupOldReports(t.deps)).toBe(0);
  });
  it('скачивание удалённого файла → 410', async () => {
    const old = await run(40);
    await cleanupOldReports(t.deps);
    const cookie = (await loginAs(t, 'admin')).cookie;
    const r = await t.app.inject({ method: 'GET', url: `/api/runs/${old.id}/file`, headers: { cookie } });
    expect(r.statusCode).toBe(410);
  });
});
```

- [ ] **Step 2: Запустить — падает**

```bash
pnpm --filter @carbone-reports/api test:int -- cleanup
```
Expected: FAIL — модуль `cleanup` не найден.

- [ ] **Step 3: Реализация очистки и `fetchFile`**

`apps/api/src/modules/reports/cleanup.ts`:
```ts
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { reportRuns } from '../../db/schema';
import type { AppDeps } from '../../deps';

export async function cleanupOldReports(deps: AppDeps, now = new Date()): Promise<number> {
  const threshold = new Date(now.getTime() - deps.config.reportRetentionDays * 86_400_000);
  const rows = await deps.db
    .select({ id: reportRuns.id, filePath: reportRuns.filePath })
    .from(reportRuns)
    .where(and(eq(reportRuns.fileDeleted, false), isNotNull(reportRuns.filePath), lt(reportRuns.createdAt, threshold)));
  for (const r of rows) {
    await deps.storage.remove(r.filePath!);
    await deps.db.update(reportRuns).set({ fileDeleted: true }).where(eq(reportRuns.id, r.id));
  }
  return rows.length;
}

export function startCleanupTimer(
  deps: AppDeps,
  log: { error(o: unknown, msg?: string): void },
): () => void {
  const tick = () => cleanupOldReports(deps).catch((e) => log.error(e, 'очистка отчётов не удалась'));
  void tick();
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
```

`apps/api/src/lib/fetch-file.ts`:
```ts
import type { FileFetcher } from '../deps';

export const fetchFile: FileFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`не удалось скачать файл: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
```

- [ ] **Step 4: Тест очистки проходит**

```bash
pnpm --filter @carbone-reports/api test:int -- cleanup
```
Expected: PASS (3 теста).

- [ ] **Step 5: Точка входа**

`apps/api/src/server.ts`:
```ts
import { buildApp } from './app';
import { loadConfig } from './config';
import { createDb, migrateDb } from './db/client';
import type { AppDeps } from './deps';
import { fetchFile } from './lib/fetch-file';
import { Storage } from './lib/storage';
import { ensureAdmin } from './modules/auth/bootstrap';
import { CarboneClient } from './modules/carbone/client';
import { createSourcePools } from './modules/datasources/pools';
import { createOnlyOfficeCommands } from './modules/onlyoffice/commands';
import { startCleanupTimer } from './modules/reports/cleanup';

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl);
await migrateDb(db);

const deps: AppDeps = {
  config,
  db,
  storage: new Storage(config.storageDir),
  sources: createSourcePools({ db, config }),
  carbone: new CarboneClient({ baseUrl: config.carboneUrl }),
  onlyoffice: createOnlyOfficeCommands({ baseUrl: config.onlyofficeInternalUrl, secret: config.onlyofficeJwtSecret }),
  fetchFile,
};

await ensureAdmin(deps);
const app = await buildApp(deps);
const stopCleanup = startCleanupTimer(deps, app.log);

async function shutdown(signal: string) {
  app.log.info(`${signal}: остановка`);
  stopCleanup();
  await app.close();
  await deps.sources.closeAll();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
```

`.env.example`:
```dotenv
# БД приложения
DATABASE_URL=postgres://app:app@localhost:5432/app
# openssl rand -hex 32
APP_SECRET=
# openssl rand -base64 32
ENCRYPTION_KEY=
# openssl rand -hex 32 — тот же секрет задаётся JWT_SECRET у OnlyOffice
ONLYOFFICE_JWT_SECRET=
ONLYOFFICE_INTERNAL_URL=http://onlyoffice
API_INTERNAL_URL=http://api:3000
CARBONE_URL=http://carbone:4000
ADMIN_LOGIN=admin
ADMIN_PASSWORD=
STORAGE_DIR=./.data
QUERY_TIMEOUT_MS=30000
QUERY_MAX_ROWS=100000
RENDER_TIMEOUT_MS=120000
REPORT_RETENTION_DAYS=30
TZ=Europe/Moscow
PORT=3000
COOKIE_SECURE=false
```

`README.md`:
````markdown
# Carbone Reports

Генерация отчётов на базе Carbone с редактированием шаблонов в браузере (OnlyOffice) и интерфейсом на GravityUI.

Спецификация: `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`.

## Разработка API

Требования: Node 22 (`nvm use`), pnpm 10 (`corepack enable`), запущенный Docker (для интеграционных тестов).

```bash
pnpm install
pnpm test          # юнит-тесты
pnpm test:int      # интеграционные (PostgreSQL в testcontainers)
pnpm typecheck && pnpm lint
```

Локальный запуск API:

```bash
docker run -d --name cr-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app -p 5432:5432 postgres:17-alpine
cp .env.example .env   # заполнить секреты
cd apps/api && node --env-file=../../.env --import tsx src/server.ts
```

## Безопасность источников данных

Подключайте источники под отдельным пользователем PostgreSQL с правами только на чтение
(`GRANT SELECT`). Приложение дополнительно выполняет запросы в `READ ONLY`-транзакции с
`statement_timeout`, но права на уровне БД — основная защита.
````

- [ ] **Step 6: Smoke-проверка собранного сервера**

```bash
pnpm --filter @carbone-reports/api build
docker run -d --rm --name cr-smoke-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app -p 55432:5432 postgres:17-alpine
until docker exec cr-smoke-pg pg_isready -U app >/dev/null 2>&1; do sleep 1; done
cd apps/api && \
  DATABASE_URL=postgres://app:app@localhost:55432/app \
  APP_SECRET=$(openssl rand -hex 32) ENCRYPTION_KEY=$(openssl rand -base64 32) \
  ONLYOFFICE_JWT_SECRET=$(openssl rand -hex 32) ADMIN_LOGIN=admin ADMIN_PASSWORD=admin12345 \
  STORAGE_DIR=$(mktemp -d) PORT=3999 node dist/server.js &
SERVER_PID=$!
until curl -sf localhost:3999/api/health >/dev/null; do sleep 0.5; done
curl -s localhost:3999/api/health
curl -s -c /tmp/cr.cookies -H 'content-type: application/json' -d '{"login":"admin","password":"admin12345"}' localhost:3999/api/auth/login
curl -s -b /tmp/cr.cookies localhost:3999/api/auth/me
kill $SERVER_PID; cd ../..; docker stop cr-smoke-pg
```
Expected: `{"status":"ok"}`, затем дважды `{"id":"…","login":"admin","role":"admin"}`. Сервер завершается по `kill` без ошибок.

- [ ] **Step 7: Полный прогон и commit**

```bash
pnpm test && pnpm test:int && pnpm typecheck && pnpm lint
git add -A
git commit -m "feat(api): report file retention, server entrypoint, env example, README"
```
