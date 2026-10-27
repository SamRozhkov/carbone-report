# ИИ-ассистент, этап 1 — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** встроенный в веб-интерфейс ассистент, который по описанию словами находит отчёт, подбирает параметры и предлагает карточку запуска; модель подключается администратором по OpenAI-совместимому API.

**Architecture:** новый модуль API `apps/api/src/modules/assistant/` ведёт цикл с моделью (`fetch` к `/chat/completions`, tool calling) и выполняет инструменты через `app.inject` с cookie пользователя — все проверки доступа существующих эндпоинтов работают как есть. Настройки — одна строка в таблице `assistant_settings`, ключ зашифрован `encryptSecret`. Веб: немодальная панель справа, пункт «Ассистент» в подвале `AsideHeader`, диалог в `sessionStorage`, страница администрирования «Ассистент».

**Tech Stack:** Fastify 5 + zod + drizzle (API), React 19 + Gravity UI + TanStack Query (веб), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §50.

## Global Constraints

- Ветка `feat/ai-assistant`; в main не сливается, тегов и выпусков нет. Номер версии в `package.json`/чарте не меняется.
- Новых npm-зависимостей нет: клиент модели — встроенный `fetch`.
- Граница данных (§50.1): в модель уходят только названия, описания, категории шаблонов, параметры (имя, подпись, тип, обязательность, умолчание, `multiple`) и варианты значений списков. Никогда — SQL, запросы шаблона, результаты запросов, файлы.
- Ключ API: хранится только как `api_key_enc` (`encryptSecret(…, deps.config.encryptionKey)`); не возвращается ни одним эндпоинтом, не попадает в логи и тексты ошибок.
- Лимиты: 8 вызовов инструментов и 120 с на ответ; таймаут одного запроса к модели 60 с; история 1–20 сообщений по ≤4000 символов; доп. инструкции ≤2000 символов; `list_reports` ≤50, `find_param_values` ≤30 записей; 20 запросов чата в минуту на пользователя.
- Ответы ассистента в вебе — простой текст (`white-space: pre-wrap`), без Markdown/HTML.
- Все тексты интерфейса и ошибок — во всех семи каталогах `packages/shared/src/i18n/{ru,en,es,pt-BR,fr,de,zh-CN}`; `pnpm i18n:check` проходит. Кириллица в коде веба запрещена (проверка i18n:check), в аргументах `AppError` — тоже.
- Комментарии в коде — по-русски, в стиле окружающего кода.
- Коммиты заканчиваются абзацем:
  `Co-Authored-By: <модель> <noreply@anthropic.com>` и `Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB`.
- Node: `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH`. Интеграционные тесты API запускаются только по одному файлу (`pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/<file>`); никогда не запускать `render-onlyoffice.int.test.ts`; два набора тестов одновременно не запускать.
- Ошибки lint в `cades/cadesplugin_api.js` (≈92) — локальный шум, не исправлять.

## Review Focus

1. Автор/администратор вызывает `get_report_form`: `GET /api/templates/:id` отдаёт ему карточку конструктора с `queries`, `sql` параметров, `pdfOptions` — в результат инструмента ничего из этого не попадает (тест в Task 3).
2. Пользователь без доступа к шаблону передаёт модели (или модель выдумывает) его id: `get_report_form`, `find_param_values`, `propose_run` возвращают ошибку, карточка не создаётся (интеграционный тест в Task 4).
3. Модель вернула невалидный JSON в `arguments` или вызвала несуществующий инструмент — ошибка уходит модели результатом инструмента, ответ не падает 500 (тест в Task 4).
4. Провайдер вернул ошибку, в теле которой есть ключ (некоторые прокси эхо-повторяют заголовки) — ключ в `internal`/логе заменён на `***` (тест в Task 2).
5. Администратор сохраняет настройки, не меняя ключ (поле `apiKey` отсутствует), — сохранённый ключ остаётся; «Проверить подключение» без ключа в форме использует сохранённый (тесты в Task 1 и Task 2).

---

### Task 1: Настройки ассистента — общие типы, таблица, админ-эндпоинты, `features.assistant`

**Files:**
- Create: `packages/shared/src/assistant.ts`, `packages/shared/src/assistant.test.ts`
- Modify: `packages/shared/src/index.ts` (реэкспорт, `Features.assistant`)
- Modify: `apps/api/src/db/schema.ts` (таблица `assistantSettings`)
- Create: `apps/api/drizzle/0018_assistant.sql` + снимок `apps/api/drizzle/meta/0018_snapshot.json` и запись в `meta/_journal.json` (генерируются `db:generate`)
- Create: `apps/api/src/modules/assistant/settings.ts`, `apps/api/src/modules/assistant/routes.ts`
- Modify: `apps/api/src/app.ts` (регистрация `registerAssistantRoutes`)
- Modify: `apps/api/src/modules/auth/routes.ts` (`toMe` → `features.assistant`)
- Modify: каталоги `packages/shared/src/i18n/<lang>/validation.json` и `errors.json` (7 языков)
- Test: `apps/api/test/assistant-settings.int.test.ts`

**Interfaces:**
- Produces (shared, `packages/shared/src/assistant.ts`):
  ```ts
  export const AssistantSettingsBody; export type AssistantSettingsBody;
  export interface AssistantSettingsDto { enabled: boolean; baseUrl: string; model: string; hasApiKey: boolean; extraInstructions: string }
  export const AssistantTestBody; export type AssistantTestBody; // { baseUrl, model, apiKey?: string | null }
  export type AssistantErrorCode = 'auth' | 'model' | 'unavailable' | 'limit';
  export type AssistantTestResult = { ok: true } | { ok: false; code: AssistantErrorCode; message: string };
  export const ChatTurn; export type ChatTurn; // { role: 'user' | 'assistant'; content: string }
  export const AssistantChatBody; export type AssistantChatBody; // { messages: ChatTurn[]; page: { path: string; reportId?: string } }
  export interface RunCardItem { label: string; value: string }
  export interface RunCard { reportId: string; reportName: string; params: Record<string, ParamValue>; display: RunCardItem[]; outputFormats: OutputFormat[]; defaultOutput: OutputFormat }
  export interface AssistantChatReply { reply: string; card: RunCard | null }
  ```
- Produces (API, `settings.ts`):
  ```ts
  export interface AssistantSettings { enabled: boolean; baseUrl: string; model: string; apiKey: string | null; extraInstructions: string }
  export async function loadAssistantSettings(db: Db, key: Buffer): Promise<AssistantSettings>
  export async function isAssistantEnabled(db: Db): Promise<boolean>
  export async function saveAssistantSettings(db: Db, key: Buffer, body: AssistantSettingsBody): Promise<void>
  export const toSettingsDto: (s: AssistantSettings) => AssistantSettingsDto
  ```
- Produces (API, `routes.ts`): `export function registerAssistantRoutes(app: App, deps: AppDeps, guards: Guards): void` — в этой задаче только `GET/PUT /api/admin/assistant`; Task 2 и Task 4 дописывают маршруты в эту же функцию.

- [ ] **Step 1: Общие типы и их тест.** `packages/shared/src/assistant.ts`:

```ts
// ИИ-ассистент (§50): настройки подключения к модели, чат, карточка запуска.
import { z } from 'zod';
import { OutputFormat, ParamValue } from './index';

const httpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** PUT /api/admin/assistant. apiKey: строка — заменить, null — удалить, нет поля — не менять. */
export const AssistantSettingsBody = z
  .object({
    enabled: z.boolean(),
    baseUrl: z.string().trim().max(500),
    model: z.string().trim().max(200),
    apiKey: z.string().max(4000).nullable().optional(),
    extraInstructions: z.string().max(2000),
  })
  .superRefine((b, ctx) => {
    if (b.baseUrl !== '' && !httpUrl(b.baseUrl))
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'v:assistantUrl' });
    if (b.enabled && b.baseUrl === '')
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'v:assistantUrl' });
    if (b.enabled && b.model === '')
      ctx.addIssue({ code: 'custom', path: ['model'], message: 'v:assistantModel' });
  });
export type AssistantSettingsBody = z.infer<typeof AssistantSettingsBody>;

export interface AssistantSettingsDto {
  enabled: boolean;
  baseUrl: string;
  model: string;
  /** Ключ задан; сам ключ не возвращается никогда. */
  hasApiKey: boolean;
  extraInstructions: string;
}

/** POST /api/admin/assistant/test: несохранённые значения формы; без apiKey — сохранённый ключ. */
export const AssistantTestBody = z.object({
  baseUrl: z.string().trim().min(1, 'v:assistantUrl').max(500).refine(httpUrl, 'v:assistantUrl'),
  model: z.string().trim().min(1, 'v:assistantModel').max(200),
  apiKey: z.string().max(4000).nullable().optional(),
});
export type AssistantTestBody = z.infer<typeof AssistantTestBody>;

export type AssistantErrorCode = 'auth' | 'model' | 'unavailable' | 'limit';
export type AssistantTestResult =
  | { ok: true }
  | { ok: false; code: AssistantErrorCode; message: string };

export const ChatTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

export const AssistantChatBody = z.object({
  messages: z.array(ChatTurn).min(1).max(20),
  page: z.object({ path: z.string().max(500), reportId: z.string().max(100).optional() }),
});
export type AssistantChatBody = z.infer<typeof AssistantChatBody>;

export interface RunCardItem {
  label: string;
  value: string;
}

/** Предложенный ассистентом запуск (§50.3): запускает пользователь кнопкой. */
export interface RunCard {
  reportId: string;
  reportName: string;
  params: Record<string, ParamValue>;
  display: RunCardItem[];
  outputFormats: OutputFormat[];
  defaultOutput: OutputFormat;
}

export interface AssistantChatReply {
  reply: string;
  card: RunCard | null;
}
```

Если импорт `./index` даёт цикл при загрузке (index реэкспортирует этот файл), перенести `import` на `type`-импорт для `OutputFormat`/`ParamValue` там, где это только типы (`RunCard`), — схемы `OutputFormat`/`ParamValue` здесь как значения не нужны: замените первую строку импорта на `import type { OutputFormat, ParamValue } from './index';`.

В `packages/shared/src/index.ts` рядом с остальными: `export * from './assistant';`, и:

```ts
export interface Features {
  backups: boolean;
  /** ИИ-ассистент включён администратором (§50.2). */
  assistant: boolean;
}
```

