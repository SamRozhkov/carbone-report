# ИИ-ассистент, этап 2 (помощь авторам шаблонов) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** в редакторе шаблона ассистент пишет и проверяет SQL по схеме источника, предлагает параметры и теги Carbone; автор применяет предложения кнопками в несохранённые черновики вкладок.

**Architecture:** новые эндпоинты схемы и проверки SQL (`apps/api/src/modules/schema/`) с правом правки шаблона; авторские инструменты ассистента ходят в них через `app.inject` (как этап 1) и включаются, только если пользователь может править шаблон из `page.templateId`. Ответ чата несёт `cards[]` разных типов. В вебе React-контекст «мост» в `Layout` связывает панель с открытым редактором: черновики уходят в `page.editor`, кнопки карточек применяют изменения во вкладки «Данные»/«Параметры».

**Tech Stack:** Fastify 5 + zod + pg (API), React 19 + Gravity UI + TanStack Query (веб), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §51 (и §50 — этап 1).

## Global Constraints

- Ветка `feat/ai-assistant`; в main не сливается, тегов и выпусков нет.
- Новых npm-зависимостей нет.
- Граница данных (§51.1): в модель в авторском режиме уходят SQL черновиков шаблона и схема источника (таблицы, представления, колонки, типы, ключи, комментарии). Никогда — строки данных, результаты запросов, значения по умолчанию колонок, тексты ошибок эндпоинтов вне списка безопасных кодов (§50, `errorOf`).
- Эндпоинты схемы и проверки — только с правом правки шаблона (`guards.requireTemplateEdit`), только системный каталог PostgreSQL, в read-only транзакции (`withReadOnly`) с таймаутом `deps.config.queryTimeoutMs`.
- Лимиты: таблиц в списке ≤ 100; колонок ≤ 300; SQL в проверке ≤ 20 000 символов; `page.editor` — ≤ 30 запросов по ≤ 20 000 символов и ≤ 50 параметров; текст фрагмента документа ≤ 2000 символов; ≤ 5 карточек за ответ; авторский режим — 12 вызовов инструментов, срок 120 с.
- Ассистент только предлагает: никаких записей в шаблон с сервера; применение — в черновики вкладок, сохранение — обычными кнопками.
- Все тексты интерфейса и ошибок — во всех семи каталогах `packages/shared/src/i18n/{ru,en,es,pt-BR,fr,de,zh-CN}`; `pnpm i18n:check`; кириллицы в коде веба и в аргументах `AppError` нет.
- Комментарии — по-русски, в стиле окружающего кода.
- Коммиты заканчиваются абзацем `Co-Authored-By: <модель> <noreply@anthropic.com>` и `Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB`.
- Node: `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH`. Интеграционные тесты API — по одному файлу (`pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/<file>`); `render-onlyoffice.int.test.ts` не запускать; два набора тестов одновременно не запускать. Docker-сборки и e2e делает контроллер.
- Ошибки lint в `cades/cadesplugin_api.js` — локальный шум.

## Review Focus

1. Автор без права правки шаблона присылает `page.templateId` и `page.editor` (или модель вызывает авторский инструмент): авторских инструментов нет, `editor` не попадает в промпт, эндпоинты схемы отвечают 403 (тесты в Task 2 и Task 3).
2. SQL с `;` в конце, с комментарием `-- …` в последней строке или с `:параметром` проверяется корректно, а не падает из-за обёртки `select * from (…) q limit 0` (тест в Task 2).
3. Таблица, на которую у пользователя источника нет `SELECT`, не видна ни в списке, ни в описании, даже по точному имени (тест в Task 2).
4. Модель предлагает запрос с ключом `params` или с запрещённым словом (`INSERT`) и параметр, не проходящий схему: карточки не создаются, модель получает ошибку (тест в Task 3).
5. Автор применяет «Заменить запрос «items»», а в черновике ключа `items` уже нет (переименовал): запрос добавляется, а не теряется (тест в Task 4).

---

### Task 1: Ответ с несколькими карточками (`cards[]`)

**Files:**
- Modify: `packages/shared/src/assistant.ts` (типы `Card`, `AssistantChatReply`, расширение `page`), `packages/shared/src/assistant.test.ts`
- Modify: `apps/api/src/modules/assistant/agent.ts`, `agent.test.ts`, `tools.ts` (тип `ToolOutcome`), `apps/api/test/assistant-chat.int.test.ts` (ожидания `cards`)
- Modify: `apps/web/src/features/assistant/storage.ts`, `useAssistantChat.ts`, `AssistantPanel.tsx`, `AssistantPanel.test.tsx`

**Interfaces:**
- Produces (shared):
  ```ts
  export interface QueryCheckColumn { name: string; type: string }
  export type QueryCheck = { ok: true; columns: QueryCheckColumn[] } | { ok: false; error: string };
  export type Card =
    | ({ type: 'run' } & RunCard)
    | { type: 'query'; templateId: string; key: string; mode: QueryMode; sql: string; check: QueryCheck }
    | { type: 'param'; templateId: string; param: TemplateParam }
    | { type: 'tags'; templateId: string; text: string; explanation: string };
  export interface AssistantChatReply { reply: string; cards: Card[] }
  export const EditorDraft; export type EditorDraft; // { queries: {key, mode, sql}[] ≤30, params: TemplateParam[] ≤50 }
  // AssistantChatBody.page: { path, reportId?, templateId?, editor?: EditorDraft }
  export const MAX_CARDS = 5;
  ```
- Produces (API): `ToolOutcome = { result: unknown } | { card: Card }`; `runAgent` собирает карточки, не завершая ответ.

- [ ] **Step 1: Типы и тест (падает).** В `packages/shared/src/assistant.ts`:

```ts
import type { OutputFormat, ParamValue, QueryMode, TemplateParam as TemplateParamT } from './index';
import { QueryMode as QueryModeSchema, TemplateParam as TemplateParamSchema } from './index';
```

Если значение-импорт из `./index` даёт цикл при загрузке (index реэкспортирует assistant.ts), вынести `EditorDraft` в `packages/shared/src/index.ts` рядом с `TemplateParam` (после его объявления) и реэкспортировать оттуда; типы карточек оставить в assistant.ts с `import type`. Проверка: `pnpm --filter @carbone-reports/shared exec vitest run` — без ошибок импорта.

```ts
export const MAX_CARDS = 5;

export const EditorDraft = z.object({
  queries: z
    .array(z.object({ key: z.string().max(100), mode: QueryModeSchema, sql: z.string().max(20_000) }))
    .max(30),
  params: z.array(TemplateParamSchema).max(50),
});
export type EditorDraft = z.infer<typeof EditorDraft>;

export const AssistantChatBody = z.object({
  messages: z.array(ChatTurn).min(1).max(20),
  page: z.object({
    path: z.string().max(500),
    reportId: z.string().max(100).optional(),
    templateId: z.string().max(100).optional(),
    editor: EditorDraft.optional(),
  }),
});

export interface QueryCheckColumn { name: string; type: string }
export type QueryCheck = { ok: true; columns: QueryCheckColumn[] } | { ok: false; error: string };

export type Card =
  | ({ type: 'run' } & RunCard)
  | { type: 'query'; templateId: string; key: string; mode: QueryMode; sql: string; check: QueryCheck }
  | { type: 'param'; templateId: string; param: TemplateParamT }
  | { type: 'tags'; templateId: string; text: string; explanation: string };

export interface AssistantChatReply {
  reply: string;
  cards: Card[];
}
```

Тест в `assistant.test.ts`: `page.editor` с 31 запросом или SQL длиннее 20 000 — не проходит; с неверным параметром (`{name: '1x', …}`) — не проходит; пустой `editor: {queries: [], params: []}` — проходит.

- [ ] **Step 2: Цикл с несколькими карточками (тест падает).** В `agent.test.ts` заменить ожидания `card` на `cards` и добавить:

```ts
it('propose_* не завершают ответ: карточки копятся, ответ — текстом', async () => {
  const llm = script(
    { content: null, toolCalls: [
      { id: 'a', type: 'function', function: { name: 'propose_run', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'propose_run', arguments: '{}' } },
    ] },
    text('Вот два варианта'),
  );
  const r = await runAgent({ llm, tools: tools(), ...base });
  expect(r.reply).toBe('Вот два варианта');
  expect(r.cards).toHaveLength(2);
  expect(llm.mock.calls[1]![0].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'b', content: '{"ok":true}' });
});

it('шестая карточка — ошибка модели', async () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, type: 'function' as const, function: { name: 'propose_run', arguments: '{}' } }));
  const llm = script({ content: null, toolCalls: six }, text('ok'));
  const r = await runAgent({ llm, tools: tools(), ...base });
  expect(r.cards).toHaveLength(5);
  expect(String(llm.mock.calls[1]![0].messages.at(-1)!.content)).toContain('too many cards');
});

it('пустой текст при карточках — допустим', async () => {
  const llm = script(call('propose_run', '{}'), text(''));
  expect((await runAgent({ llm, tools: tools(), ...base })).cards).toHaveLength(1);
});
```

(`tools()` в тесте возвращает `{ card: { type: 'run', …card } }` для `propose_run`.) Run: `pnpm --filter @carbone-reports/api exec vitest run src/modules/assistant/agent.test.ts` → FAIL.

- [ ] **Step 3: Реализация в `agent.ts`.** Внутри цикла: `const cards: Card[] = []`; при `'card' in out` — если `cards.length >= MAX_CARDS` → `content = { error: 'too many cards: at most 5 per answer' }`, иначе `cards.push(out.card); content = { ok: true }`; цикл продолжается. Завершение — ответ модели без `toolCalls`: если `text === '' && cards.length === 0` → `AgentLimitError('пустой ответ')`, иначе `return { reply: text, cards }`. В `tools.ts`: `propose_run` возвращает `{ card: { type: 'run', ...card } }`. Интеграционный `assistant-chat.int.test.ts`: заменить `r.json().card` на `r.json().cards[0]` (с `type: 'run'`) и `card: null` на `cards: []`; сценарий «полный» — модель после `propose_run` отвечает текстом (добавить шаг `{ content: 'Готово' }`).

- [ ] **Step 4: Веб на `cards`.** `storage.ts`: `PanelMessage.cards?: Card[]` вместо `card`; `toHistory(messages, cardText: (c: Card) => string)` — текст всех карточек через `\n`. `useAssistantChat.ts`: `cardText` — для `run` прежний `common:assistant.cardText`; для остальных типов — ключи Task 5 (пока: `query` → `${c.key}`, `param` → `${c.param.name}`, `tags` → `c.text` — Task 5 заменит на переводы); ответ кладёт `cards: reply.cards` (если не пусто). `AssistantPanel.tsx`: под репликой — `m.cards?.filter((c) => c.type === 'run').map(…<RunCardView card={c} />)`. Тесты панели: моки ответа `{ reply, cards: [{ type: 'run', …card }] }`; старые ожидания сохраняются.

- [ ] **Step 5: Проверка и commit.** `pnpm --filter @carbone-reports/shared exec vitest run`, `pnpm --filter @carbone-reports/api exec vitest run src/modules/assistant`, интеграционный `test/assistant-chat.int.test.ts`, `pnpm --filter @carbone-reports/web exec vitest run src/features/assistant`, `pnpm -r typecheck`. Commit: `feat(assistant): несколько карточек за ответ (cards[]) и контекст редактора в запросе (§51.3–51.4)`.

---

### Task 2: Эндпоинты схемы и проверки SQL

**Files:**
- Create: `apps/api/src/modules/schema/introspect.ts`, `apps/api/src/modules/schema/routes.ts`
- Modify: `apps/api/src/modules/queries/executor.ts` (экспорт `checkQuery`, экспорт `withReadOnly` при необходимости)
- Modify: `apps/api/src/app.ts` (регистрация `registerSchemaRoutes`)
- Modify: `packages/shared/src/assistant.ts` (типы ответов схемы, `CheckQueryBody`)
- Create: `apps/api/test/schema.int.test.ts`

**Interfaces:**
- Consumes: `QueryCheck`, `QueryCheckColumn` (Task 1).
- Produces (shared):
  ```ts
  export type RelationKind = 'table' | 'view' | 'matview' | 'foreign';
  export interface SchemaTable { schema: string; name: string; kind: RelationKind; comment: string | null }
  export interface SchemaTableList { total: number; tables: SchemaTable[] }
  export interface SchemaColumn { name: string; type: string; notNull: boolean; comment: string | null }
  export interface SchemaForeignKey { columns: string[]; references: { schema: string; table: string; columns: string[] } }
  export interface SchemaTableDetails extends SchemaTable { columns: SchemaColumn[]; primaryKey: string[]; foreignKeys: SchemaForeignKey[] }
  export const CheckQueryBody; // { sql: string 1..20000 }
  ```
- Produces (API): `GET /api/templates/:id/schema/tables?search=` → `SchemaTableList`; `GET /api/templates/:id/schema/tables/:name` → `SchemaTableDetails` | 404 `notFound('table')`; `POST /api/templates/:id/queries/check` → `QueryCheck`. `export async function checkQuery(pool, sourceName, sql, timeoutMs): Promise<QueryCheck>` в executor.ts.

- [ ] **Step 1: Интеграционный тест (падает).** `apps/api/test/schema.int.test.ts` — по образцу `param-options.int.test.ts` (источник из `createSourceDatabase`, шаблон через `createTemplate`/`POST /api/templates` с `datasourceId`, подключение источника — `POST /api/datasources` с данными `createSourceDatabase`). Сид источника:

```sql
create table company (id int primary key, name text not null);
comment on table company is 'Покупатели';
comment on column company.name is 'Название';
create table invoices (id int primary key, company_id int references company(id), total numeric(12,2));
create view v_totals as select company_id, sum(total) as total from invoices group by company_id;
create schema hidden;
create table hidden.salaries (id int, amount int);
insert into company values (1, 'ООО Ромашка');
create role ds_limited login password 'pw';
grant usage on schema public to ds_limited;
grant select on company, invoices, v_totals to ds_limited;
```

Источник подключается под `ds_limited` (пароль `pw`) — тогда `hidden.salaries` недоступна. Сценарии:

```ts
it('список: доступные отношения, виды, комментарии; без системных и недоступных', async () => {
  const r = await get(`/api/templates/${tpl}/schema/tables`, editor);
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({
    total: 3,
    tables: [
      { schema: 'public', name: 'company', kind: 'table', comment: 'Покупатели' },
      { schema: 'public', name: 'invoices', kind: 'table', comment: null },
      { schema: 'public', name: 'v_totals', kind: 'view', comment: null },
    ],
  });
  expect((await get(`/api/templates/${tpl}/schema/tables?search=ПОКУП`, editor)).json().tables.map((t: { name: string }) => t.name)).toEqual(['company']);
  expect((await get(`/api/templates/${tpl}/schema/tables?search=_`, editor)).json().total).toBe(1); // «_» — буква, а не шаблон LIKE: только v_totals
});

it('описание: колонки, первичный и внешние ключи; недоступная таблица — 404', async () => {
  const inv = (await get(`/api/templates/${tpl}/schema/tables/invoices`, editor)).json();
  expect(inv.columns).toEqual([
    { name: 'id', type: 'integer', notNull: true, comment: null },
    { name: 'company_id', type: 'integer', notNull: false, comment: null },
    { name: 'total', type: 'numeric(12,2)', notNull: false, comment: null },
  ]);
  expect(inv.primaryKey).toEqual(['id']);
  expect(inv.foreignKeys).toEqual([{ columns: ['company_id'], references: { schema: 'public', table: 'company', columns: ['id'] } }]);
  expect((await get(`/api/templates/${tpl}/schema/tables/public.company`, editor)).json().columns[1]).toEqual({ name: 'name', type: 'text', notNull: true, comment: 'Название' });
  expect((await get(`/api/templates/${tpl}/schema/tables/hidden.salaries`, editor)).statusCode).toBe(404);
  expect((await get(`/api/templates/${tpl}/schema/tables/salaries`, editor)).statusCode).toBe(404);
});

it('проверка SQL: колонки и типы без строк; ; в конце, комментарий, :параметр', async () => {
  const ok = await post(`/api/templates/${tpl}/queries/check`, { sql: 'select id, name from company where id = :companyId; -- последняя строка' }, editor);
  expect(ok.json()).toEqual({ ok: true, columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }] });
  expect(ok.body).not.toContain('Ромашка');
  const bad = (await post(`/api/templates/${tpl}/queries/check`, { sql: 'select nope from company' }, editor)).json();
  expect(bad.ok).toBe(false);
  expect(bad.error).toContain('nope');
  const write = (await post(`/api/templates/${tpl}/queries/check`, { sql: 'delete from company' }, editor)).json();
  expect(write.ok).toBe(false);
});

it('права: пользователь без права правки — 403; без входа — 401', async () => {
  expect((await get(`/api/templates/${tpl}/schema/tables`, plainUser)).statusCode).toBe(403);
  expect((await post(`/api/templates/${tpl}/queries/check`, { sql: 'select 1' }, plainUser)).statusCode).toBe(403);
  expect((await get(`/api/templates/${tpl}/schema/tables`, '')).statusCode).toBe(401);
});
```