`packages/shared/src/assistant.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AssistantChatBody, AssistantSettingsBody } from './assistant';

const base = { enabled: false, baseUrl: '', model: '', extraInstructions: '' };

describe('AssistantSettingsBody', () => {
  it('выключенный ассистент без адреса и модели — допустим', () => {
    expect(AssistantSettingsBody.safeParse(base).success).toBe(true);
  });
  it('включение требует адрес и модель', () => {
    const r = AssistantSettingsBody.safeParse({ ...base, enabled: true });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path[0]).sort()).toEqual(['baseUrl', 'model']);
  });
  it('адрес только http(s)', () => {
    const r = AssistantSettingsBody.safeParse({ ...base, baseUrl: 'ftp://x' });
    expect(r.success).toBe(false);
    expect(
      AssistantSettingsBody.safeParse({
        ...base,
        enabled: true,
        baseUrl: 'http://ollama:11434/v1',
        model: 'qwen3',
      }).success,
    ).toBe(true);
  });
  it('доп. инструкции не длиннее 2000', () => {
    expect(
      AssistantSettingsBody.safeParse({ ...base, extraInstructions: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });
});

describe('AssistantChatBody', () => {
  const msg = { role: 'user' as const, content: 'счёт' };
  it('1–20 сообщений', () => {
    expect(AssistantChatBody.safeParse({ messages: [], page: { path: '/' } }).success).toBe(false);
    expect(
      AssistantChatBody.safeParse({ messages: Array(21).fill(msg), page: { path: '/' } }).success,
    ).toBe(false);
    expect(AssistantChatBody.safeParse({ messages: [msg], page: { path: '/' } }).success).toBe(true);
  });
  it('сообщение не длиннее 4000', () => {
    const long = { role: 'user', content: 'x'.repeat(4001) };
    expect(AssistantChatBody.safeParse({ messages: [long], page: { path: '/' } }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Тест падает.** Run: `pnpm --filter @carbone-reports/shared exec vitest run src/assistant.test.ts` — до создания файла FAIL (модуль не найден); после Step 1 — PASS. Запустить `pnpm --filter @carbone-reports/shared typecheck` (или `pnpm -r typecheck`, если отдельного скрипта нет) — ошибки в `apps/api` из-за `Features.assistant` ожидаемы до Step 5.

- [ ] **Step 3: Каталоги.** В `validation.json` всех семи языков добавить ключи верхнего уровня `assistantUrl` и `assistantModel`; в `errors.json` — `notFound.assistant` и группу `assistant`. Тексты (ru — источник; en ниже; для es, pt-BR, fr, de, zh-CN — перевод с en тем же смыслом, параметров нет):

| Файл / ключ | ru | en |
|---|---|---|
| validation `assistantUrl` | адрес API: http:// или https:// | API URL: http:// or https:// |
| validation `assistantModel` | укажите модель | enter a model |
| errors `notFound.assistant` | ассистент выключен | assistant is disabled |
| errors `assistant.auth` | Провайдер модели отклонил ключ. Обратитесь к администратору | The model provider rejected the key. Contact your administrator |
| errors `assistant.model` | Модель недоступна или не умеет вызывать инструменты. Обратитесь к администратору | The model is unavailable or cannot call tools. Contact your administrator |
| errors `assistant.unavailable` | Сервис модели не отвечает, попробуйте позже | The model service is not responding, try again later |
| errors `assistant.limit` | Не удалось подобрать отчёт. Уточните запрос | Could not find a suitable report. Please refine your request |
| errors `assistant.yes` | да | yes |
| errors `assistant.no` | нет | no |
| errors `assistant.empty` | — | — |

Run: `pnpm i18n:check` → без ошибок.

- [ ] **Step 4: Таблица и миграция.** В `apps/api/src/db/schema.ts` (импортировать `boolean`, `smallint`, `check`, `sql` там, где их ещё нет; `createdAt()`-подобный помощник для `updated_at` использовать, если в файле есть `updatedAt()`, иначе `timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()`):

```ts
/** Настройки ИИ-ассистента (§50.2): одна строка с id = 1. */
export const assistantSettings = pgTable(
  'assistant_settings',
  {
    id: smallint('id').primaryKey().default(1),
    enabled: boolean('enabled').notNull().default(false),
    baseUrl: text('base_url').notNull().default(''),
    model: text('model').notNull().default(''),
    apiKeyEnc: text('api_key_enc'),
    extraInstructions: text('extra_instructions').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('assistant_settings_singleton', sql`${t.id} = 1`)],
);
export type AssistantSettingsRow = typeof assistantSettings.$inferSelect;
```

Run: `pnpm --filter @carbone-reports/api db:generate --name assistant` → появляется `drizzle/0018_assistant.sql` (CREATE TABLE с CHECK). Проверить, что файл назван `0018_assistant.sql`; если drizzle-kit выбрал другое имя — переименовать файл и `tag` в `meta/_journal.json` согласованно.

- [ ] **Step 5: Интеграционный тест настроек (падает).** `apps/api/test/assistant-settings.int.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistantSettings } from '../src/db/schema';
import { decryptSecret } from '../src/lib/crypto';
import { createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let user: string;

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
});
afterAll(() => t.close());

const put = (payload: object, cookie = admin) =>
  t.app.inject({ method: 'PUT', url: '/api/admin/assistant', headers: { cookie }, payload });
const get = (cookie = admin) =>
  t.app.inject({ method: 'GET', url: '/api/admin/assistant', headers: { cookie } });
const me = (cookie: string) =>
  t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

const ON = {
  enabled: true,
  baseUrl: 'http://llm.local/v1',
  model: 'm1',
  extraInstructions: 'Продажи — в «Коммерции»',
};

describe('настройки ассистента', () => {
  it('по умолчанию выключен; features.assistant = false', async () => {
    expect((await get()).json()).toEqual({
      enabled: false,
      baseUrl: '',
      model: '',
      hasApiKey: false,
      extraInstructions: '',
    });
    expect((await me(user)).json().features.assistant).toBe(false);
  });

  it('только admin', async () => {
    expect((await get(user)).statusCode).toBe(403);
    expect((await put(ON, user)).statusCode).toBe(403);
  });

  it('ключ шифруется, не возвращается и не меняется без поля apiKey', async () => {
    expect((await put({ ...ON, apiKey: 'sk-secret' })).statusCode).toBe(204);
    const dto = (await get()).json();
    expect(dto).toEqual({ ...ON, hasApiKey: true });
    expect(JSON.stringify(dto)).not.toContain('sk-secret');
    const [row] = await t.deps.db.select().from(assistantSettings).where(eq(assistantSettings.id, 1));
    expect(row!.apiKeyEnc).not.toContain('sk-secret');
    expect(decryptSecret(row!.apiKeyEnc!, t.deps.config.encryptionKey)).toBe('sk-secret');

    expect((await put({ ...ON, model: 'm2' })).statusCode).toBe(204);
    const [row2] = await t.deps.db.select().from(assistantSettings).where(eq(assistantSettings.id, 1));
    expect(decryptSecret(row2!.apiKeyEnc!, t.deps.config.encryptionKey)).toBe('sk-secret');

    expect((await put({ ...ON, apiKey: null })).statusCode).toBe(204);
    expect((await get()).json().hasApiKey).toBe(false);
  });

  it('включённый ассистент виден в features.assistant', async () => {
    await put(ON);
    expect((await me(user)).json().features.assistant).toBe(true);
    await put({ ...ON, enabled: false });
    expect((await me(user)).json().features.assistant).toBe(false);
  });

  it('включение без адреса — 400 с полем baseUrl', async () => {
    const r = await put({ ...ON, baseUrl: '' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('baseUrl');
  });
});
```

Run: `pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/assistant-settings.int.test.ts` → FAIL (404 маршрута).

- [ ] **Step 6: `settings.ts`.**

```ts
// Настройки ИИ-ассистента (§50.2): одна строка; ключ — зашифрованным, наружу не отдаётся.
import type { AssistantSettingsBody, AssistantSettingsDto } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { assistantSettings } from '../../db/schema';
import { decryptSecret, encryptSecret } from '../../lib/crypto';

export interface AssistantSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  extraInstructions: string;
}

const DEFAULTS: AssistantSettings = {
  enabled: false,
  baseUrl: '',
  model: '',
  apiKey: null,
  extraInstructions: '',
};

async function row(db: Db) {
  const [r] = await db.select().from(assistantSettings).where(eq(assistantSettings.id, 1));
  return r;
}

export async function loadAssistantSettings(db: Db, key: Buffer): Promise<AssistantSettings> {
  const r = await row(db);
  if (!r) return { ...DEFAULTS };
  return {
    enabled: r.enabled,
    baseUrl: r.baseUrl,
    model: r.model,
    apiKey: r.apiKeyEnc ? decryptSecret(r.apiKeyEnc, key) : null,
    extraInstructions: r.extraInstructions,
  };
}

export async function isAssistantEnabled(db: Db): Promise<boolean> {
  return (await row(db))?.enabled ?? false;
}

export async function saveAssistantSettings(
  db: Db,
  key: Buffer,
  body: AssistantSettingsBody,
): Promise<void> {
  const values = {
    enabled: body.enabled,
    baseUrl: body.baseUrl,
    model: body.model,
    extraInstructions: body.extraInstructions,
    updatedAt: new Date(),
    // Нет поля — ключ не меняется; null или пустая строка — удалить.
    ...(body.apiKey === undefined
      ? {}
      : { apiKeyEnc: body.apiKey ? encryptSecret(body.apiKey, key) : null }),
  };
  await db
    .insert(assistantSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: assistantSettings.id, set: values });
}

export const toSettingsDto = (s: AssistantSettings): AssistantSettingsDto => ({
  enabled: s.enabled,
  baseUrl: s.baseUrl,
  model: s.model,
  hasApiKey: s.apiKey !== null,
  extraInstructions: s.extraInstructions,
});
```

- [ ] **Step 7: `routes.ts` и подключение.**

```ts
// Маршруты ИИ-ассистента (§50).
import { AssistantSettingsBody } from '@carbone-reports/shared';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import type { Guards } from '../auth/guards';
import { loadAssistantSettings, saveAssistantSettings, toSettingsDto } from './settings';

export function registerAssistantRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const admin = { preHandler: guards.requireAdmin };
  const key = deps.config.encryptionKey;

  app.get('/api/admin/assistant', admin, async () =>
    toSettingsDto(await loadAssistantSettings(deps.db, key)),
  );

  app.put(
    '/api/admin/assistant',
    { ...admin, schema: { body: AssistantSettingsBody } },
    async (req, reply) => {
      await saveAssistantSettings(deps.db, key, req.body);
      return reply.status(204).send();
    },
  );
}
```

В `apps/api/src/app.ts` — импорт и `registerAssistantRoutes(app, deps, guards);` после `registerDatasourceRoutes`. В `apps/api/src/modules/auth/routes.ts` `toMe` становится асинхронным:

```ts
  const toMe = async (user: SessionUser, locale: string | null): Promise<MeDto> => ({
    ...user,
    features: { backups: deps.backupAgent !== null, assistant: await isAssistantEnabled(deps.db) },
    locale: isLocale(locale) ? locale : null,
  });
```

и все вызовы `toMe(…)` в файле — с `await` (найти: `grep -n "toMe(" apps/api/src/modules/auth/routes.ts apps/api/src/modules/auth/oidc-routes.ts`).

- [ ] **Step 8: Тесты проходят.** Run: интеграционный тест из Step 5 → PASS; `pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/auth.int.test.ts` → PASS; `pnpm --filter @carbone-reports/api test` → PASS (если модульные тесты сравнивают `features` целиком — обновить ожидание на `{ backups: …, assistant: false }`); `pnpm -r typecheck` → без ошибок (в вебе тестовые `adminMe`/`userMe` без `features` — тип не требует, ок).

- [ ] **Step 9: Commit.**

```bash
git add packages/shared apps/api
git commit -m "feat(assistant): настройки ИИ-ассистента и features.assistant (§50.2)" -m "Co-Authored-By: …" 
```

---

### Task 2: Клиент модели и проверка подключения

**Files:**
- Create: `apps/api/src/modules/assistant/llm.ts`, `apps/api/src/modules/assistant/llm.test.ts`
- Modify: `apps/api/src/modules/assistant/routes.ts` (`POST /api/admin/assistant/test`)
- Test: дописать в `apps/api/test/assistant-settings.int.test.ts`

**Interfaces:**
- Consumes: `loadAssistantSettings`, `AssistantTestBody`, `AssistantTestResult`, `AssistantErrorCode` (Task 1).
- Produces (`llm.ts`):
  ```ts
  export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
  export type LlmMessage =
    | { role: 'system' | 'user'; content: string }
    | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
    | { role: 'tool'; tool_call_id: string; content: string };
  export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
  export interface LlmConfig { baseUrl: string; model: string; apiKey: string | null }
  export interface LlmRequest { messages: LlmMessage[]; tools: ToolSpec[]; toolChoice?: { type: 'function'; function: { name: string } } }
  export interface LlmResponse { content: string | null; toolCalls: ToolCall[] }
  export type LlmClient = (req: LlmRequest, signal?: AbortSignal) => Promise<LlmResponse>;
  export type LlmErrorCode = Exclude<AssistantErrorCode, 'limit'>;
  export class LlmError extends Error { readonly code: LlmErrorCode; readonly detail: string }
  export function createLlmClient(cfg: LlmConfig, opts?: { fetch?: typeof fetch; timeoutMs?: number }): LlmClient
  export async function testLlm(llm: LlmClient): Promise<void> // бросает LlmError
  export const LLM_TIMEOUT_MS = 60_000;
  ```
- Produces (`routes.ts`): `export function llmAppError(e: LlmError): AppError` — для Task 4.

- [ ] **Step 1: Модульный тест (падает).** `apps/api/src/modules/assistant/llm.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createLlmClient, LlmError, testLlm, type LlmRequest } from './llm';

const req: LlmRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (message: object) => json(200, { choices: [{ message }] });

async function codeOf(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(LlmError);
  return e as LlmError;
}

describe('createLlmClient', () => {
  it('POST {baseUrl}/chat/completions с моделью, tools и Bearer', async () => {
    const fetch = vi.fn(async () => ok({ content: 'привет' }));
    const llm = createLlmClient(
      { baseUrl: 'http://x/v1/', model: 'm', apiKey: 'k' },
      { fetch },
    );
    expect(await llm(req)).toEqual({ content: 'привет', toolCalls: [] });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://x/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'm', messages: req.messages, stream: false });
    expect(body.tools).toBeUndefined(); // пустой список инструментов не отправляется
  });

  it('без ключа — без Authorization', async () => {
    const fetch = vi.fn(async () => ok({ content: 'x' }));
    await createLlmClient({ baseUrl: 'http://x', model: 'm', apiKey: null }, { fetch })(req);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('tool_calls разбираются', async () => {
    const call = { id: 'c1', type: 'function', function: { name: 'list_reports', arguments: '{}' } };
    const fetch = vi.fn(async () => ok({ content: null, tool_calls: [call] }));
    const r = await createLlmClient({ baseUrl: 'http://x', model: 'm', apiKey: null }, { fetch })(req);
    expect(r).toEqual({ content: null, toolCalls: [call] });
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model'],
    [400, 'model'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('HTTP %i → %s', async (status, code) => {
    const fetch = vi.fn(async () => json(status, { error: { message: 'boom' } }));
    const e = await codeOf(
      createLlmClient({ baseUrl: 'http://x', model: 'm', apiKey: null }, { fetch })(req),
    );
    expect(e.code).toBe(code);
    expect(e.detail).toContain(String(status));
  });

  it('сеть и неразборчивый ответ → unavailable', async () => {
    const cfg = { baseUrl: 'http://x', model: 'm', apiKey: null };
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await codeOf(createLlmClient(cfg, { fetch: down })(req))).code).toBe('unavailable');
    const junk = vi.fn(async () => new Response('<html>', { status: 200 }));
    expect((await codeOf(createLlmClient(cfg, { fetch: junk })(req))).code).toBe('unavailable');
    const empty = vi.fn(async () => json(200, { choices: [] }));
    expect((await codeOf(createLlmClient(cfg, { fetch: empty })(req))).code).toBe('unavailable');
  });

  it('таймаут → unavailable', async () => {
    const hang = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_r, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    const llm = createLlmClient(
      { baseUrl: 'http://x', model: 'm', apiKey: null },
      { fetch: hang as unknown as typeof fetch, timeoutMs: 20 },
    );
    expect((await codeOf(llm(req))).code).toBe('unavailable');
  });

  it('ключ в теле ошибки заменяется на ***', async () => {
    const fetch = vi.fn(async () => json(401, { error: 'bad key sk-SECRET-1' }));
    const e = await codeOf(
      createLlmClient({ baseUrl: 'http://x', model: 'm', apiKey: 'sk-SECRET-1' }, { fetch })(req),
    );
    expect(e.detail).not.toContain('sk-SECRET-1');
    expect(e.message).not.toContain('sk-SECRET-1');
    expect(e.detail).toContain('***');
  });
});

describe('testLlm', () => {
  it('модель вызвала ping — ок; не вызвала — model', async () => {
    const pinged = vi.fn(async () => ({
      content: null,
      toolCalls: [{ id: '1', type: 'function' as const, function: { name: 'ping', arguments: '{}' } }],
    }));
    await expect(testLlm(pinged)).resolves.toBeUndefined();
    expect(pinged.mock.calls[0]![0].toolChoice).toEqual({ type: 'function', function: { name: 'ping' } });
    const silent = vi.fn(async () => ({ content: 'pong', toolCalls: [] }));
    expect((await codeOf(testLlm(silent))).code).toBe('model');
  });
});
```

Run: `pnpm --filter @carbone-reports/api exec vitest run src/modules/assistant/llm.test.ts` → FAIL (модуль не найден).

- [ ] **Step 2: `llm.ts`.**

```ts
// Клиент OpenAI-совместимого API (§50.3): POST /chat/completions с tools, без потока.
import type { AssistantErrorCode } from '@carbone-reports/shared';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
}
export interface LlmRequest {
  messages: LlmMessage[];
  tools: ToolSpec[];
  toolChoice?: { type: 'function'; function: { name: string } };
}
export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
}
export type LlmClient = (req: LlmRequest, signal?: AbortSignal) => Promise<LlmResponse>;
export type LlmErrorCode = Exclude<AssistantErrorCode, 'limit'>;

export const LLM_TIMEOUT_MS = 60_000;

/** Ошибка провайдера; detail — для журнала (без ключа), пользователю — текст по коду. */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    readonly detail: string,
  ) {
    super(`модель: ${code}: ${detail}`);
    this.name = 'LlmError';
  }
}

const codeFor = (status: number): LlmErrorCode =>
  status === 401 || status === 403
    ? 'auth'
    : status === 404 || status === 400 || status === 422
      ? 'model'
      : 'unavailable';

export function createLlmClient(
  cfg: LlmConfig,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): LlmClient {
  const doFetch = opts.fetch ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const hide = (s: string) => (cfg.apiKey ? s.split(cfg.apiKey).join('***') : s);
  const fail = (code: LlmErrorCode, detail: string) => new LlmError(code, hide(detail).slice(0, 500));

  return async (req, signal) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? LLM_TIMEOUT_MS);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const body: Record<string, unknown> = { model: cfg.model, messages: req.messages, stream: false };
    if (req.tools.length > 0) body.tools = req.tools;
    if (req.toolChoice) body.tool_choice = req.toolChoice;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw fail('unavailable', e instanceof Error ? e.message : String(e));
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw fail(codeFor(res.status), `HTTP ${res.status}: ${text}`);
    let message: { content?: unknown; tool_calls?: unknown } | undefined;
    try {
      message = (JSON.parse(text) as { choices?: { message?: typeof message }[] }).choices?.[0]
        ?.message;
    } catch {
      message = undefined;
    }
    if (!message) throw fail('unavailable', `неразборчивый ответ: ${text}`);
    const toolCalls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as ToolCall[]).filter((c) => c?.function?.name)
      : [];
    return {
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls: toolCalls.map((c, i) => ({
        id: c.id || `call_${i}`,
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments ?? '{}' },
      })),
    };
  };
}