(`editor` — cookie администратора-автора шаблона; `plainUser` — `loginAs(t, 'user')` с доступом к шаблону на запуск: ему 403, потому что править нельзя. Проверить фактический код ответа `requireTemplateEdit` для роли `user` — 403 `forbidden`.)

Run: `pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/schema.int.test.ts` → FAIL (404 маршрутов).

- [ ] **Step 2: `checkQuery` в executor.ts.**

```ts
/**
 * Проверка SQL автора (§51.2): колонки и типы без строк. Все :параметры — null; запрос
 * оборачивается в select * from (…) q limit 0, ; в конце снимается, перенос строки перед )
 * закрывает комментарий -- в последней строке.
 */
export async function checkQuery(
  pool: pg.Pool,
  sourceName: string,
  sql: string,
  timeoutMs: number,
): Promise<QueryCheck> {
  const what = queryWhat('check');
  try {
    assertReadOnly(what, sql);
    const parsed = parseSqlParams(sql.trim().replace(/;\s*$/, ''));
    return await withReadOnly(pool, sourceName, timeoutMs, async (tx) => {
      let fields: { name: string; dataTypeID: number }[];
      try {
        const r = await tx.client.query({
          text: `select * from (\n${parsed.text}\n) q limit 0`,
          values: parsed.names.map(() => null),
        });
        fields = r.fields;
      } catch (e) {
        throw mapPgError(what, e);
      }
      const oids = [...new Set(fields.map((f) => f.dataTypeID))];
      const { rows } = await tx.client.query<{ oid: number; name: string }>(
        'select oid::int as oid, pg_catalog.format_type(oid, null) as name from pg_catalog.pg_type where oid = any($1::oid[])',
        [oids],
      );
      const names = new Map(rows.map((r) => [r.oid, r.name]));
      await tx.guard(what);
      return {
        ok: true as const,
        columns: fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) ?? 'unknown' })),
      };
    });
  } catch (e) {
    if (e instanceof SqlParamError) return { ok: false, error: ruText(e.key) };
    if (e instanceof AppError && (e.code === 'SQL_ERROR' || e.code === 'TIMEOUT'))
      return { ok: false, error: e.message };
    throw e;
  }
}
```

Примечания: `e.message` у `AppError` — текст по-русски (для журнала); если в модуле принято отдавать переведённый текст, принять `locale` параметром и вернуть `e.textIn(locale)` (сверить с `AppError.textIn`, `lib/errors.ts`) — так и сделать: сигнатура `checkQuery(pool, sourceName, sql, timeoutMs, locale)`. `ruText` импортировать из `../../lib/errors`, `SqlParamError` уже импортирован. Если `mapPgError`/`queryWhat`/`assertReadOnly` не экспортируются — `checkQuery` живёт в том же файле, экспорт не нужен.

- [ ] **Step 3: `introspect.ts`.**

```ts
// Схема источника для авторов (§51.2): только системный каталог, только отношения с SELECT.
import type {
  RelationKind, SchemaColumn, SchemaForeignKey, SchemaTable, SchemaTableDetails, SchemaTableList,
} from '@carbone-reports/shared';
import type pg from 'pg';

const KINDS: Record<string, RelationKind> = { r: 'table', p: 'table', v: 'view', m: 'matview', f: 'foreign' };
const MAX_TABLES = 100;
const MAX_COLUMNS = 300;

const RELATIONS = `
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','p','v','m','f')
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
    and pg_catalog.has_table_privilege(c.oid, 'SELECT')`;

/** Подстрока для ILIKE: % _ \\ — буквально. */
const likeArg = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export async function listTables(client: pg.ClientBase, search?: string): Promise<SchemaTableList> {
  const q = search?.trim() || null;
  const { rows } = await client.query<{ schema: string; name: string; kind: string; comment: string | null; total: string }>(
    `select n.nspname as schema, c.relname as name, c.relkind as kind,
            pg_catalog.obj_description(c.oid, 'pg_class') as comment,
            count(*) over () as total
     ${RELATIONS}
       and ($1::text is null or c.relname ilike $1 or pg_catalog.obj_description(c.oid, 'pg_class') ilike $1)
     order by n.nspname <> all (pg_catalog.current_schemas(false)), c.relname, n.nspname
     limit ${MAX_TABLES}`,
    [q === null ? null : likeArg(q)],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    tables: rows.map((r) => ({ schema: r.schema, name: r.name, kind: KINDS[r.kind]!, comment: r.comment })),
  };
}

/** `таблица` или `схема.таблица`; без схемы — первая доступная по search_path. null — нет доступной. */
export async function describeTable(client: pg.ClientBase, ref: string): Promise<SchemaTableDetails | null> {
  const dot = ref.indexOf('.');
  const schema = dot > 0 ? ref.slice(0, dot) : null;
  const name = dot > 0 ? ref.slice(dot + 1) : ref;
  const { rows: rel } = await client.query<{ oid: number; schema: string; name: string; kind: string; comment: string | null }>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name, c.relkind as kind,
            pg_catalog.obj_description(c.oid, 'pg_class') as comment
     ${RELATIONS}
       and c.relname = $2
       and (case when $1::text is null then n.nspname = any (pg_catalog.current_schemas(false)) else n.nspname = $1 end)
     order by pg_catalog.array_position(pg_catalog.current_schemas(false), n.nspname::text)
     limit 1`,
    [schema, name],
  );
  const t = rel[0];
  if (!t) return null;
  const { rows: cols } = await client.query<SchemaColumn>(
    `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as "notNull", pg_catalog.col_description(a.attrelid, a.attnum) as comment
     from pg_catalog.pg_attribute a
     where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
     order by a.attnum limit ${MAX_COLUMNS}`,
    [t.oid],
  );
  const { rows: pk } = await client.query<{ name: string }>(
    `select a.attname as name
     from pg_catalog.pg_index i
     join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = $1 and i.indisprimary
     order by pg_catalog.array_position(i.indkey::int2[], a.attnum)`,
    [t.oid],
  );
  const { rows: fks } = await client.query<{ columns: string[]; ref_schema: string; ref_table: string; ref_columns: string[] }>(
    `select array(select a.attname from unnest(k.conkey) with ordinality u(n, o)
                  join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.o) as columns,
            rn.nspname as ref_schema, rc.relname as ref_table,
            array(select a.attname from unnest(k.confkey) with ordinality u(n, o)
                  join pg_catalog.pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.o) as ref_columns
     from pg_catalog.pg_constraint k
     join pg_catalog.pg_class rc on rc.oid = k.confrelid
     join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
     where k.conrelid = $1 and k.contype = 'f'
     order by k.conname`,
    [t.oid],
  );
  return {
    schema: t.schema,
    name: t.name,
    kind: KINDS[t.kind]!,
    comment: t.comment,
    columns: cols,
    primaryKey: pk.map((r) => r.name),
    foreignKeys: fks.map((f): SchemaForeignKey => ({
      columns: f.columns,
      references: { schema: f.ref_schema, table: f.ref_table, columns: f.ref_columns },
    })),
  };
}
```

- [ ] **Step 4: `routes.ts` и подключение.** `withReadOnly` из executor.ts экспортировать (сейчас он внутренний) — нужен для чтения каталога в той же read-only транзакции с таймаутом:

```ts
// Схема источника и проверка SQL для авторов шаблонов (§51.2).
import { CheckQueryBody, IdParams } from '@carbone-reports/shared';
import { z } from 'zod';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { notFound } from '../../lib/errors';
import type { Guards } from '../auth/guards';
import { checkQuery, withReadOnly } from '../queries/executor';
import { loadTemplate } from '../templates/service';
import { describeTable, listTables } from './introspect';