/** Проверка подключения (§50.2): модель должна вызвать инструмент ping. */
export async function testLlm(llm: LlmClient): Promise<void> {
  const r = await llm({
    messages: [
      { role: 'system', content: 'Call the ping tool.' },
      { role: 'user', content: 'ping' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'ping',
          description: 'Connectivity check',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    toolChoice: { type: 'function', function: { name: 'ping' } },
  });
  if (!r.toolCalls.some((c) => c.function.name === 'ping'))
    throw new LlmError('model', 'модель не вызвала инструмент');
}
```

Run: тест из Step 1 → PASS.

- [ ] **Step 3: Маршрут проверки — тест (падает).** Дописать в `apps/api/test/assistant-settings.int.test.ts` (фейковый сервер модели — `node:http`):

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Фейковый OpenAI: отвечает handler(body); запоминает заголовки. */
export async function fakeLlm(
  handler: (body: { messages: unknown[]; tools?: unknown[] }) => { status?: number; message?: object },
): Promise<{ url: string; auth: (string | undefined)[]; close(): Promise<void> }> {
  const auth: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      auth.push(req.headers.authorization);
      const r = handler(JSON.parse(raw));
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.message ? { choices: [{ message: r.message }] } : { error: 'x' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    auth,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
```

(вынести `fakeLlm` в `apps/api/test/fake-llm.ts`, чтобы Task 4 его переиспользовал.)

```ts
describe('проверка подключения', () => {
  const ping = { content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'ping', arguments: '{}' } }] };
  const test = (payload: object, cookie = admin) =>
    t.app.inject({ method: 'POST', url: '/api/admin/assistant/test', headers: { cookie }, payload });

  it('ok и ключ из формы', async () => {
    const llm = await fakeLlm(() => ({ message: ping }));
    const r = await test({ baseUrl: llm.url, model: 'm', apiKey: 'form-key' });
    expect(r.json()).toEqual({ ok: true });
    expect(llm.auth).toEqual(['Bearer form-key']);
    await llm.close();
  });

  it('без apiKey берётся сохранённый ключ', async () => {
    await put({ ...ON, apiKey: 'saved-key' });
    const llm = await fakeLlm(() => ({ message: ping }));
    await test({ baseUrl: llm.url, model: 'm' });
    expect(llm.auth).toEqual(['Bearer saved-key']);
    await llm.close();
  });

  it('401 → auth с текстом; недоступный адрес → unavailable; только admin', async () => {
    const llm = await fakeLlm(() => ({ status: 401 }));
    expect((await test({ baseUrl: llm.url, model: 'm', apiKey: 'k' })).json()).toEqual({
      ok: false,
      code: 'auth',
      message: 'Провайдер модели отклонил ключ. Обратитесь к администратору',
    });
    await llm.close();
    const down = await test({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: null });
    expect(down.json()).toMatchObject({ ok: false, code: 'unavailable' });
    expect((await test({ baseUrl: llm.url, model: 'm' }, user)).statusCode).toBe(403);
  });
});
```

Run: интеграционный файл → новые тесты FAIL (404).

- [ ] **Step 4: Маршрут.** В `routes.ts`:

```ts
import { AssistantTestBody, type AssistantTestResult } from '@carbone-reports/shared';
import { AppError, translateMsg } from '../../lib/errors';
import { createLlmClient, LlmError, testLlm } from './llm';

/** Ошибка модели → ответ 502 с кодом; detail — только в журнал (internal). */
export const llmAppError = (e: LlmError) =>
  new AppError(`ASSISTANT_${e.code.toUpperCase()}`, 502, { key: `assistant.${e.code}` }, undefined, e.detail);

// внутри registerAssistantRoutes:
  app.post(
    '/api/admin/assistant/test',
    { ...admin, schema: { body: AssistantTestBody } },
    async (req): Promise<AssistantTestResult> => {
      const apiKey =
        req.body.apiKey === undefined
          ? (await loadAssistantSettings(deps.db, key)).apiKey
          : req.body.apiKey || null;
      try {
        await testLlm(createLlmClient({ baseUrl: req.body.baseUrl, model: req.body.model, apiKey }));
        return { ok: true };
      } catch (e) {
        if (!(e instanceof LlmError)) throw e;
        req.log.warn({ code: e.code, detail: e.detail }, 'проверка подключения к модели');
        return {
          ok: false,
          code: e.code,
          message: translateMsg(req.locale, { key: `assistant.${e.code}` }),
        };
      }
    },
  );
```

Run: интеграционный файл → PASS; `pnpm --filter @carbone-reports/api typecheck` → без ошибок.

- [ ] **Step 5: Commit** — `feat(assistant): клиент OpenAI-совместимого API и проверка подключения (§50.2–50.3)`.

---

### Task 3: Инструменты ассистента

**Files:**
- Create: `apps/api/src/modules/assistant/tools.ts`, `apps/api/src/modules/assistant/tools.test.ts`

**Interfaces:**
- Consumes: `ToolSpec` (Task 2), `RunCard` (Task 1); `resolveParams` (`../queries/params`), `validateQueryParams`, `optionsForParam` (`../queries/param-options`), `loadTemplateFull` (`../templates/service`), `AppError`, `translateMsg` (`../../lib/errors`); типы `TemplateSummary`, `TemplateDetails`, `ParamOptionsResult`, `ParamValue`.
- Produces:
  ```ts
  export type ToolOutcome = { result: unknown } | { card: RunCard };
  export interface AgentTools { specs: ToolSpec[]; run(name: string, args: unknown): Promise<ToolOutcome> }
  /** Вызов существующего эндпоинта от имени пользователя. */
  export type Inject = (method: 'GET' | 'POST', url: string, payload?: unknown) => Promise<{ status: number; body: unknown }>;
  export interface ToolContext { inject: Inject; deps: AppDeps; locale: Locale }
  export function createAssistantTools(ctx: ToolContext): AgentTools
  export const shapeReports: (list: TemplateSummary[], search?: string) => { total: number; reports: { id: string; name: string; description: string; category: string | null }[] }
  export const shapeForm: (d: TemplateDetails) => { id: string; name: string; description: string; params: ShapedParam[] }
  export const shapeOptions: (r: ParamOptionsResult, search?: string) => { total: number; values: { value: string | number; label: string }[] } | { waitingFor: string[] }
  ```

- [ ] **Step 1: Тест чистых функций (падает).** `apps/api/src/modules/assistant/tools.test.ts`:

```ts
import type { TemplateDetails, TemplateSummary } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { shapeForm, shapeOptions, shapeReports } from './tools';

const summary = (name: string, extra: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: `id-${name}`,
  name,
  description: '',
  fileExt: 'docx',
  defaultOutput: 'pdf',
  updatedAt: '2026-10-01T00:00:00Z',
  category: null,
  editingBy: null,
  ...extra,
});

describe('shapeReports', () => {
  it('поля без лишнего, поиск по названию, описанию, категории без учёта регистра', () => {
    const list = [
      summary('Счёт', { description: 'для покупателя' }),
      summary('Акт', { category: { id: 'c', name: 'Продажи', sortOrder: 0 } }),
      summary('Склад'),
    ];
    expect(shapeReports(list).reports[1]).toEqual({
      id: 'id-Акт',
      name: 'Акт',
      description: '',
      category: 'Продажи',
    });
    expect(shapeReports(list, 'ПОКУПАТ').reports.map((r) => r.name)).toEqual(['Счёт']);
    expect(shapeReports(list, 'продаж').reports.map((r) => r.name)).toEqual(['Акт']);
  });
  it('не больше 50 и общее количество', () => {
    const r = shapeReports(Array.from({ length: 60 }, (_, i) => summary(`R${i}`)));
    expect(r.total).toBe(60);
    expect(r.reports).toHaveLength(50);
  });
});

describe('shapeForm', () => {
  it('карточка конструктора: SQL, запросы и pdfOptions не попадают в результат', () => {
    const admin = {
      id: 't', name: 'Счёт', description: 'd', fileExt: 'docx', defaultOutput: 'pdf',
      updatedAt: '', category: null, editingBy: null, outputFormats: ['pdf'],
      signatureAllowed: false, signMethod: null, datasourceId: 'ds', version: 3,
      queries: [{ key: 'q', sql: 'select secret from salaries' }], charts: [],
      pdfOptions: { watermark: 'TOP SECRET' },
      params: [
        { name: 'company', label: 'Компания', type: 'query', required: true, defaultValue: null,
          options: null, sql: 'select id from company_secret', multiple: false, dependsOn: [] },
        { name: 'kind', label: 'Вид', type: 'select', required: false, defaultValue: 'a',
          options: [{ value: 'a', label: 'А' }], sql: null, multiple: false, dependsOn: [] },
      ],
    } as unknown as TemplateDetails;
    const shaped = shapeForm(admin);
    const text = JSON.stringify(shaped);
    for (const leak of ['salaries', 'company_secret', 'TOP SECRET', 'datasourceId', '"sql"', 'queries'])
      expect(text).not.toContain(leak);
    expect(shaped.params[0]).toEqual({
      name: 'company', label: 'Компания', type: 'query', required: true, default: null,
      multiple: false, valuesVia: 'find_param_values', dependsOn: [],
    });
    expect(shaped.params[1]).toMatchObject({ name: 'kind', options: [{ value: 'a', label: 'А' }] });
  });
});

describe('shapeOptions', () => {
  it('поиск по подписи, ≤30, общее количество', () => {
    const options = Array.from({ length: 40 }, (_, i) => ({ value: i, label: `ООО Ромашка ${i}` }));
    options.push({ value: 99, label: 'АО Лютик' });
    const all = shapeOptions({ options });
    expect('values' in all && all.values.length).toBe(30);
    expect('total' in all && all.total).toBe(41);
    const found = shapeOptions({ options }, 'лютик');
    expect(found).toEqual({ total: 1, values: [{ value: 99, label: 'АО Лютик' }] });
  });
  it('ждёт родителей — waitingFor', () => {
    expect(shapeOptions({ options: [], waitingFor: ['region'] })).toEqual({ waitingFor: ['region'] });
  });
});
```

Run: `pnpm --filter @carbone-reports/api exec vitest run src/modules/assistant/tools.test.ts` → FAIL.

- [ ] **Step 2: `tools.ts`.**

```ts
// Инструменты ассистента (§50.4). Вызовы идут через существующие эндпоинты от имени
// пользователя (app.inject с его cookie): права и проверки — те же, что в интерфейсе.
// Результаты сокращаются до метаданных (§50.1): SQL, запросы и данные в модель не уходят.
import type {
  ParamOptionsResult,
  ParamValue,
  RunCard,
  RunCardItem,
  TemplateDetails,
  TemplateSummary,
} from '@carbone-reports/shared';
import type { Locale } from '@carbone-reports/shared/i18n';
import { z } from 'zod';
import type { AppDeps } from '../../deps';
import { AppError, translateMsg } from '../../lib/errors';
import { optionsForParam, validateQueryParams } from '../queries/param-options';
import { resolveParams } from '../queries/params';
import { loadTemplateFull } from '../templates/service';
import type { ToolSpec } from './llm';

export type ToolOutcome = { result: unknown } | { card: RunCard };
export interface AgentTools {
  specs: ToolSpec[];
  run(name: string, args: unknown): Promise<ToolOutcome>;
}
export type Inject = (
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) => Promise<{ status: number; body: unknown }>;
export interface ToolContext {
  inject: Inject;
  deps: AppDeps;
  locale: Locale;
}

const MAX_REPORTS = 50;
const MAX_VALUES = 30;

const has = (text: string | null | undefined, q: string) =>
  (text ?? '').toLocaleLowerCase().includes(q);

export const shapeReports = (list: TemplateSummary[], search?: string) => {
  const q = search?.trim().toLocaleLowerCase();
  const found = q
    ? list.filter((t) => has(t.name, q) || has(t.description, q) || has(t.category?.name, q))
    : list;
  return {
    total: found.length,
    reports: found.slice(0, MAX_REPORTS).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category?.name ?? null,
    })),
  };
};

export interface ShapedParam {
  name: string;
  label: string;
  type: string;
  required: boolean;
  default: ParamValue;
  multiple: boolean;
  options?: { value: string; label: string }[];
  valuesVia?: 'find_param_values';
  dependsOn?: string[];
}

/** Только перечисленные поля: автору эндпоинт отдаёт карточку конструктора с SQL. */
export const shapeForm = (d: TemplateDetails) => ({
  id: d.id,
  name: d.name,
  description: d.description,
  params: d.params.map((p): ShapedParam => ({
    name: p.name,
    label: p.label,
    type: p.type,
    required: p.required,
    default: p.defaultValue,
    multiple: p.multiple,
    ...(p.type === 'select' && p.options
      ? { options: p.options.map((o) => ({ value: o.value, label: o.label })) }
      : {}),
    ...(p.type === 'query' ? { valuesVia: 'find_param_values' as const, dependsOn: p.dependsOn } : {}),
  })),
});

export const shapeOptions = (r: ParamOptionsResult, search?: string) => {
  if (r.waitingFor?.length) return { waitingFor: r.waitingFor };
  const q = search?.trim().toLocaleLowerCase();
  const found = q
    ? r.options.filter((o) => has(o.label, q) || has(String(o.value), q))
    : r.options;
  return {
    total: found.length,
    values: found.slice(0, MAX_VALUES).map((o) => ({ value: o.value, label: o.label })),
  };
};

const SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'list_reports',
      description:
        'List report templates available to the user. Optional search filters by name, description or category (case-insensitive substring).',
      parameters: {
        type: 'object',
        properties: { search: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_report_form',
      description: 'Get the parameters of a report template: names, labels, types, required flags, defaults and select options.',
      parameters: {
        type: 'object',
        properties: { reportId: { type: 'string' } },
        required: ['reportId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_param_values',
      description:
        'Find allowed values of a parameter of type "query". search filters by label. params: values of already chosen parameters (needed for dependent lists). Use the value, not the label, in propose_run.',
      parameters: {
        type: 'object',
        properties: {
          reportId: { type: 'string' },
          param: { type: 'string' },
          search: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['reportId', 'param'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_run',
      description:
        'Propose running the report with the given parameter values. The user confirms the run with a button. Returns an error if parameters are invalid.',
      parameters: {
        type: 'object',
        properties: { reportId: { type: 'string' }, params: { type: 'object' } },
        required: ['reportId', 'params'],
      },
    },
  },
];

const Id = z.string().min(1).max(100);
const Params = z.record(z.string(), z.unknown()).default({});
const ARGS = {
  list_reports: z.object({ search: z.string().max(200).optional() }),
  get_report_form: z.object({ reportId: Id }),
  find_param_values: z.object({
    reportId: Id,
    param: z.string().min(1).max(100),
    search: z.string().max(200).optional(),
    params: Params,
  }),
  propose_run: z.object({ reportId: Id, params: Params }),
};

/** Ответ эндпоинта с ошибкой → текст ошибки для модели. */
const errorOf = (r: { status: number; body: unknown }) => ({
  error:
    (r.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${r.status}`,
});

const enc = encodeURIComponent;