export function registerSchemaRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const pre = { preHandler: guards.requireTemplateEdit };
  const source = async (id: string) => deps.sources.get((await loadTemplate(deps.db, id)).datasourceId);
  const timeout = deps.config.queryTimeoutMs;

  app.get(
    '/api/templates/:id/schema/tables',
    { ...pre, schema: { params: IdParams, querystring: z.object({ search: z.string().max(200).optional() }) } },
    async (req) => {
      const { pool, name } = await source(req.params.id);
      return withReadOnly(pool, name, timeout, (tx) => listTables(tx.client, req.query.search));
    },
  );

  app.get(
    '/api/templates/:id/schema/tables/:name',
    { ...pre, schema: { params: IdParams.extend({ name: z.string().min(1).max(200) }) } },
    async (req) => {
      const { pool, name } = await source(req.params.id);
      const t = await withReadOnly(pool, name, timeout, (tx) => describeTable(tx.client, req.params.name));
      if (!t) throw notFound('table');
      return t;
    },
  );

  app.post(
    '/api/templates/:id/queries/check',
    { ...pre, schema: { params: IdParams, body: CheckQueryBody } },
    async (req) => {
      const { pool, name } = await source(req.params.id);
      return checkQuery(pool, name, req.body.sql, timeout, req.locale);
    },
  );
}
```

`CheckQueryBody = z.object({ sql: z.string().trim().min(1).max(20_000) })` — в `packages/shared/src/assistant.ts`. Ключ ошибки `errors:notFound.table` («таблица не найдена» / «table not found» и переводы) — во все 7 каталогов. Регистрация в `app.ts` после `registerReportRoutes`. Проверить, что `loadTemplate` возвращает строку с `datasourceId` (поле в `templates`).

Run: интеграционный тест Step 1 → PASS; `test/sql-readonly.int.test.ts` и `test/param-options.int.test.ts` → PASS; `pnpm --filter @carbone-reports/api test`, `pnpm -r typecheck`, `pnpm i18n:check`.

- [ ] **Step 5: Commit** — `feat(schema): схема источника и проверка SQL для авторов (§51.2)`.

---

### Task 3: Авторские инструменты и авторский режим чата

**Files:**
- Create: `apps/api/src/modules/assistant/author-tools.ts`, `author-tools.test.ts`
- Modify: `apps/api/src/modules/assistant/tools.ts` (объединение наборов), `prompt.ts` (+ авторский раздел), `routes.ts` (определение режима), `agent.test.ts`/`prompt` тест
- Modify: `apps/api/test/assistant-chat.int.test.ts` (авторский сценарий)

**Interfaces:**
- Consumes: `Inject`, `ToolContext`, `AgentTools`, `ToolOutcome`, `errorOf` (tools.ts); `EditorDraft`, `Card`, `MAX_CARDS` (Task 1); эндпоинты Task 2; `canEditTemplate(db, user, id)` из `apps/api/src/modules/access/permissions.ts`; `TemplateQuery`, `TemplateParam` (shared).
- Produces:
  ```ts
  export function createAuthorTools(ctx: ToolContext & { templateId: string; draft: EditorDraft }): AgentTools
  export function mergeTools(...sets: AgentTools[]): AgentTools
  export const AUTHOR_MAX_TOOL_CALLS = 12;
  // prompt.ts: systemPrompt({..., author?: { templateName: string }}) — авторский раздел
  ```

- [ ] **Step 1: Модульные тесты (падают).** `author-tools.test.ts` (фейковый `inject`):

```ts
const TID = '0b6a4c1e-5f2d-4e8a-9c3b-7d1e2f3a4b5c';
const draft = {
  queries: [{ key: 'items', mode: 'list' as const, sql: 'select name, qty from items where invoice_id = :invoiceId' }],
  params: [{ name: 'invoiceId', label: 'Счёт', type: 'number' as const, required: true, defaultValue: null, options: null, sql: null, multiple: false }],
};
const okCheck = { ok: true, columns: [{ name: 'id', type: 'integer' }] };
const setup = (responses: Record<string, { status: number; body: unknown }> = {}) => {
  const inject = vi.fn<Inject>(async (_m, url) => responses[url] ?? { status: 200, body: okCheck });
  return { inject, tools: createAuthorTools({ inject, deps: {} as AppDeps, locale: 'ru', templateId: TID, draft }) };
};

it('get_template_design: черновики и пути тегов', async () => {
  const r = await setup().tools.run('get_template_design', {});
  expect(r).toEqual({ result: {
    queries: draft.queries,
    params: draft.params,
    tagPaths: { items: 'd.items[i].<column>', params: 'd.params.<name>' },
  } });
});

it('list_tables, describe_table, check_sql — эндпоинты шаблона', async () => {
  const { inject, tools } = setup();
  await tools.run('list_tables', { search: 'comp' });
  expect(inject).toHaveBeenLastCalledWith('GET', `/api/templates/${TID}/schema/tables?search=comp`);
  await tools.run('describe_table', { name: 'public.company' });
  expect(inject).toHaveBeenLastCalledWith('GET', `/api/templates/${TID}/schema/tables/public.company`);
  await tools.run('check_sql', { sql: 'select 1' });
  expect(inject).toHaveBeenLastCalledWith('POST', `/api/templates/${TID}/queries/check`, { sql: 'select 1' });
});

it('propose_query: проверка SQL в карточке; ключ params и запись — ошибка модели', async () => {
  const { tools } = setup();
  expect(await tools.run('propose_query', { key: 'company', mode: 'single', sql: 'select 1 as id' })).toEqual({
    card: { type: 'query', templateId: TID, key: 'company', mode: 'single', sql: 'select 1 as id', check: okCheck },
  });
  const bad = await tools.run('propose_query', { key: 'params', mode: 'list', sql: 'select 1' });
  expect('result' in bad && JSON.stringify(bad.result)).toContain('error');
  const write = await tools.run('propose_query', { key: 'x', mode: 'list', sql: 'delete from company' });
  expect('result' in write && JSON.stringify(write.result)).toContain('error');
});

it('propose_param: схема параметра; неверный — ошибка модели', async () => {
  const { tools } = setup();
  const p = { name: 'from', label: 'С даты', type: 'date', required: true, defaultValue: null, options: null, sql: null, multiple: false };
  expect(await tools.run('propose_param', { param: p })).toEqual({ card: { type: 'param', templateId: TID, param: p } });
  const bad = await tools.run('propose_param', { param: { ...p, name: '1x' } });
  expect('result' in bad && JSON.stringify(bad.result)).toContain('error');
});

it('propose_tags: текст ≤ 2000', async () => {
  const { tools } = setup();
  expect(await tools.run('propose_tags', { text: '{d.company.name}', explanation: 'Название' })).toEqual({
    card: { type: 'tags', templateId: TID, text: '{d.company.name}', explanation: 'Название' },
  });
  const long = await tools.run('propose_tags', { text: 'x'.repeat(2001), explanation: '' });
  expect('result' in long).toBe(true);
});

it('ошибка эндпоинта схемы — безопасный текст (errorOf)', async () => {
  const { tools } = setup({ [`/api/templates/${TID}/schema/tables`]: { status: 502, body: { error: { code: 'DATASOURCE_UNAVAILABLE', message: 'host db-secret:5432' } } } });
  const r = await tools.run('list_tables', {});
  expect(JSON.stringify(r)).not.toContain('db-secret');
});
```

Тест промпта (в `agent.test.ts` рядом с `systemPrompt`): с `author: { templateName: 'Счёт' }` в тексте есть `check_sql`, `d.<key>[i]`, `formatC`, имя шаблона; без `author` — нет `check_sql`.

Run: `pnpm --filter @carbone-reports/api exec vitest run src/modules/assistant` → FAIL.

- [ ] **Step 2: `author-tools.ts`.**

```ts
// Авторские инструменты ассистента (§51.3): схема и проверка SQL — через эндпоинты шаблона
// от имени пользователя; предложения — карточки, шаблон не меняется.
import {
  checkReadOnlySql, MAX_CARDS, QueryMode, TemplateParam, TemplateQuery, type EditorDraft, type QueryCheck,
} from '@carbone-reports/shared';
import { z } from 'zod';
import type { ToolSpec } from './llm';
import { errorOf, type AgentTools, type ToolContext, type ToolOutcome } from './tools';

export const AUTHOR_MAX_TOOL_CALLS = 12;
const MAX_TAGS_TEXT = 2000;
const enc = encodeURIComponent;

const str = (description: string) => ({ type: 'string', description });
const PARAM_SCHEMA = {
  type: 'object',
  description: 'Template parameter: name (identifier), label, type (string|number|date|boolean|select|query), required, defaultValue, options ([{value,label}] for select), sql (for query: returns value,label), multiple.',
  properties: {
    name: { type: 'string' }, label: { type: 'string' }, type: { type: 'string' },
    required: { type: 'boolean' }, multiple: { type: 'boolean' }, sql: { type: 'string' },
    defaultValue: { type: 'string' },
    options: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } } } },
  },
};

const SPECS: ToolSpec[] = [
  { type: 'function', function: { name: 'get_template_design', description: 'Current (possibly unsaved) queries and parameters of the open template, and how query results map to Carbone tag paths.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_tables', description: 'Tables and views of the template data source visible to its database user. search: substring of name or comment.', parameters: { type: 'object', properties: { search: str('Substring of table name or comment') } } } },
  { type: 'function', function: { name: 'describe_table', description: 'Columns with types, primary key and foreign keys of a table. name: "table" or "schema.table".', parameters: { type: 'object', properties: { name: str('Table name, optionally schema-qualified') }, required: ['name'] } } },
  { type: 'function', function: { name: 'check_sql', description: 'Validate a read-only SQL query against the data source without fetching rows: returns result columns with types, or the error. :name placeholders are parameters.', parameters: { type: 'object', properties: { sql: str('SQL query') }, required: ['sql'] } } },
  { type: 'function', function: { name: 'propose_query', description: 'Propose a template query to the author (a card with an apply button). mode: "list" (rows → d.<key>[i]) or "single" (first row → d.<key>). Check the SQL with check_sql first.', parameters: { type: 'object', properties: { key: str('Query key: identifier, not "params"'), mode: str('list or single'), sql: str('Read-only SQL') }, required: ['key', 'mode', 'sql'] } } },
  { type: 'function', function: { name: 'propose_param', description: 'Propose a template parameter to the author (a card with an apply button).', parameters: { type: 'object', properties: { param: PARAM_SCHEMA }, required: ['param'] } } },
  { type: 'function', function: { name: 'propose_tags', description: 'Propose a fragment of Carbone tags for the document, with a short explanation (a card with a copy button).', parameters: { type: 'object', properties: { text: str('Tags fragment'), explanation: str('Short explanation') }, required: ['text', 'explanation'] } } },
];

const ARGS = {
  get_template_design: z.object({}),
  list_tables: z.object({ search: z.string().max(200).optional() }),
  describe_table: z.object({ name: z.string().min(1).max(200) }),
  check_sql: z.object({ sql: z.string().min(1).max(20_000) }),
  propose_query: z.object({ key: z.string(), mode: z.string(), sql: z.string().max(20_000) }),
  propose_param: z.object({ param: z.unknown() }),
  propose_tags: z.object({ text: z.string().min(1).max(MAX_TAGS_TEXT), explanation: z.string().max(1000) }),
};

const tagPaths = (draft: EditorDraft) => ({
  ...Object.fromEntries(
    draft.queries.map((q) => [q.key, q.mode === 'single' ? `d.${q.key}.<column>` : `d.${q.key}[i].<column>`]),
  ),
  params: 'd.params.<name>',
});

export function createAuthorTools(ctx: ToolContext & { templateId: string; draft: EditorDraft }): AgentTools {
  const { inject, templateId, draft } = ctx;
  const base = `/api/templates/${enc(templateId)}`;

  const call = async (tool: string, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const r = await inject(method, url, payload);
    if (r.status === 200) return { result: r.body };
    ctx.onError?.(tool, r.status, r.body);
    return { result: errorOf(r) };
  };

  async function run(name: string, raw: unknown): Promise<ToolOutcome> {
    if (!Object.hasOwn(ARGS, name)) return { result: { error: `unknown tool: ${name}` } };
    const parsed = ARGS[name as keyof typeof ARGS].safeParse(raw ?? {});
    if (!parsed.success) return { result: { error: `invalid arguments: ${parsed.error.message}` } };
    const a = parsed.data as Record<string, unknown>;
    switch (name) {
      case 'get_template_design':
        return { result: { queries: draft.queries, params: draft.params, tagPaths: tagPaths(draft) } };
      case 'list_tables': {
        const q = a.search ? `?search=${enc(a.search as string)}` : '';
        return call(name, 'GET', `${base}/schema/tables${q}`);
      }
      case 'describe_table':
        return call(name, 'GET', `${base}/schema/tables/${enc(a.name as string)}`);
      case 'check_sql':
        return call(name, 'POST', `${base}/queries/check`, { sql: a.sql });
      case 'propose_query': {
        const q = TemplateQuery.safeParse({ key: a.key, mode: a.mode, sql: a.sql });
        if (!q.success) return { result: { error: `invalid query: ${q.error.issues.map((i) => i.message).join('; ')}` } };
        const r = await inject('POST', `${base}/queries/check`, { sql: q.data.sql });
        const check: QueryCheck = r.status === 200 ? (r.body as QueryCheck) : { ok: false, error: errorOf(r).error };
        return { card: { type: 'query', templateId, key: q.data.key, mode: q.data.mode, sql: q.data.sql, check } };
      }
      case 'propose_param': {
        const p = TemplateParam.safeParse(a.param);
        if (!p.success) return { result: { error: `invalid parameter: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` } };
        return { card: { type: 'param', templateId, param: p.data } };
      }
      default:
        return { card: { type: 'tags', templateId, text: a.text as string, explanation: a.explanation as string } };
    }
  }

  return { specs: SPECS, run };
}
```

Примечания исполнителю: `TemplateQuery` в shared — объект с `key`, `sql`, `mode` (сверить, нет ли других обязательных полей; если есть — передать значения по умолчанию из схемы). Сообщения zod — ключи вида `v:identKey`; для модели это непонятно, поэтому в ошибке `propose_query`/`propose_param` перевести их на английский: `translateMsg('en', …)`-подобного для `v:` нет — использовать `issueMessage(issue, 'en')` из `apps/api/src/lib/errors.ts` (сверить экспорт; если не экспортирован — экспортировать). `checkReadOnlySql` уже вызывается внутри схемы `TemplateQuery` (`readOnlyIssue`), отдельный импорт не нужен — убрать, если линтер ругается. `MAX_CARDS` контролирует `runAgent` (Task 1), здесь не нужен — убрать из импорта.

`mergeTools` в `tools.ts`:

```ts
/** Наборы инструментов в один: имена не пересекаются. */
export function mergeTools(...sets: AgentTools[]): AgentTools {
  const owner = new Map<string, AgentTools>();
  for (const s of sets) for (const sp of s.specs) owner.set(sp.function.name, s);
  return {
    specs: sets.flatMap((s) => s.specs),
    run: (name, args) => (owner.get(name) ?? sets[0]!).run(name, args),
  };
}
```

- [ ] **Step 3: Промпт.** В `prompt.ts` `systemPrompt` принимает `author?: { templateName: string }`; при наличии добавляет:

```ts
const AUTHOR = [
  'The user is the author of the open template «{name}». Help with SQL queries, parameters and Carbone tags.',
  '- Queries are read-only SQL for PostgreSQL. Parameters are referenced as :name and must exist as template parameters.',
  '- Find tables with list_tables and their columns with describe_table. Never invent tables or columns.',
  '- Always validate SQL with check_sql before propose_query. Propose parameters for every :name with propose_param.',
  '- You never see data rows; only column names and types.',
  'Carbone tags: query in list mode → {d.<key>[i].<column>} ... {d.<key>[i+1]} (a table row repeated per item); single mode → {d.<key>.<column>}; parameters → {d.params.<name>}.',
  'Formatters: {d.date:formatD(DD.MM.YYYY)}, {d.qty:formatN(2)}, {d.total:formatC(2)}; conditions: {d.x:ifEQ(1):show(yes):elseShow(no)}; aggregation: {d.items[].total:aggSum}.',
  '- Suggest document fragments with propose_tags. The author applies cards with buttons; you do not change the template.',
];
```

(вставлять после основных правил, `{name}` — `author.templateName`). Сверить форматтеры с встроенной справкой §46 (`apps/web/src/pages/admin/help/content/` — русский модуль): если какой-то форматтер там называется иначе или не поддерживается этой версией Carbone — взять оттуда.

- [ ] **Step 4: Режим в маршруте.** В `routes.ts` в обработчике чата:

```ts
      const { templateId, editor } = req.body.page;
      let author: { templateName: string; draft: EditorDraft } | null = null;
      if (templateId && UUID_RE.test(templateId) && (await canEditTemplate(deps.db, currentUser(req), templateId))) {
        const row = await loadTemplate(deps.db, templateId);
        // Без черновика из редактора — сохранённые запросы и параметры.
        const full = editor ? null : await loadTemplateFull(deps.db, templateId);
        author = {
          templateName: row.name,
          draft: editor ?? { queries: full!.queries.map(({ key, mode, sql }) => ({ key, mode, sql })), params: full!.params },
        };
      }
      const toolCtx = { inject, deps, locale: req.locale, onError: … };
      const tools = author
        ? mergeTools(createAssistantTools(toolCtx), createAuthorTools({ ...toolCtx, templateId: templateId!, draft: author.draft }))
        : createAssistantTools(toolCtx);
      … runAgent({ …, tools, maxToolCalls: author ? AUTHOR_MAX_TOOL_CALLS : undefined,
                   system: systemPrompt({ …, author: author ? { templateName: author.templateName } : undefined }) })