export function createAssistantTools(ctx: ToolContext): AgentTools {
  const { inject, deps, locale } = ctx;

  async function form(reportId: string) {
    const r = await inject('GET', `/api/templates/${enc(reportId)}`);
    return r.status === 200 ? { details: r.body as TemplateDetails } : { error: errorOf(r) };
  }

  async function display(reportId: string, resolved: Record<string, ParamValue>): Promise<RunCardItem[]> {
    const full = await loadTemplateFull(deps.db, reportId);
    const yes = translateMsg(locale, { key: 'assistant.yes' });
    const no = translateMsg(locale, { key: 'assistant.no' });
    const empty = translateMsg(locale, { key: 'assistant.empty' });
    const items: RunCardItem[] = [];
    for (const p of full.params) {
      const v = resolved[p.name];
      const values = v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];
      let labels: string[];
      if (p.type === 'boolean') labels = [v ? yes : no];
      else if (p.type === 'select')
        labels = values.map((x) => p.options?.find((o) => o.value === String(x))?.label ?? String(x));
      else if (p.type === 'query' && values.length > 0) {
        const opts = await optionsForParam(deps, full, p.name, resolved);
        labels = values.map((x) => opts.options.find((o) => String(o.value) === String(x))?.label ?? String(x));
      } else labels = values.map(String);
      items.push({ label: p.label, value: labels.length ? labels.join(', ') : empty });
    }
    return items;
  }

  async function run(name: string, raw: unknown): Promise<ToolOutcome> {
    if (!(name in ARGS)) return { result: { error: `unknown tool: ${name}` } };
    const parsed = ARGS[name as keyof typeof ARGS].safeParse(raw ?? {});
    if (!parsed.success) return { result: { error: `invalid arguments: ${parsed.error.message}` } };
    const a = parsed.data as Record<string, unknown>;
    switch (name) {
      case 'list_reports': {
        const r = await inject('GET', '/api/templates');
        if (r.status !== 200) return { result: errorOf(r) };
        return { result: shapeReports(r.body as TemplateSummary[], a.search as string | undefined) };
      }
      case 'get_report_form': {
        const f = await form(a.reportId as string);
        return { result: 'error' in f ? f.error : shapeForm(f.details) };
      }
      case 'find_param_values': {
        const r = await inject(
          'POST',
          `/api/templates/${enc(a.reportId as string)}/params/${enc(a.param as string)}/options`,
          { params: a.params },
        );
        if (r.status !== 200) return { result: errorOf(r) };
        return { result: shapeOptions(r.body as ParamOptionsResult, a.search as string | undefined) };
      }
      default: {
        // propose_run: доступ — через эндпоинт; проверка параметров — та же, что при формировании.
        const reportId = a.reportId as string;
        const f = await form(reportId);
        if ('error' in f) return { result: f.error };
        const full = await loadTemplateFull(deps.db, reportId);
        let resolved: Record<string, ParamValue>;
        try {
          resolved = resolveParams(full.params, a.params as Record<string, ParamValue>);
          await validateQueryParams(deps, full, resolved);
        } catch (e) {
          if (e instanceof AppError && e.code === 'VALIDATION')
            return { result: { error: e.textIn(locale), fields: e.detailsIn(locale) } };
          throw e;
        }
        return {
          card: {
            reportId,
            reportName: f.details.name,
            params: resolved,
            display: await display(reportId, resolved),
            outputFormats: f.details.outputFormats,
            defaultOutput: f.details.defaultOutput,
          },
        };
      }
    }
  }

  return { specs: SPECS, run };
}
```

Примечание для исполнителя: `ParamsInput` из zod-схемы принимает только `ParamValue`; значения от модели — `unknown`. `resolveParams` проверяет типы сам (`checkParam` → `checkValue`), но если на неожиданный тип (объект) он бросает не `AppError VALIDATION`, а падает, — перед `resolveParams` отфильтровать: `ParamsInput.safeParse(a.params)`; при неуспехе вернуть `{ result: { error: 'invalid params: values must be strings, numbers, booleans, null or arrays' } }`. Добавить на это модульный тест не нужно — его покрывает интеграционный тест Task 4 («объект в значении параметра»).

Run: тест из Step 1 → PASS; `pnpm --filter @carbone-reports/api typecheck`.

- [ ] **Step 3: Commit** — `feat(assistant): инструменты list_reports, get_report_form, find_param_values, propose_run (§50.4)`.

---

### Task 4: Цикл ассистента и `POST /api/assistant/chat`

**Files:**
- Create: `apps/api/src/modules/assistant/agent.ts`, `apps/api/src/modules/assistant/agent.test.ts`, `apps/api/src/modules/assistant/prompt.ts`
- Modify: `apps/api/src/modules/assistant/routes.ts`
- Create: `apps/api/test/assistant-chat.int.test.ts`

**Interfaces:**
- Consumes: `LlmClient`, `LlmMessage`, `LlmError`, `createLlmClient` (Task 2), `llmAppError` (Task 2), `AgentTools`, `createAssistantTools`, `Inject` (Task 3), `loadAssistantSettings` (Task 1), `AssistantChatBody`, `AssistantChatReply`, `ChatTurn` (Task 1), `fakeLlm` (`apps/api/test/fake-llm.ts`, Task 2).
- Produces:
  ```ts
  export class AgentLimitError extends Error {}
  export const MAX_TOOL_CALLS = 8; export const AGENT_DEADLINE_MS = 120_000;
  export async function runAgent(o: { llm: LlmClient; tools: AgentTools; system: string; history: ChatTurn[]; maxToolCalls?: number; deadlineMs?: number; signal?: AbortSignal }): Promise<AssistantChatReply>
  export function systemPrompt(o: { locale: Locale; today: string; extra: string; page: { path: string; reportId?: string } }): string
  ```

- [ ] **Step 1: Модульный тест цикла (падает).** `apps/api/src/modules/assistant/agent.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { AgentLimitError, runAgent } from './agent';
import type { LlmClient, LlmResponse } from './llm';
import type { AgentTools } from './tools';

const call = (name: string, args: string, id = name): LlmResponse => ({
  content: null,
  toolCalls: [{ id, type: 'function', function: { name, arguments: args } }],
});
const text = (content: string): LlmResponse => ({ content, toolCalls: [] });
const script = (...steps: LlmResponse[]) => {
  const llm = vi.fn<LlmClient>(async () => steps.shift() ?? text('конец'));
  return llm;
};
const card = { reportId: 'r', reportName: 'Счёт', params: {}, display: [], outputFormats: ['pdf' as const], defaultOutput: 'pdf' as const };
const tools = (impl?: AgentTools['run']): AgentTools => ({
  specs: [],
  run: vi.fn(impl ?? (async (name) => (name === 'propose_run' ? { card } : { result: { ok: name } }))),
});
const base = { system: 'sys', history: [{ role: 'user' as const, content: 'счёт' }] };