```

`UUID_RE` — из tools.ts (экспортировать) или из shared, если там есть; `canEditTemplate` — `apps/api/src/modules/access/permissions.ts`; `loadTemplate`, `loadTemplateFull` — `templates/service.ts`; `full.params` — `TemplateParam[]` (сверить тип в `TemplateFull`). Шаблон удалён (`loadTemplate` бросает 404) — ловить и работать без авторского режима.

- [ ] **Step 5: Интеграционный сценарий (падает, затем проходит).** В `assistant-chat.int.test.ts` новый `describe('авторский режим')`: источник с `company`/`invoices` (как Task 2, без ограниченной роли), шаблон автора; пользователь-автор (admin) и пользователь `user` с доступом на запуск.

```ts
it('автор: схема → проверка → две карточки; строки данных не уходят в модель', async () => {
  const sent: string[] = [];
  let step = 0;
  const llm = await fakeLlm((body) => {
    sent.push(JSON.stringify(body.messages));
    const steps = [
      toolCall('list_tables', {}),
      toolCall('describe_table', { name: 'company' }),
      toolCall('check_sql', { sql: 'select id, name from company where id = :companyId' }),
      { content: null, tool_calls: [
        { id: 'q', type: 'function', function: { name: 'propose_query', arguments: JSON.stringify({ key: 'company', mode: 'single', sql: 'select id, name from company where id = :companyId' }) } },
        { id: 'p', type: 'function', function: { name: 'propose_param', arguments: JSON.stringify({ param: { name: 'companyId', label: 'Компания', type: 'number', required: true, defaultValue: null, options: null, sql: null, multiple: false } }) } },
      ] },
    ];
    return { message: steps[step++] ?? { content: 'Готово' } };
  });
  await enable(llm.url);
  const r = await chatAt(author, { path: `/admin/templates/${tpl}`, templateId: tpl, editor: { queries: [], params: [] } });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().cards.map((c: { type: string }) => c.type)).toEqual(['query', 'param']);
  expect(r.json().cards[0].check).toEqual({ ok: true, columns: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'text' }] });
  expect(sent.join('\n')).not.toContain('Ромашка'); // строки company не уходят
  await llm.close();
});

it('без права правки: авторских инструментов нет, editor не в промпте', async () => {
  let tools: string[] = [];
  let system = '';
  const llm = await fakeLlm((body) => {
    tools = ((body.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    system = JSON.stringify(body.messages[0]);
    return { message: { content: 'ok' } };
  });
  await enable(llm.url);
  await chatAt(user, { path: `/admin/templates/${tpl}`, templateId: tpl, editor: { queries: [{ key: 'secret_q', mode: 'list', sql: 'select 1' }], params: [] } });
  expect(tools).not.toContain('list_tables');
  expect(system).not.toContain('secret_q');
  await llm.close();
});
```

(`chatAt(cookie, page)` — помощник по образцу `chat`, передающий `page`. Для второго сценария `get_template_design` — тоже авторский инструмент, поэтому `secret_q` не может попасть и через него.)

Run: модульные и интеграционный → PASS; `pnpm --filter @carbone-reports/api test`, `typecheck`, eslint.

- [ ] **Step 6: Commit** — `feat(assistant): авторские инструменты и авторский режим чата (§51.3)`.

---

### Task 4: Мост панели и редактора, применение во вкладки

**Files:**
- Create: `apps/web/src/features/assistant/bridge.tsx`, `bridge.test.tsx`
- Modify: `apps/web/src/app/Layout.tsx` (провайдер моста вокруг всего содержимого)
- Modify: `apps/web/src/features/assistant/useAssistantChat.ts` (`page.templateId`, `page.editor` из моста)
- Modify: `apps/web/src/pages/admin/template-editor/TemplateEditorPage.tsx`, `DataTab.tsx`, `ParamsTab.tsx` (+ их тесты)

**Interfaces:**
- Consumes: `Card`, `EditorDraft` (Task 1).
- Produces:
  ```ts
  export type ApplyCard = Extract<Card, { type: 'query' } | { type: 'param' }>;
  export interface EditorRegistration { templateId: string; templateName: string; saved: () => EditorDraft; openTab: (tab: 'data' | 'params') => void }
  export interface TabRegistration { kind: 'query' | 'param'; draft: () => EditorDraft['queries'] | EditorDraft['params']; apply: (card: ApplyCard) => void }
  export interface AssistantBridge {
    editor: EditorRegistration | null;
    registerEditor(r: EditorRegistration): () => void;
    registerTab(r: TabRegistration): () => void;
    draft(): EditorDraft | null;               // смонтированные вкладки, иначе saved()
    apply(card: ApplyCard): void;              // вкладка смонтирована — сразу; иначе в очередь + openTab
    takePending(kind: 'query' | 'param'): ApplyCard[];
  }
  export function AssistantBridgeProvider({ children }: { children: ReactNode }): JSX.Element
  export function useAssistantBridge(): AssistantBridge
  /** Чистые функции применения — для вкладок и тестов. */
  export function applyQuery<T extends { key: string; mode: QueryMode; sql: string }>(drafts: T[], card: Extract<Card, { type: 'query' }>, make: (q: { key: string; mode: QueryMode; sql: string }) => T): T[]
  export function applyParam<T extends { name: string }>(drafts: T[], card: Extract<Card, { type: 'param' }>, make: (p: TemplateParam) => T): T[]
  ```

- [ ] **Step 1: Тесты (падают).** `bridge.test.tsx`:

```tsx
describe('applyQuery / applyParam', () => {
  const make = (q: { key: string; mode: 'list' | 'single'; sql: string }) => ({ id: 9, ...q });
  const card = (key: string) => ({ type: 'query' as const, templateId: 't', key, mode: 'list' as const, sql: 'select 2', check: { ok: true as const, columns: [] } });
  it('ключ есть — замена SQL и режима на месте', () => {
    const d = [{ id: 1, key: 'items', mode: 'single' as const, sql: 'select 1' }];
    expect(applyQuery(d, card('items'), make)).toEqual([{ id: 1, key: 'items', mode: 'list', sql: 'select 2' }]);
  });
  it('ключа нет (автор переименовал) — добавление в конец', () => {
    const d = [{ id: 1, key: 'rows', mode: 'list' as const, sql: 'select 1' }];
    expect(applyQuery(d, card('items'), make)).toEqual([...d, { id: 9, key: 'items', mode: 'list', sql: 'select 2' }]);
  });
  it('параметр: по имени — замена, иначе добавление', () => {
    const p = (name: string, label: string) => ({ name, label, type: 'string' as const, required: false, defaultValue: null, options: null, sql: null, multiple: false });
    const pc = (param: ReturnType<typeof p>) => ({ type: 'param' as const, templateId: 't', param });
    const makeP = (x: ReturnType<typeof p>) => ({ id: 9, ...x });
    const d = [{ id: 1, ...p('from', 'С') }];
    expect(applyParam(d, pc(p('from', 'С даты')), makeP)).toEqual([{ id: 1, ...p('from', 'С даты') }]);
    expect(applyParam(d, pc(p('to', 'По')), makeP)).toEqual([...d, { id: 9, ...p('to', 'По') }]);
  });
});

describe('мост', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <AssistantBridgeProvider>{children}</AssistantBridgeProvider>;
  const saved = { queries: [{ key: 'a', mode: 'list' as const, sql: 'select 1' }], params: [] };
  const qcard = { type: 'query' as const, templateId: 't', key: 'b', mode: 'list' as const, sql: 'select 2', check: { ok: true as const, columns: [] } };

  it('вкладка не смонтирована — применение в очередь и openTab; takePending отдаёт и очищает', () => {
    const { result } = renderHook(() => useAssistantBridge(), { wrapper });
    const openTab = vi.fn();
    act(() => { result.current.registerEditor({ templateId: 't', templateName: 'T', saved: () => saved, openTab }); });
    act(() => result.current.apply(qcard));
    expect(openTab).toHaveBeenCalledWith('data');
    expect(result.current.takePending('query')).toEqual([qcard]);
    expect(result.current.takePending('query')).toEqual([]);
  });

  it('вкладка смонтирована — apply сразу; draft(): черновик вкладки, иначе saved()', () => {
    const { result } = renderHook(() => useAssistantBridge(), { wrapper });
    act(() => { result.current.registerEditor({ templateId: 't', templateName: 'T', saved: () => saved, openTab: vi.fn() }); });
    expect(result.current.draft()).toEqual(saved);
    const apply = vi.fn();
    act(() => { result.current.registerTab({ kind: 'query', draft: () => [{ key: 'x', mode: 'single', sql: 'select 3' }], apply }); });
    result.current.apply(qcard);
    expect(apply).toHaveBeenCalledWith(qcard);
    expect(result.current.draft()!.queries).toEqual([{ key: 'x', mode: 'single', sql: 'select 3' }]);
  });
});
```

В `DataTab.test.tsx` (существующий файл вкладки — по его образцу рендера): мост с ожидающей карточкой `query` для этого шаблона → после монтирования в списке запросов новый ключ и пометка «есть несохранённые изменения» (текст `editor:draft.*` — сверить в каталоге); в `ParamsTab.test.tsx` — то же для параметра.

Run: `pnpm --filter @carbone-reports/web exec vitest run src/features/assistant src/pages/admin/template-editor` → FAIL.

- [ ] **Step 2: `bridge.tsx`.** Контекст на `useRef` (регистрации не вызывают перерисовок), `editor` — в `useState` (панель должна знать, открыт ли редактор, чтобы включать кнопки):

```tsx
const Ctx = createContext<AssistantBridge | null>(null);

export function AssistantBridgeProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<EditorRegistration | null>(null);
  const tabs = useRef(new Map<'query' | 'param', TabRegistration>());
  const pending = useRef<ApplyCard[]>([]);
  const value = useMemo<AssistantBridge>(() => ({
    editor,
    registerEditor: (r) => { setEditor(r); return () => setEditor((cur) => (cur === r ? null : cur)); },
    registerTab: (r) => { tabs.current.set(r.kind, r); return () => { if (tabs.current.get(r.kind) === r) tabs.current.delete(r.kind); }; },
    draft: () => {
      if (!editor) return null;
      const saved = editor.saved();
      return {
        queries: (tabs.current.get('query')?.draft() as EditorDraft['queries'] | undefined) ?? saved.queries,
        params: (tabs.current.get('param')?.draft() as EditorDraft['params'] | undefined) ?? saved.params,
      };
    },
    apply: (card) => {
      const kind = card.type;
      const tab = tabs.current.get(kind);
      if (tab) tab.apply(card);
      else { pending.current.push(card); editor?.openTab(kind === 'query' ? 'data' : 'params'); }
    },
    takePending: (kind) => {
      const mine = pending.current.filter((c) => c.type === kind);
      pending.current = pending.current.filter((c) => c.type !== kind);
      return mine;
    },
  }), [editor]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistantBridge(): AssistantBridge {
  const b = useContext(Ctx);
  if (!b) throw new Error('AssistantBridgeProvider missing');
  return b;
}
```

`applyQuery`/`applyParam` — по сигнатурам Interfaces. Черновики вкладок могут хранить параметры не в виде `TemplateParam` (у `ParamsTab` свой `Draft` с `optionsText`) — `draft()` вкладки отдаёт `drafts.map(toParam)` (в черновике могут быть невалидные значения: `EditorDraft` на сервере проверяет zod — отфильтровать на клиенте `TemplateParam.safeParse(...).success`, чтобы один недописанный параметр не ронял чат 400).

- [ ] **Step 3: Подключение.**
  - `Layout.tsx`: весь возвращаемый JSX — в `<AssistantBridgeProvider>`.
  - `TemplateEditorPage.tsx`: `useEffect(() => bridge.registerEditor({ templateId: tpl.id, templateName: tpl.name, saved: () => ({ queries: tpl.queries.map(({ key, mode, sql }) => ({ key, mode, sql })), params: tpl.params }), openTab: (t) => selectTab(t) }), [tpl, …])` — после загрузки `tpl`; при размонтировании регистрация снимается.
  - `DataTab.tsx`: `useEffect` регистрирует вкладку `{ kind: 'query', draft: () => draftsRef.current.map(({ key, mode, sql }) => ({ key, mode, sql })), apply: (c) => setDrafts((d) => applyQuery(d, c, (q) => ({ id: nextId.current++, ...q }))) }`; при монтировании — `bridge.takePending('query').forEach(apply)`; после применения выбрать применённый запрос (`setSelectedId`) и показать уведомление `toaster.add({ theme: 'info', title: t('common:assistant.applied') })`. `draftsRef` — актуальные черновики (`useRef`, обновляется при каждом рендере).
  - `ParamsTab.tsx`: то же с `kind: 'param'`, `applyParam(d, c, (p) => toDraft(p, nextId.current++))`, `draft: () => draftsRef.current.map(toParam)` с фильтром `TemplateParam.safeParse`.
  - `useAssistantChat.ts`: при отправке `page: { path, …(reportId), …(bridge.editor ? { templateId: bridge.editor.templateId, editor: bridge.draft() ?? undefined } : {}) }`. Хук используется в `Layout` — вызвать `useAssistantBridge()` внутри провайдера: перенести вызов `useAssistantChat()` в дочерний компонент `Layout` (например, `LayoutShell`) внутри провайдера, сохранив поведение.
  - Ключ `common:assistant.applied` — «Применено, не сохранено» / «Applied, not saved» и переводы во все 7 каталогов.

Run: тесты Step 1 → PASS; `pnpm --filter @carbone-reports/web test` (полный), `pnpm i18n:check`, `pnpm -r typecheck`, `pnpm lint`.

- [ ] **Step 4: Commit** — `feat(assistant): мост панели и редактора, применение в черновики (§51.5)`.

---

### Task 5: Карточки запроса, параметра и фрагмента; тексты

**Files:**
- Create: `apps/web/src/features/assistant/QueryCardView.tsx`, `ParamCardView.tsx`, `TagsCardView.tsx`, `cards.test.tsx`
- Modify: `apps/web/src/features/assistant/AssistantPanel.tsx`, `useAssistantChat.ts` (`cardText` по типам), `assistant.css` (`z-index` над `.cr-doc-full`)
- Modify: `apps/web/src/pages/admin/AssistantPage.tsx` (дополнение предупреждения)
- Modify: каталоги `common.json`, `admin.json` (7 языков)

**Interfaces:**
- Consumes: `useAssistantBridge`, `ApplyCard` (Task 4); `Card` (Task 1).
- Produces: компоненты карточек; ключи `common:assistant.card.*`.

- [ ] **Step 1: Тексты** (ru / en; остальные пять — перевод с en):

| Ключ (`common:assistant.…`) | ru | en |
|---|---|---|
| `card.addQuery` | Добавить запрос | Add query |
| `card.replaceQuery` | Заменить запрос «{{key}}» | Replace query “{{key}}” |
| `card.addParam` | Создать параметр | Create parameter |
| `card.replaceParam` | Обновить «{{name}}» | Update “{{name}}” |
| `card.copy` | Копировать | Copy |
| `card.copied` | Скопировано | Copied |
| `card.openTemplate` | Откройте шаблон, чтобы применить | Open the template to apply |
| `card.modeList` | список строк | list of rows |
| `card.modeSingle` | одна строка | single row |
| `card.checkOk` | Проверено: {{columns}} | Checked: {{columns}} |
| `card.checkFailed` | Ошибка проверки: {{error}} | Check failed: {{error}} |
| `card.pasteHint` | Вставьте в документ: Ctrl+V | Paste into the document: Ctrl+V |
| `card.queryText` | Предложен запрос «{{key}}» ({{mode}}): {{sql}} | Proposed query “{{key}}” ({{mode}}): {{sql}} |
| `card.paramText` | Предложен параметр «{{name}}» ({{type}}) | Proposed parameter “{{name}}” ({{type}}) |
| `card.tagsText` | Предложен фрагмент документа: {{text}} | Proposed document fragment: {{text}} |
| `suggestQuery` | Напиши запрос: счета компании с суммами | Write a query: company invoices with totals |
| `suggestTables` | Какие таблицы есть в базе? | Which tables are in the database? |
| `suggestTags` | Как вывести в документе таблицу позиций? | How do I show a table of items in the document? |

`admin:assistant.privacyAuthor` — «Для авторов шаблонов также передаются SQL запросов шаблона и схема базы данных источника (таблицы и колонки), но не данные.» / «For template authors, template SQL and the data source schema (tables and columns) are also sent, but not data.» — выводится вторым абзацем в `Alert` предупреждения на `AssistantPage`.

Подписи «Тип параметра» берутся из существующих ключей редактора параметров (`editor:params.type.*` — сверить имена в `editor.json`), не дублировать.

- [ ] **Step 2: Тесты (падают).** `cards.test.tsx` (мост через `AssistantBridgeProvider` с зарегистрированным фейковым редактором `templateId: 't1'` и вкладкой `query`):

```tsx
it('запрос: ключ занят — «Заменить», нажатие уходит в мост; результат проверки виден', async () => { … expect(screen.getByRole('button', { name: 'Заменить запрос «items»' })) … expect(screen.getByText('Проверено: id (integer), name (text)')) });
it('запрос: ключа нет — «Добавить запрос»', …);
it('ошибка проверки показывается, кнопка применения остаётся', …);
it('карточка чужого шаблона: кнопки применения неактивны, подсказка, «Копировать» работает', async () => { /* navigator.clipboard.writeText — vi.fn */ });
it('параметр: «Создать параметр» / «Обновить «from»»', …);
it('фрагмент: моноширинный текст, «Копировать», подсказка Ctrl+V', …);
it('в историю карточки уходят текстом', () => { /* toHistory с cardText из useAssistantChat: «Предложен запрос «items» (список строк): select 1» */ });
```

Run: `pnpm --filter @carbone-reports/web exec vitest run src/features/assistant` → FAIL.

- [ ] **Step 3: Реализация.**
  - `QueryCardView`: заголовок — ключ и режим; `<pre className="cr-assistant__code">` с SQL; строка проверки (`check.ok` → `checkOk` со списком `name (type)`; иначе `Alert theme="danger"` с `checkFailed`); кнопки: применение (`replaceQuery`, если в `bridge.draft()?.queries` есть ключ, иначе `addQuery`; активна при `bridge.editor?.templateId === card.templateId`, иначе `disabled` + текст `openTemplate`), «Копировать» (`navigator.clipboard.writeText(card.sql)`, затем уведомление `copied`).
  - `ParamCardView`: имя, подпись, тип, обязательность (`common:yes`/`no` или существующие ключи), варианты (`label`) или SQL списка в `<pre>`; кнопки `addParam`/`replaceParam` (по `bridge.draft()?.params`) и «Копировать» (JSON параметра).
  - `TagsCardView`: `<pre>` с текстом, пояснение, «Копировать», `pasteHint`.
  - `AssistantPanel`: карточки по `type` (`run` → `RunCardView`); пустое состояние в редакторе (есть `bridge.editor`) — подсказки `suggestQuery`, `suggestTables`, `suggestTags` вместо подсказок этапа 1.
  - `useAssistantChat.cardText` — по типам через ключи `card.*Text`; длинный SQL обрезается так, чтобы реплика уложилась в 4000 (обрезка уже есть в `toHistory`).
  - `assistant.css`: `.cr-assistant { z-index: 1100; }` (выше `.cr-doc-full` с `z-index: 1000`, `apps/web/src/app/global.css`); `.cr-assistant__code { font-family: var(--g-font-family-monospace); white-space: pre-wrap; max-height: 240px; overflow: auto; }`.

Run: тесты Step 2 → PASS; полный `pnpm --filter @carbone-reports/web test`, `pnpm i18n:check`, `pnpm -r typecheck`, `pnpm lint`.

- [ ] **Step 4: Commit** — `feat(assistant): карточки запроса, параметра и фрагмента документа (§51.5)`.

---

### Task 6: E2E и документация

**Files:**
- Create: `e2e/tests/schema.spec.ts`
- Modify: `README.md`, `README.en.md`, `CHANGELOG.md`

- [ ] **Step 1: E2E (без модели).** `e2e/tests/schema.spec.ts`:

```ts
import { adminApi, demoTemplateId, expect, test, waitForStack } from '../fixtures';

test.beforeAll(waitForStack);

test('схема демо-источника и проверка SQL через API автора', async () => {
  const api = await adminApi();
  const id = await demoTemplateId(api);
  const list = await api.get<{ tables: { name: string }[] }>(`/api/templates/${id}/schema/tables`);
  expect(list.tables.map((t) => t.name)).toContain('company');
  const company = await api.get<{ columns: { name: string }[] }>(`/api/templates/${id}/schema/tables/company`);
  expect(company.columns.map((c) => c.name)).toContain('name');
  const check = await api.post<{ ok: boolean; columns?: { name: string }[] }>(`/api/templates/${id}/queries/check`, {
    sql: 'select c.name from company c where c.id = :companyId',
  });
  expect(check).toEqual({ ok: true, columns: [{ name: 'name', type: 'text' }] });
});
```

Имена таблиц и колонок сверить с демо-базой (`demo/` и `scripts/demo-seed.ts`; SQL демо-шаблона использует `company`, `invoices`); тип колонки `name` — по фактическому определению в демо-SQL. Только компиляция: `pnpm --filter @carbone-reports/e2e exec tsc --noEmit -p .` — запуск делает контроллер после пересборки стека.

- [ ] **Step 2: README.** В разделе «ИИ-ассистент (экспериментально)» (`README.md`) добавить абзац:

```markdown
В редакторе шаблона ассистент помогает автору: пишет и проверяет SQL-запросы по схеме источника данных, предлагает параметры и теги Carbone для документа. Предложения появляются карточками; «Добавить запрос», «Создать параметр» и подобные кнопки переносят их в несохранённые черновики вкладок — сохраняет автор. Для авторов модели дополнительно передаются SQL запросов шаблона и схема базы данных источника (таблицы и колонки, всё, что видит пользователь БД источника), но не данные.
```

`README.en.md` — то же по-английски в том же месте; `pnpm docs:check`.

- [ ] **Step 3: CHANGELOG.** В раздел `## [Unreleased] — ИИ-ассистент`, «Добавлено»: `- Помощь авторам шаблонов в редакторе: SQL по схеме источника с проверкой, параметры и теги Carbone (§51).` Затем `pnpm site:check`, `pnpm test:scripts`, `pnpm docs:check`.

- [ ] **Step 4: Commit** — `docs(assistant): помощь авторам — README, CHANGELOG, e2e схемы (§51.7)`.