describe('runAgent', () => {
  it('инструменты по цепочке, результат уходит модели, текст — ответ', async () => {
    const llm = script(call('list_reports', '{}'), text('Нашёл'));
    const t = tools();
    expect(await runAgent({ llm, tools: t, ...base })).toEqual({ reply: 'Нашёл', card: null });
    const second = llm.mock.calls[1]![0].messages;
    expect(second[0]).toEqual({ role: 'system', content: 'sys' });
    expect(second.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'list_reports',
      content: JSON.stringify({ ok: 'list_reports' }),
    });
  });

  it('propose_run завершает ответ карточкой', async () => {
    const llm = script({ ...call('propose_run', '{"reportId":"r","params":{}}'), content: 'Готово' });
    expect(await runAgent({ llm, tools: tools(), ...base })).toEqual({ reply: 'Готово', card });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('неверный JSON аргументов — ошибка модели, цикл продолжается', async () => {
    const llm = script(call('get_report_form', '{oops'), text('Уточните'));
    const t = tools();
    expect((await runAgent({ llm, tools: t, ...base })).reply).toBe('Уточните');
    expect(t.run).not.toHaveBeenCalled();
    expect(String(llm.mock.calls[1]![0].messages.at(-1)!.content)).toContain('invalid JSON');
  });

  it('исключение инструмента — ошибка модели, а не 500', async () => {
    const llm = script(call('list_reports', '{}'), text('ok'));
    const t = tools(async () => {
      throw new Error('db down');
    });
    expect((await runAgent({ llm, tools: t, ...base })).reply).toBe('ok');
    expect(String(llm.mock.calls[1]![0].messages.at(-1)!.content)).toContain('tool failed');
  });

  it('больше maxToolCalls вызовов — AgentLimitError', async () => {
    const llm = vi.fn<LlmClient>(async () => call('list_reports', '{}'));
    await expect(runAgent({ llm, tools: tools(), ...base, maxToolCalls: 3 })).rejects.toBeInstanceOf(
      AgentLimitError,
    );
    expect(llm).toHaveBeenCalledTimes(4);
  });

  it('пустой финальный ответ — AgentLimitError', async () => {
    await expect(runAgent({ llm: script(text('  ')), tools: tools(), ...base })).rejects.toBeInstanceOf(
      AgentLimitError,
    );
  });

  it('срок истёк — AgentLimitError', async () => {
    const llm = vi.fn<LlmClient>(
      (_r, signal) =>
        new Promise((_res, rej) => signal!.addEventListener('abort', () => rej(new Error('aborted')))),
    );
    await expect(runAgent({ llm, tools: tools(), ...base, deadlineMs: 30 })).rejects.toBeInstanceOf(
      AgentLimitError,
    );
  });
});
```

Run: `pnpm --filter @carbone-reports/api exec vitest run src/modules/assistant/agent.test.ts` → FAIL.

- [ ] **Step 2: `agent.ts`.**

```ts
// Цикл ассистента (§50.3): модель → инструменты → … до текста или карточки запуска.
import type { AssistantChatReply, ChatTurn } from '@carbone-reports/shared';
import type { LlmClient, LlmMessage } from './llm';
import type { AgentTools } from './tools';

export const MAX_TOOL_CALLS = 8;
export const AGENT_DEADLINE_MS = 120_000;

/** Превышены шаги или срок, либо модель не дала ответа. */
export class AgentLimitError extends Error {
  constructor(reason: string) {
    super(`ассистент: ${reason}`);
    this.name = 'AgentLimitError';
  }
}

export async function runAgent(o: {
  llm: LlmClient;
  tools: AgentTools;
  system: string;
  history: ChatTurn[];
  maxToolCalls?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<AssistantChatReply> {
  const max = o.maxToolCalls ?? MAX_TOOL_CALLS;
  const deadline = AbortSignal.timeout(o.deadlineMs ?? AGENT_DEADLINE_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline]) : deadline;
  const messages: LlmMessage[] = [{ role: 'system', content: o.system }, ...o.history];
  let calls = 0;
  for (;;) {
    let res;
    try {
      res = await o.llm({ messages, tools: o.tools.specs }, signal);
    } catch (e) {
      if (deadline.aborted) throw new AgentLimitError('срок');
      throw e;
    }
    const text = res.content?.trim() ?? '';
    if (res.toolCalls.length === 0) {
      if (!text) throw new AgentLimitError('пустой ответ');
      return { reply: text, card: null };
    }
    messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
    for (const c of res.toolCalls) {
      if (++calls > max) throw new AgentLimitError('шаги');
      let content: unknown;
      let args: unknown;
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {
        content = { error: 'invalid JSON in arguments' };
      }
      if (content === undefined) {
        try {
          const out = await o.tools.run(c.function.name, args);
          if ('card' in out) return { reply: text, card: out.card };
          content = out.result;
        } catch (e) {
          content = { error: `tool failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(content) });
    }
  }
}
```

Run: тест из Step 1 → PASS.

- [ ] **Step 3: Системный промпт.** `apps/api/src/modules/assistant/prompt.ts`:

```ts
// Системный промпт ассистента (§50.3): на английском, ответ — на языке пользователя.
import { LOCALE_NAMES, type Locale } from '@carbone-reports/shared/i18n';

export function systemPrompt(o: {
  locale: Locale;
  today: string;
  extra: string;
  page: { path: string; reportId?: string };
}): string {
  const lines = [
    'You are the report assistant of Carbone Reports. You help the user find a report template, fill in its parameters and propose a run.',
    'Rules:',
    '- Use the tools to find reports, parameters and allowed values. Never invent report ids, parameter names or values.',
    '- Before propose_run, call get_report_form for that report. For parameters of type "query" find values with find_param_values; for "select" use the listed options. Pass the value, not the label.',
    '- If a required parameter is missing or ambiguous, ask the user one short question instead of guessing. Optional parameters may stay empty.',
    '- The only way to run a report is propose_run; the user confirms the run with a button. Do not claim that a report was generated.',
    '- You cannot read report contents or query results.',
    `- Dates use the format YYYY-MM-DD. Today is ${o.today}.`,
    `- Reply briefly, in plain text without Markdown, in ${LOCALE_NAMES[o.locale]}.`,
    `Current page: ${o.page.path}${o.page.reportId ? `; the open report id is ${o.page.reportId}` : ''}.`,
  ];
  if (o.extra.trim()) lines.push('Administrator instructions:', o.extra.trim());
  return lines.join('\n');
}
```

Модульный тест в `agent.test.ts` (дописать):

```ts
import { systemPrompt } from './prompt';

describe('systemPrompt', () => {
  it('язык, дата, страница, инструкции администратора', () => {
    const s = systemPrompt({ locale: 'de', today: '2026-10-27', extra: ' Продажи — «Коммерция» ', page: { path: '/reports/r1', reportId: 'r1' } });
    expect(s).toContain('in Deutsch');
    expect(s).toContain('Today is 2026-10-27');
    expect(s).toContain('the open report id is r1');
    expect(s.endsWith('Administrator instructions:\nПродажи — «Коммерция»')).toBe(true);
    expect(systemPrompt({ locale: 'ru', today: 'x', extra: '', page: { path: '/' } })).not.toContain('Administrator');
  });
});
```

- [ ] **Step 4: Интеграционный тест чата (падает).** `apps/api/test/assistant-chat.int.test.ts` — по образцу `param-options.int.test.ts` (поддельный Carbone, `createSourceDatabase`, `createTemplate` из helpers). Сценарии:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CarboneRenderer } from '../src/deps';
import { fakeLlm } from './fake-llm';
import { createSourceDatabase, createTestApp, loginAs, type TestApp } from './helpers';

// Шаблоны и источник создаются так же, как в param-options.int.test.ts: createTpl(dsId, queries, params)
// (скопировать помощник createTpl и подключение источника из того файла: POST /api/datasources с
// данными createSourceDatabase). Источник: `create table company(id int, name text);
// insert into company values (1,'ООО Ромашка'),(2,'АО Лютик');`
// Шаблон A «Счёт» — параметры: company (query, required, sql `select id as value, name as label from company order by id`),
//   paid (boolean). Доступ: открыт пользователю (createTemplate(..., { public: true }) или настройка доступа,
//   как в access.int.test.ts).
// Шаблон B «Зарплаты» — без доступа для пользователя.

let t: TestApp;
let admin: string;
let user: string;
let tplA: string;
let tplB: string;

const chat = (cookie: string, messages = [{ role: 'user', content: 'счёт для Лютика' }]) =>
  t.app.inject({
    method: 'POST',
    url: '/api/assistant/chat',
    headers: { cookie },
    payload: { messages, page: { path: '/reports' } },
  });

async function enable(url: string) {
  await t.app.inject({
    method: 'PUT',
    url: '/api/admin/assistant',
    headers: { cookie: admin },
    payload: { enabled: true, baseUrl: url, model: 'm', apiKey: 'k', extraInstructions: '' },
  });
}

const toolCall = (name: string, args: object) => ({
  content: null,
  tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

describe('POST /api/assistant/chat', () => {
  it('выключен — 404', async () => {
    expect((await chat(user)).statusCode).toBe(404);
  });

  it('полный сценарий: список → форма → значения → карточка с подписями', async () => {
    const seen: string[] = [];
    let step = 0;
    const llm = await fakeLlm((body) => {
      seen.push(JSON.stringify(body.messages.at(-1)));
      const steps = [
        toolCall('list_reports', { search: 'счёт' }),
        toolCall('get_report_form', { reportId: tplA }),
        toolCall('find_param_values', { reportId: tplA, param: 'company', search: 'лютик' }),
        toolCall('propose_run', { reportId: tplA, params: { company: 2, paid: true } }),
      ];
      return { message: steps[step++] ?? { content: 'конец' } };
    });
    await enable(llm.url);
    const r = await chat(user);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().card).toMatchObject({
      reportId: tplA,
      reportName: 'Счёт',
      params: { company: 2, paid: true },
      display: [
        { label: 'company', value: 'АО Лютик' },
        { label: 'paid', value: 'да' },
      ],
    });
    // В модель не ушли SQL и шаблон B.
    const all = seen.join('\n');
    expect(all).not.toContain('select id as value');
    expect(all).not.toContain('Зарплаты');
    await llm.close();
  });

  it('шаблон без доступа: форма и карточка — ошибка, а не данные', async () => {
    let step = 0;
    const toolResults: string[] = [];
    const llm = await fakeLlm((body) => {
      toolResults.push(JSON.stringify(body.messages.at(-1)));
      const steps = [
        toolCall('get_report_form', { reportId: tplB }),
        toolCall('propose_run', { reportId: tplB, params: {} }),
      ];
      return { message: steps[step++] ?? { content: 'нет доступа' } };
    });
    await enable(llm.url);
    const r = await chat(user);
    expect(r.json()).toEqual({ reply: 'нет доступа', card: null });
    expect(toolResults[1]).toContain('error');
    expect(toolResults[2]).toContain('error');
    await llm.close();
  });

  it('неверные параметры и объект в значении — ошибка модели, затем вопрос пользователю', async () => {
    let step = 0;
    const llm = await fakeLlm(() => {
      const steps = [
        toolCall('propose_run', { reportId: tplA, params: { company: 999 } }),
        toolCall('propose_run', { reportId: tplA, params: { company: { x: 1 } } }),
        toolCall('nonexistent_tool', {}),
      ];
      return { message: steps[step++] ?? { content: 'Какая компания?' } };
    });
    await enable(llm.url);
    const r = await chat(user);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ reply: 'Какая компания?', card: null });
    await llm.close();
  });

  it('ошибка провайдера: 502 с кодом и текстом, без ключа в ответе', async () => {
    const llm = await fakeLlm(() => ({ status: 401 }));
    await enable(llm.url);
    const r = await chat(user);
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('ASSISTANT_AUTH');
    expect(r.body).not.toContain('Bearer');
    await llm.close();
  });

  it('модель зациклилась — 422 ASSISTANT_LIMIT', async () => {
    const llm = await fakeLlm(() => ({ message: toolCall('list_reports', {}) }));
    await enable(llm.url);
    const r = await chat(user);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('ASSISTANT_LIMIT');
    await llm.close();
  });

  it('без входа — 401', async () => {
    expect((await chat('')).statusCode).toBe(401);
  });
});
```

Исполнитель дописывает `beforeAll` (создание приложения с поддельным Carbone, входы admin/user, источник, шаблоны A и B с доступом A для user) по образцу `param-options.int.test.ts` и `access.int.test.ts`; тесты в `describe` выполняются по порядку, состояние настроек между ними переписывается `enable`.

Run: `pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/assistant-chat.int.test.ts` → FAIL (404 на всех).

- [ ] **Step 5: Маршрут чата.** Дописать в `routes.ts`:

```ts
import { AssistantChatBody, type AssistantChatReply } from '@carbone-reports/shared';
import { currentUser } from '../auth/guards';
import { notFound } from '../../lib/errors';
import { AgentLimitError, runAgent } from './agent';
import { systemPrompt } from './prompt';
import { createAssistantTools, type Inject } from './tools';

// внутри registerAssistantRoutes:
  // §50.3: 20 запросов в минуту на пользователя; хук после requireUser — пользователь уже известен.
  const chatRateLimit = {
    max: 20,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => `assistant:${currentUser(req).id}`,
  };

  app.post(
    '/api/assistant/chat',
    {
      preHandler: guards.requireUser,
      config: { rateLimit: chatRateLimit },
      schema: { body: AssistantChatBody },
    },
    async (req): Promise<AssistantChatReply> => {
      const s = await loadAssistantSettings(deps.db, key);
      if (!s.enabled) throw notFound('assistant');
      // Инструменты вызывают эндпоинты от имени этого же пользователя и на его языке.
      const inject: Inject = async (method, url, payload) => {
        const r = await app.inject({
          method,
          url,
          payload: payload as object | undefined,
          headers: { cookie: req.headers.cookie ?? '', 'x-locale': req.locale },
        });
        let body: unknown = null;
        try {
          body = r.json();
        } catch {
          body = null;
        }
        return { status: r.statusCode, body };
      };
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: deps.config.tz }).format(new Date());
      try {
        return await runAgent({
          llm: createLlmClient({ baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey }),
          tools: createAssistantTools({ inject, deps, locale: req.locale }),
          system: systemPrompt({ locale: req.locale, today, extra: s.extraInstructions, page: req.body.page }),
          history: req.body.messages,
        });
      } catch (e) {
        if (e instanceof LlmError) throw llmAppError(e);
        if (e instanceof AgentLimitError)
          throw new AppError('ASSISTANT_LIMIT', 422, { key: 'assistant.limit' }, undefined, e.message);
        throw e;
      }
    },
  );
```

(`FastifyRequest` — `import type { FastifyRequest } from 'fastify';`.) Проверить, что `registerErrorHandler` пишет `internal` в журнал (`grep -n "internal" apps/api/src/lib/errors.ts`); если нет — перед `throw` добавить `req.log.warn({ code: e.code, detail: e.detail }, 'ошибка модели')`.

Run: интеграционный тест → PASS. Затем по одному: `test/assistant-settings.int.test.ts`, `test/param-options.int.test.ts`, `test/rate-limit-redis.int.test.ts` → PASS; `pnpm --filter @carbone-reports/api test` и `typecheck` → PASS.

- [ ] **Step 6: Commit** — `feat(assistant): цикл ассистента и POST /api/assistant/chat (§50.3)`.

---

### Task 5: Веб — страница администрирования «Ассистент»

**Files:**
- Modify: `apps/web/src/api/endpoints.ts` (`api.assistant`)
- Create: `apps/web/src/pages/admin/AssistantPage.tsx`, `apps/web/src/pages/admin/AssistantPage.test.tsx`
- Modify: `apps/web/src/app/routes.tsx` (маршрут `admin/assistant` в группе `isAdmin`), `apps/web/src/app/Layout.tsx` (пункт меню `assistant` для `isAdmin`, иконка `Sparkles` из `@gravity-ui/icons`; если её нет в пакете — `Comment`)
- Modify: `packages/shared/src/i18n/<lang>/common.json` (`nav.assistant`), `admin.json` (группа `assistant`) — 7 языков

**Interfaces:**
- Consumes: `AssistantSettingsDto`, `AssistantSettingsBody`, `AssistantTestBody`, `AssistantTestResult`, `AssistantChatBody`, `AssistantChatReply` (Task 1).
- Produces (`endpoints.ts`):
  ```ts
  assistant: {
    settings: () => apiJson<AssistantSettingsDto>('/api/admin/assistant'),
    save: (body: AssistantSettingsBody) => apiJson<void>('/api/admin/assistant', put(body)),
    test: (body: AssistantTestBody) => apiJson<AssistantTestResult>('/api/admin/assistant/test', post(body)),
    chat: (body: AssistantChatBody, signal?: AbortSignal) =>
      apiJson<AssistantChatReply>('/api/assistant/chat', { ...post(body), signal }),
  },
  ```

- [ ] **Step 1: Тексты.** `common.json` → `nav.assistant`: ru «Ассистент», en «Assistant». `admin.json` → группа `assistant` (ru / en; остальные пять языков — перевод с en):

| Ключ | ru | en |
|---|---|---|
| `title` | ИИ-ассистент | AI assistant |
| `enabled` | Ассистент включён | Assistant enabled |
| `baseUrl` | Адрес API | API URL |
| `baseUrlHint` | OpenAI-совместимый API, например https://api.openai.com/v1 или http://ollama:11434/v1 | OpenAI-compatible API, for example https://api.openai.com/v1 or http://ollama:11434/v1 |
| `model` | Модель | Model |
| `apiKey` | Ключ API | API key |
| `apiKeySet` | Ключ задан | Key is set |
| `apiKeyReplace` | Заменить | Replace |
| `apiKeyRemove` | Удалить ключ | Remove key |
| `apiKeyHint` | Для локальных моделей ключ можно не указывать | Local models may not need a key |
| `extra` | Дополнительные инструкции | Additional instructions |
| `extraHint` | Добавляются к инструкциям ассистента, например: «Отчёты по продажам — в категории Коммерция» | Appended to the assistant instructions, for example: “Sales reports are in the Commerce category” |
| `privacy` | Названия и описания отчётов, параметры и значения списков передаются провайдеру модели. Содержимое отчётов и результаты запросов не передаются. | Report names and descriptions, parameters and list values are sent to the model provider. Report contents and query results are not sent. |
| `test` | Проверить подключение | Test connection |
| `testOk` | Модель отвечает, вызов инструментов поддерживается | The model responds and supports tool calling |
| `save` | Сохранить | Save |
| `saved` | Настройки сохранены | Settings saved |

- [ ] **Step 2: Тест страницы (падает).** `AssistantPage.test.tsx` по образцу `DatasourcesPage.test.tsx` (`mockApi`, `adminMe`, `renderRoute`):

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const saved = { enabled: true, baseUrl: 'http://llm/v1', model: 'm1', hasApiKey: true, extraInstructions: '' };

describe('AssistantPage', () => {
  it('ключ задан: сохранение без поля apiKey; проверка без ключа', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/admin/assistant', body: saved },
      { method: 'POST', path: '/api/admin/assistant/test', body: { ok: true } },
      { method: 'PUT', path: '/api/admin/assistant', status: 204 },
    ]);
    renderRoute('/admin/assistant');
    expect(await screen.findByText('Ключ задан')).toBeInTheDocument();
    expect(screen.getByText(/передаются провайдеру модели/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Проверить подключение' }));
    expect(await screen.findByText('Модель отвечает, вызов инструментов поддерживается')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/admin/assistant/test')?.body).toEqual({
      baseUrl: 'http://llm/v1',
      model: 'm1',
    });
    const model = screen.getByLabelText('Модель');
    await userEvent.clear(model);
    await userEvent.type(model, 'm2');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        enabled: true,
        baseUrl: 'http://llm/v1',
        model: 'm2',
        extraInstructions: '',
      }),
    );
  });

  it('замена ключа уходит в apiKey; ошибка проверки показывается текстом', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/admin/assistant', body: saved },
      {
        method: 'POST',
        path: '/api/admin/assistant/test',
        body: { ok: false, code: 'auth', message: 'Провайдер модели отклонил ключ. Обратитесь к администратору' },
      },
    ]);
    renderRoute('/admin/assistant');
    await userEvent.click(await screen.findByRole('button', { name: 'Заменить' }));
    await userEvent.type(screen.getByLabelText('Ключ API'), 'sk-new');
    await userEvent.click(screen.getByRole('button', { name: 'Проверить подключение' }));
    expect(await screen.findByText(/отклонил ключ/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/admin/assistant/test')?.body).toMatchObject({ apiKey: 'sk-new' });
  });

  it('ошибка сохранения по полю показывается у поля', async () => {
    mockApi([
      adminMe,
      { path: '/api/admin/assistant', body: { ...saved, enabled: false, baseUrl: '', model: '' } },
      {
        method: 'PUT',
        path: '/api/admin/assistant',
        status: 400,
        body: { error: { code: 'VALIDATION', message: 'Ошибка', details: { model: 'укажите модель' } } },
      },
    ]);
    renderRoute('/admin/assistant');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Ассистент включён' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('укажите модель')).toBeInTheDocument();
  });
});
```

Формат `details` ошибки VALIDATION сверить с `apps/web/src/api/errors.ts` (`fieldErrors`) и при необходимости поправить мок под фактический формат.

Run: `pnpm --filter @carbone-reports/web exec vitest run src/pages/admin/AssistantPage.test.tsx` → FAIL.

- [ ] **Step 3: Страница.** `AssistantPage.tsx` — по образцу `DatasourceDialog.tsx` (поле пароля «задан / Заменить»), но страницей, а не диалогом: `PageHeader` с `t('admin:assistant.title')`; форма `cr-form` с `Switch` (`enabled`), `TextInput` (`baseUrl`, `model`, `apiKey` — `type="password"`, `autoComplete="off"`), `TextArea` (`extraInstructions`, `maxLength={2000}`); `Alert theme="info"` с `privacy`; кнопки «Проверить подключение» (`api.assistant.test`; тело — `{baseUrl, model}` плюс `apiKey`, только если пользователь нажал «Заменить» или «Удалить ключ»: ввёл значение — строка, удалил — `null`) и «Сохранить» (`api.assistant.save`; то же правило для `apiKey`). Результат проверки: `ok` → `Alert theme="success"` с `testOk`; иначе `Alert theme="danger"` с `message`. Ошибки сохранения по полям — `fieldErrors(error)` у соответствующих полей, общая — `ErrorAlert`. После сохранения — `toaster.add({ theme: 'success', title: t('admin:assistant.saved') })`, перезапрос `['admin-assistant']` и `meKey` (меню и кнопка ассистента зависят от `features.assistant`). Все подписи — через `t('admin:assistant.…')`; у каждого поля `label`, чтобы `getByLabelText` находил его.

Маршрут: в `routes.tsx` в группу `RequireRole allow={(p) => p.isAdmin}` — `{ path: 'assistant', element: <AssistantPage /> }`. Меню: в `Layout.tsx` в блок `isAdmin` после `users` — `item('assistant', t('common:nav.assistant'), Sparkles, '/admin/assistant')`.

Run: тест страницы → PASS; `pnpm --filter @carbone-reports/web test` → PASS (тесты Layout, сверяющие список пунктов меню, обновить: новый пункт у администратора); `pnpm i18n:check`; `pnpm -r typecheck`; `pnpm lint` (кроме известного шума `cades/`).

- [ ] **Step 4: Commit** — `feat(assistant): страница администрирования «Ассистент» (§50.2)`.

---

### Task 6: Веб — панель ассистента, карточка запуска, подстановка параметров

**Files:**
- Create: `apps/web/src/features/assistant/storage.ts`, `useAssistantChat.ts`, `AssistantPanel.tsx`, `RunCardView.tsx`, `assistant.css`, `AssistantPanel.test.tsx`
- Modify: `apps/web/src/app/Layout.tsx` (пункт подвала, панель рядом с `<main>`, очистка при выходе)
- Modify: `apps/web/src/pages/ReportRunPage.tsx` (параметры из `location.state.assistantParams`), `apps/web/src/pages/ReportRunPage.test.tsx`
- Modify: `packages/shared/src/i18n/<lang>/common.json` (группа `assistant`) — 7 языков

**Interfaces:**
- Consumes: `api.assistant.chat`, `api.reports.render`, `useRunDownload`, `meKey`, `useMe` (существующие и Task 5); `RunCard`, `ChatTurn`, `AssistantChatReply` (Task 1).
- Produces:
  ```ts
  // storage.ts
  export const ASSISTANT_KEY = 'cr-assistant';
  export interface PanelMessage { role: 'user' | 'assistant'; content: string; card?: RunCard }
  export interface AssistantState { open: boolean; messages: PanelMessage[] }
  export function loadAssistant(): AssistantState
  export function saveAssistant(s: AssistantState): void
  export function clearAssistant(): void
  /** История для API: карточка — текстом, последние 20 реплик. */
  export function toHistory(messages: PanelMessage[], cardText: (c: RunCard) => string): ChatTurn[]
  // ReportRunPage: location.state = { assistantParams?: ParamsInput }
  ```

- [ ] **Step 1: Тексты.** `common.json` → группа `assistant` (ru / en; остальные — перевод):

| Ключ | ru | en |
|---|---|---|
| `open` | Ассистент | Assistant |
| `title` | Ассистент | Assistant |
| `close` | Закрыть | Close |
| `newChat` | Новый диалог | New chat |
| `empty` | Опишите, какой отчёт нужен, — например, «счёт для Ромашки за сентябрь» | Describe the report you need, for example “invoice for Romashka for September” |
| `suggestThis` | Сформируй этот отчёт | Generate this report |
| `suggestList` | Какие отчёты мне доступны? | Which reports can I use? |
| `placeholder` | Сообщение ассистенту | Message to the assistant |
| `send` | Отправить | Send |
| `stop` | Остановить | Stop |
| `thinking` | Ассистент думает… | The assistant is thinking… |
| `generate` | Сформировать | Generate |
| `openForm` | Открыть форму | Open form |
| `ready` | Отчёт сформирован | Report generated |
| `history` | История | History |
| `cardText` | Предложен запуск «{{name}}»: {{params}} | Proposed run of “{{name}}”: {{params}} |

- [ ] **Step 2: Тест (падает).** `AssistantPanel.test.tsx` — `renderRoute('/reports')` с `mockApi`; `me` с `features: { backups: false, assistant: true }`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi, renderRoute } from '../../test/utils';

const me = (assistant: boolean) => ({
  path: '/api/auth/me',
  body: { id: 'u', login: 'ivanov', role: 'user', features: { backups: false, assistant }, locale: 'ru' },
});
const card = {
  reportId: 't1',
  reportName: 'Счёт',
  params: { company: 2 },
  display: [{ label: 'Компания', value: 'АО Лютик' }],
  outputFormats: ['pdf', 'docx'],
  defaultOutput: 'pdf',
};

beforeEach(() => sessionStorage.clear());

describe('панель ассистента', () => {
  it('выключен — кнопки нет', async () => {
    mockApi([me(false), { path: '/api/templates', body: [] }]);
    renderRoute('/reports');
    await screen.findByText('ivanov');
    expect(screen.queryByText('Ассистент')).toBeNull();
  });

  it('диалог: отправка, история в запросе, ответ текстом, карточка → формирование', async () => {
    const { calls } = mockApi([
      me(true),
      { path: '/api/templates', body: [] },
      { method: 'POST', path: '/api/assistant/chat', body: { reply: 'Вот запуск', card } },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'run1' } },
    ]);
    renderRoute('/reports');
    await userEvent.click(await screen.findByText('Ассистент'));
    const panel = await screen.findByRole('complementary', { name: 'Ассистент' });
    await userEvent.type(within(panel).getByLabelText('Сообщение ассистенту'), 'счёт для Лютика{Enter}');
    expect(await within(panel).findByText('Вот запуск')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/assistant/chat')?.body).toEqual({
      messages: [{ role: 'user', content: 'счёт для Лютика' }],
      page: { path: '/reports' },
    });
    expect(within(panel).getByText('АО Лютик')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Сформировать' }));
    expect(await within(panel).findByText('Отчёт сформирован')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/reports/t1/render')?.body).toEqual({ params: { company: 2 } });
    expect(within(panel).getByRole('button', { name: 'PDF' })).toBeInTheDocument();
  });

  it('карточка уходит в следующий запрос текстом; «Новый диалог» очищает', async () => {
    const { calls } = mockApi([
      me(true),
      { path: '/api/templates', body: [] },
      { method: 'POST', path: '/api/assistant/chat', body: { reply: 'Вот запуск', card } },
    ]);
    renderRoute('/reports');
    await userEvent.click(await screen.findByText('Ассистент'));
    const panel = await screen.findByRole('complementary', { name: 'Ассистент' });
    const input = within(panel).getByLabelText('Сообщение ассистенту');
    await userEvent.type(input, 'счёт{Enter}');
    await within(panel).findByText('Вот запуск');
    await userEvent.type(input, 'ещё{Enter}');
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/assistant/chat')).toHaveLength(2));
    const second = calls.filter((c) => c.path === '/api/assistant/chat')[1]!.body as { messages: { content: string }[] };
    expect(second.messages[1]!.content).toBe('Вот запуск\nПредложен запуск «Счёт»: Компания: АО Лютик');
    await userEvent.click(within(panel).getByRole('button', { name: 'Новый диалог' }));
    expect(within(panel).queryByText('Вот запуск')).toBeNull();
  });

  it('ошибка ответа — сообщение об ошибке, ввод снова доступен', async () => {
    mockApi([
      me(true),
      { path: '/api/templates', body: [] },
      {
        method: 'POST',
        path: '/api/assistant/chat',
        status: 502,
        body: { error: { code: 'ASSISTANT_UNAVAILABLE', message: 'Сервис модели не отвечает, попробуйте позже' } },
      },
    ]);
    renderRoute('/reports');
    await userEvent.click(await screen.findByText('Ассистент'));
    const panel = await screen.findByRole('complementary', { name: 'Ассистент' });
    await userEvent.type(within(panel).getByLabelText('Сообщение ассистенту'), 'x{Enter}');
    expect(await within(panel).findByText('Сервис модели не отвечает, попробуйте позже')).toBeInTheDocument();
    expect(within(panel).getByLabelText('Сообщение ассистенту')).toBeEnabled();
  });

  it('404 (ассистент выключен админом) — панель закрывается', async () => {
    mockApi([
      me(true),
      { path: '/api/templates', body: [] },
      { method: 'POST', path: '/api/assistant/chat', status: 404, body: { error: { code: 'NOT_FOUND', message: 'ассистент выключен' } } },
    ]);
    renderRoute('/reports');
    await userEvent.click(await screen.findByText('Ассистент'));
    const panel = await screen.findByRole('complementary', { name: 'Ассистент' });
    await userEvent.type(within(panel).getByLabelText('Сообщение ассистенту'), 'x{Enter}');
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Ассистент' })).toBeNull());
  });
});
```

Сверить с `mockApi`, как задаётся ответ без тела (204) и повтор одного маршрута; если `mockApi` отдаёт один ответ на маршрут многократно — тесты выше на это рассчитаны.

В `ReportRunPage.test.tsx` дописать: рендер `/reports/t1` с `state: { assistantParams: { company: 2, unknown: 1 } }` (посмотреть в `test/utils.tsx`, как `renderRoute` передаёт state; если не умеет — добавить в `renderRoute` необязательный аргумент `state`, передаваемый в `createMemoryRouter(routes, { initialEntries: [{ pathname: path, state }] })`), ожидание: форма показывает выбранное значение `company`, а запрос `render` уходит с `{ company: 2, … }` без `unknown`.

Run: `pnpm --filter @carbone-reports/web exec vitest run src/features/assistant src/pages/ReportRunPage.test.tsx` → FAIL.

- [ ] **Step 3: Реализация.**

`storage.ts`:

```ts
// Диалог ассистента живёт во вкладке (§50.1): sessionStorage, очищается при выходе.
import type { ChatTurn, RunCard } from '@carbone-reports/shared';

export const ASSISTANT_KEY = 'cr-assistant';
const MAX_TURNS = 20;
const MAX_LEN = 4000;

export interface PanelMessage {
  role: 'user' | 'assistant';
  content: string;
  card?: RunCard;
}
export interface AssistantState {
  open: boolean;
  messages: PanelMessage[];
}

const EMPTY: AssistantState = { open: false, messages: [] };

export function loadAssistant(): AssistantState {
  try {
    const raw = sessionStorage.getItem(ASSISTANT_KEY);
    const s = raw ? (JSON.parse(raw) as AssistantState) : null;
    return s && Array.isArray(s.messages) ? { open: !!s.open, messages: s.messages } : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function saveAssistant(s: AssistantState): void {
  try {
    sessionStorage.setItem(ASSISTANT_KEY, JSON.stringify(s));
  } catch {
    // sessionStorage недоступен — диалог живёт до перезагрузки
  }
}

export function clearAssistant(): void {
  try {
    sessionStorage.removeItem(ASSISTANT_KEY);
  } catch {
    // sessionStorage недоступен
  }
}

/** История для API: карточка — текстом после реплики; пустые реплики пропускаются; последние 20. */
export function toHistory(messages: PanelMessage[], cardText: (c: RunCard) => string): ChatTurn[] {
  return messages
    .map((m) => ({
      role: m.role,
      content: [m.content, m.card ? cardText(m.card) : ''].filter(Boolean).join('\n').slice(0, MAX_LEN),
    }))
    .filter((m) => m.content.trim() !== '')
    .slice(-MAX_TURNS);
}
```

`useAssistantChat.ts` — хук состояния: `state` из `loadAssistant()`, каждое изменение — `saveAssistant`; `send(text)` добавляет реплику пользователя, вызывает `api.assistant.chat({ messages: toHistory(...), page: { path: pathname, ...(reportId ? { reportId } : {}) } }, controller.signal)`, где `reportId` — из пути `/reports/:id` (`matchPath('/reports/:id', pathname)`); ответ → реплика ассистента с `card`; ошибка `ApiRequestError` со `status === 404` → закрыть панель, `queryClient.invalidateQueries({ queryKey: meKey })`; иная ошибка → `error` (текст `e.message`), реплика пользователя остаётся; `AbortError` — молча. `stop()` — `controller.abort()`. `reset()` — пустой список сообщений. `cardText` — `t('common:assistant.cardText', { name: c.reportName, params: c.display.map((d) => `${d.label}: ${d.value}`).join(', ') })`.

`AssistantPanel.tsx` — `<aside className="cr-assistant" aria-label={t('common:assistant.title')}>`: шапка (заголовок, кнопки «Новый диалог» и «Закрыть»), лента сообщений (`<div className="cr-assistant__msg cr-assistant__msg_{role}">` с `white-space: pre-wrap`; под репликой ассистента с `card` — `<RunCardView card={…} />`), при пустой ленте — текст `empty` и кнопки-подсказки (`suggestThis` на странице `/reports/:id`, всегда `suggestList`; клик отправляет текст подсказки), индикатор `thinking` при ожидании, `Alert theme="danger"` с ошибкой, `TextArea` с `aria-label={t('common:assistant.placeholder')}` (Enter без Shift — отправка, `disabled` во время ожидания) и кнопки «Отправить» / «Остановить».

`RunCardView.tsx` — название, список `display` (`<dl>`), кнопки «Сформировать» (`useMutation(() => api.reports.render(card.reportId, { params: card.params }))`, после успеха — текст `ready`, кнопки форматов `card.outputFormats` через `useRunDownload().save({ runId, format })` — как на `ReportRunPage`, ссылка `history` на `/history`; ошибка — `ErrorAlert`) и «Открыть форму» (`navigate(`/reports/${card.reportId}`, { state: { assistantParams: card.params } })`).

`assistant.css`: `.cr-assistant { position: fixed; top: 0; right: 0; bottom: 0; width: 420px; max-width: 100vw; display: flex; flex-direction: column; background: var(--g-color-base-background); border-left: 1px solid var(--g-color-line-generic); z-index: 100; }` и `@media (max-width: 720px) { .cr-assistant { width: 100vw; } }`; лента — `flex: 1; overflow-y: auto`. Импорт css — в `AssistantPanel.tsx`.

`Layout.tsx`: `const assistant = useAssistantChat();`; в подвале перед `about`, когда `me?.features?.assistant`: `<FooterItem id="assistant" title={t('common:assistant.open')} icon={Sparkles} compact={isCompact} onItemClick={() => assistant.setOpen(!assistant.open)} />`; в `renderContent` после `<main>` — `{me?.features?.assistant && assistant.open && <AssistantPanel chat={assistant} />}`; в `purgeUserStorage` — `clearAssistant()`.

`ReportRunPage.tsx`: `const { state } = useLocation();` и в эффекте построения формы:

```tsx
    // Параметры из карточки ассистента (§50.5) — вместо значений по умолчанию, только объявленные.
    const fromAssistant = (state as { assistantParams?: ParamsInput } | null)?.assistantParams ?? {};
    const declared = Object.fromEntries(
      t.params.filter((p) => Object.hasOwn(fromAssistant, p.name)).map((p) => [p.name, fromAssistant[p.name]!]),
    );
    setValues({ ...initialValues(t.params), ...declared });
```

Run: тесты Step 2 → PASS; `pnpm --filter @carbone-reports/web test` → PASS; `pnpm i18n:check`; `pnpm -r typecheck`; `pnpm lint`.

- [ ] **Step 4: Commit** — `feat(assistant): панель ассистента и карточка запуска (§50.5)`.

---

### Task 7: E2E, документация, локальный стек

**Files:**
- Create: `e2e/tests/assistant.spec.ts`
- Modify: `README.md`, `README.en.md`, `CHANGELOG.md`

- [ ] **Step 1: E2E.** `e2e/tests/assistant.spec.ts`:

```ts
import { adminApi, expect, loginAdminUi, test, waitForStack } from '../fixtures';

test.beforeAll(waitForStack);

const OFF = { enabled: false, baseUrl: '', model: '', extraInstructions: '', apiKey: null };

test.afterAll(async () => {
  // Стек общий с другими сценариями и с демо: ассистент остаётся выключенным.
  const api = await adminApi();
  await api.put('/api/admin/assistant', OFF);
});

test('админ: настройки ассистента, проверка недоступного адреса, кнопка в меню', async ({ page }) => {
  await loginAdminUi(page);
  await page.goto('/admin/assistant');
  await page.getByLabel('Адрес API').fill('http://127.0.0.1:9/v1');
  await page.getByLabel('Модель').fill('test-model');
  await page.getByRole('button', { name: 'Проверить подключение' }).click();
  await expect(page.getByText('Сервис модели не отвечает, попробуйте позже')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Ассистент включён' }).check();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Настройки сохранены')).toBeVisible();
  await page.goto('/reports');
  await page.getByText('Ассистент', { exact: true }).first().click();
  await expect(page.getByRole('complementary', { name: 'Ассистент' })).toBeVisible();
});
```

Сверить `ApiClient` в `e2e/fixtures.ts` (есть ли `put`; если нет — добавить по образцу существующих методов). Запуск — только против стека, собранного из ветки (Step 4): `pnpm e2e -- tests/assistant.spec.ts`.

- [ ] **Step 2: README.** В `README.md` новый раздел перед «Демо и E2E» (уровень заголовка — как у соседних разделов):

```markdown
## ИИ-ассистент (экспериментально)

Только в ветке `feat/ai-assistant`, в выпуски не входит.

Ассистент в веб-интерфейсе находит отчёт по описанию словами, подбирает параметры и предлагает запуск — сформировать отчёт пользователь подтверждает кнопкой. Ассистент действует с правами пользователя и видит только доступные ему отчёты.

Включается администратором: «Администрирование → Ассистент». Модель подключается по OpenAI-совместимому API: адрес (например, `https://api.openai.com/v1` или `http://ollama:11434/v1` для локальной Ollama), модель с поддержкой вызова инструментов (tool calling) и ключ API (для локальных моделей может не требоваться). Ключ хранится зашифрованным `ENCRYPTION_KEY`.

Провайдеру модели передаются названия и описания отчётов, параметры и значения списков. Содержимое отчётов, SQL и результаты запросов не передаются. Переписка хранится только во вкладке браузера.
```

`README.en.md` — тот же раздел по-английски (`## AI assistant (experimental)`), в том же месте; `pnpm docs:check` → без ошибок.

- [ ] **Step 3: CHANGELOG.** Над первым `## [X.Y.Z]`:

```markdown
## [Unreleased] — ИИ-ассистент

Только в ветке `feat/ai-assistant` (§50).

### Добавлено
- ИИ-ассистент в веб-интерфейсе: подбор отчёта и параметров по описанию, карточка запуска.
- «Администрирование → Ассистент»: подключение к модели по OpenAI-совместимому API, проверка подключения.
```

Run: `pnpm site:check` (версия берётся из первого `## [X.Y.Z]` — раздел `[Unreleased]` не мешает), `pnpm test:scripts`, `pnpm docs:check` → без ошибок.

- [ ] **Step 4: Локальный стек из ветки и e2e.** По одному образу с очисткой кэша между сборками:

```bash
docker compose build api && docker builder prune -f
docker compose build web && docker builder prune -f
docker compose up -d --wait
```

(образ `backup` не меняется — не пересобирать). Затем `pnpm e2e -- tests/assistant.spec.ts` → PASS, и полный `pnpm e2e` → PASS. Проверить `https://localhost:8443` → 200, после e2e ассистент выключен.

- [ ] **Step 5: Commit** — `docs(assistant): README, CHANGELOG, e2e ассистента (§50.8)`; затем `git push origin feat/ai-assistant`.
