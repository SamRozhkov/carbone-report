# Carbone Reports — План 7: SQL-параметры с зависимостями

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Параметр шаблона типа «SQL-список» (`query`) берёт варианты из SQL-запроса к источнику данных шаблона. Он поддерживает одиночный и множественный выбор и может зависеть от других параметров через `:name`. При генерации сервер строго проверяет, что выбранное значение есть среди вариантов.

**Architecture:**
- Тип и схема живут в `@carbone-reports/shared`.
- Граф зависимостей (разбор `:name`, топологический порядок, циклы) лежит в отдельном модуле `apps/api/src/modules/queries/param-deps.ts`.
- Варианты загружаются функцией `loadParamOptions` в `executor.ts`, в той же read-only транзакции и с тем же таймаутом.
- Строгая проверка встроена в `collectReportData` и предпросмотр.
- Варианты для интерфейса отдаёт отдельный эндпоинт.
- В интерфейсе форма отчёта загружает варианты через TanStack Query с ключом по значениям родителей.

**Tech Stack:** zod 4, drizzle, pg/pg-cursor, Fastify, React 19 + Gravity UI (`Select` с `filterable`, `multiple`), TanStack Query, Monaco, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §18.

## Global Constraints

- Тип `query`: поля `sql: string` (обязательное, непустое) и `multiple: boolean`; `options` равно `null`. У остальных типов `sql` равно `null`, `multiple` равно `false`.
- Значения: `ParamValue = string | number | boolean | null | (string | number)[]`.
- Лимит вариантов — `MAX_PARAM_OPTIONS = 1000`. При превышении — `AppError('TOO_MANY_OPTIONS', 400, 'параметр "<label>": больше 1000 вариантов — уточните запрос')`.
- Строгая проверка сравнивает значения после `String(v)`. Ошибка у поля: «значение недоступно».
- Ошибки графа зависимостей — VALIDATION с путями `<index>.sql`. Тексты:
  - «неизвестный параметр :x»;
  - «параметр не может ссылаться на себя»;
  - «циклическая зависимость: a → b → a».
- Все тексты — на русском. Новые ошибки API — в формате `AppError`.
- Гейты: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test`. Если менялся `apps/api`, дополнительно `pnpm test:int`.
- Docker на OrbStack. Перед `build`/`up` проверять `df -h /System/Volumes/Data`: если свободно меньше 2 ГБ — BLOCKED. Удалять только висячие образы `carbone-reports`. В конце задачи — `down` без `-v`.

## Review Focus

1. **Родитель изменился после выбора дочернего значения** (например, сменили регион, а город остался прежним). Ожидание: интерфейс сбрасывает дочернее значение, сервер отклоняет его при генерации с «значение недоступно». Проверка: Task 3 (сервер), Task 4 (UI).
2. **Пользователь отправляет значение не из списка** в обход UI. Ожидание: 400 VALIDATION, запуск со статусом error не создаётся, как и для прочих ошибок параметров. Проверка: Task 3.
3. **SQL параметра падает или превышает таймаут.** Ожидание: понятная ошибка. В форме отчёта она показывается у поля, при генерации возвращается тем же кодом, что ошибки SQL запросов отчёта. Проверка: Task 3, Task 4.
4. **Множественный параметр в SQL отчёта** (`= any(:ids)`). Ожидание: массив передаётся как массив Postgres, отчёт строится. Пустой необязательный параметр даёт `null`. Проверка: Task 3.
5. **Шаблон сохранён с циклом или ссылкой на несуществующий параметр.** Ожидание: `PUT params` возвращает 400 у нужной строки, сохранённые параметры не меняются. Проверка: Task 2.

## Структура файлов

```
packages/shared/src/index.ts                         ParamType 'query', TemplateParam.sql/multiple, ParamValue[], ParamOptions*
apps/api/src/db/schema.ts + drizzle/0003_*.sql        template_params.sql, .multiple
apps/api/src/modules/queries/param-deps.ts           paramRefs, orderParams (топо + проверки)
apps/api/src/modules/queries/params.ts               resolveParams: типы query/multiple
apps/api/src/modules/queries/executor.ts             loadParamOptions, rowsToOptions
apps/api/src/modules/queries/param-options.ts        validateQueryParams, optionsForParam
apps/api/src/modules/reports/service.ts              collectReportData → строгая проверка
apps/api/src/modules/templates/routes.ts             PUT params: граф; POST params/:name/options
apps/web/src/api/endpoints.ts                        templates.paramOptions
apps/web/src/components/ParamForm.tsx                QueryParamField, templateId
apps/web/src/lib/params.ts                           parentsOf, пустые значения массивов
apps/web/src/pages/admin/template-editor/ParamsTab.tsx  тип «SQL-список»
demo/template.ts, demo/initdb/00-seed.sql, e2e/      зависимые параметры в демо и E2E
```

---

### Task 1: Тип и хранение

**Files:**
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/index.test.ts`, `apps/api/src/db/schema.ts`
- Create: `apps/api/drizzle/0003_param_sql.sql` (через `db:generate`)

**Interfaces:**
- Produces:
  - `ParamType` включает `'query'`;
  - `TemplateParam` получает `sql: string | null` (по умолчанию `null`) и `multiple: boolean` (по умолчанию `false`);
  - `ParamValue` включает `(string | number)[]`;
  - `ParamOptionsBody = { params: ParamsInput }`;
  - `ParamOptionsResult = { options: SelectOptionValue[]; waitingFor?: string[] }`, где `SelectOptionValue = { value: string | number; label: string }`;
  - `MAX_PARAM_OPTIONS = 1000`.

- [ ] **Step 1: Падающие тесты shared**

`packages/shared/src/index.test.ts`, в `describe('TemplateParam')` (сверьте `base` с существующими тестами):
```ts
  const q = { name: 'city', label: 'Город', type: 'query', required: false, defaultValue: null, options: null };
  it('query требует непустой sql; options запрещены', () => {
    expect(TemplateParam.safeParse({ ...q, sql: 'select 1' }).success).toBe(true);
    expect(TemplateParam.safeParse({ ...q, sql: '  ' }).success).toBe(false);
    expect(TemplateParam.safeParse({ ...q }).success).toBe(false);
    expect(TemplateParam.safeParse({ ...q, sql: 'select 1', options: [{ value: 'a', label: 'a' }] }).success).toBe(false);
  });
  it('sql и multiple допустимы только у query', () => {
    const s = { name: 's', label: 'S', type: 'string', required: false, defaultValue: null, options: null };
    expect(TemplateParam.parse(s)).toMatchObject({ sql: null, multiple: false });
    expect(TemplateParam.safeParse({ ...s, sql: 'select 1' }).success).toBe(false);
    expect(TemplateParam.safeParse({ ...s, multiple: true }).success).toBe(false);
  });
  it('значение по умолчанию: массив только у multiple', () => {
    expect(TemplateParam.safeParse({ ...q, sql: 'select 1', multiple: true, defaultValue: [1, 'a'] }).success).toBe(true);
    expect(TemplateParam.safeParse({ ...q, sql: 'select 1', defaultValue: [1] }).success).toBe(false);
  });
```
И для `ParamsInput`: `ParamsInput.parse({ ids: [1, 2], s: 'x' })` проходит, а `{ ids: [true] }` не проходит.

Запуск: `pnpm --filter @carbone-reports/shared test`. Expected: FAIL.

- [ ] **Step 2: Shared**

```ts
export const ParamType = z.enum(['string', 'number', 'date', 'boolean', 'select', 'query']);

export const ScalarValue = z.union([z.string(), z.number()]);
export const ParamValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(ScalarValue)]);

export const MAX_PARAM_OPTIONS = 1000;

export const TemplateParam = z
  .object({
    name: /* как было */,
    label: z.string().min(1),
    type: ParamType,
    required: z.boolean(),
    defaultValue: ParamValue,
    options: z.array(SelectOption).min(1).nullable(),
    /** Только для type=query: запрос вариантов к источнику шаблона; :name — ссылки на другие параметры. */
    sql: z.string().nullable().default(null),
    multiple: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (p.type === 'select' && !(p.options && p.options.length > 0))
      issue('options', 'для select нужен хотя бы один вариант');
    if (p.type === 'query') {
      if (!p.sql || !p.sql.trim()) issue('sql', 'укажите SQL-запрос вариантов');
      if (p.options !== null) issue('options', 'у SQL-списка варианты задаются запросом');
      if (Array.isArray(p.defaultValue) && !p.multiple)
        issue('defaultValue', 'несколько значений допустимы только при множественном выборе');
    } else {
      if (p.sql !== null) issue('sql', 'SQL допустим только у типа «SQL-список»');
      if (p.multiple) issue('multiple', 'множественный выбор допустим только у типа «SQL-список»');
      if (Array.isArray(p.defaultValue)) issue('defaultValue', 'недопустимое значение');
    }
  });

export const SelectOptionValue = z.object({ value: ScalarValue, label: z.string() });
export type SelectOptionValue = z.infer<typeof SelectOptionValue>;
export const ParamOptionsBody = z.object({ params: ParamsInput });
export type ParamOptionsResult = { options: SelectOptionValue[]; waitingFor?: string[] };
```
`ParamsInput` уже определён как `z.record(z.string(), ParamValue)`, поэтому массивы он начнёт принимать автоматически. Проверьте, что DTO шаблона (`TemplateDetails`, `TemplateAdminDetails`) включают `sql` и `multiple`: если параметры в DTO — это `TemplateParam`, так и будет.

**Безопасность:** `sql` параметра виден в DTO пользователя (`toDetails`). Пользователю SQL не нужен, поэтому в `toDetails` (не в админском DTO) отдавайте `sql: null`. Проверьте, где строится `toDetails`, и сделайте это в Task 3 вместе с эндпоинтом. В Task 1 только отметьте это в отчёте.

- [ ] **Step 3: Миграция**

`schema.ts`, `templateParams`:
```ts
    sql: text('sql'),
    multiple: boolean('multiple').notNull().default(false),
```
```bash
pnpm --filter @carbone-reports/api db:generate --name param_sql
```
Повторный `db:generate` должен сказать «No schema changes».

Проверьте, что чтение и запись параметров (`loadTemplateFull`, `insert` в `PUT params`, `duplicate`) переносят новые поля. Если где-то строки маппятся в `TemplateParam` вручную, добавьте `sql` и `multiple`.

- [ ] **Step 4: Прогон, гейты, коммит**

```bash
pnpm --filter @carbone-reports/shared test
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm test:int
git add packages/shared apps/api
git commit -m "feat(shared): query param type with sql, multiple and array values"
```
Если `typecheck` падает в `apps/web` (например, `switch` по `param.type` стал неполным или где-то не учтены массивы), сделайте минимальную правку: для `query` пока отрисовать `TextInput` с пометкой `// Task 4`. Полный интерфейс — в Task 4.

---

### Task 2: Граф зависимостей и сохранение

**Files:**
- Create: `apps/api/src/modules/queries/param-deps.ts`, `apps/api/src/modules/queries/param-deps.test.ts`
- Modify: `apps/api/src/modules/templates/routes.ts` (`PUT params`), `apps/api/test/templates.int.test.ts`

**Interfaces:**
- Produces:
  - `paramRefs(def: TemplateParam): string[]` — уникальные имена `:x` из `def.sql` в порядке появления. Для типов, отличных от `query`, возвращает `[]`.
  - `orderParams(defs: TemplateParam[]): TemplateParam[]` — топологический порядок: родители раньше детей, при равенстве сохраняется исходный порядок. Бросает `AppError('VALIDATION', 400, 'неверные параметры', [{ path: '<i>.sql', message }])`. Формат `details` сверьте с тем, что уже понимает `fieldErrors()` на фронте: пути вида `0.name` используются в существующих ошибках схем.

- [ ] **Step 1: Модульные тесты**

```ts
import { describe, expect, it } from 'vitest';
import type { TemplateParam } from '@carbone-reports/shared';
import { orderParams, paramRefs } from './param-deps';

const p = (name: string, sql: string | null = null): TemplateParam => ({
  name, label: name, type: sql === null ? 'string' : 'query', required: false,
  defaultValue: null, options: null, sql, multiple: false,
});

describe('paramRefs', () => {
  it('берёт уникальные :имена, игнорирует ::cast и строки', () => {
    expect(paramRefs(p('c', "select id from t where r = :region and d > :from::date and x = ':nope' and r2 = :region"))).toEqual(['region', 'from']);
  });
  it('не-query → []', () => expect(paramRefs(p('s'))).toEqual([]));
});

describe('orderParams', () => {
  it('родители раньше детей, остальное в исходном порядке', () => {
    const out = orderParams([p('city', 'select 1 where :region = 1'), p('x'), p('region', 'select 1')]);
    expect(out.map((d) => d.name)).toEqual(['x', 'region', 'city']);
  });
  it('неизвестная ссылка — ошибка у строки', () => {
    expect(() => orderParams([p('a'), p('c', 'select :zzz')])).toThrow(expect.objectContaining({
      code: 'VALIDATION', details: [{ path: '1.sql', message: 'неизвестный параметр :zzz' }],
    }));
  });
  it('ссылка на себя', () => {
    expect(() => orderParams([p('a', 'select :a')])).toThrow(expect.objectContaining({
      details: [{ path: '0.sql', message: 'параметр не может ссылаться на себя' }],
    }));
  });
  it('цикл', () => {
    expect(() => orderParams([p('a', 'select :b'), p('b', 'select :a')])).toThrow(expect.objectContaining({
      details: [expect.objectContaining({ message: 'циклическая зависимость: a → b → a' })],
    }));
  });
});
```
Если `paramRefs` для синтаксически неверного SQL (незакрытая кавычка) бросает `SqlParamError`, переведите это в VALIDATION у строки с текстом ошибки парсера.

- [ ] **Step 2: Реализация**

`param-deps.ts`: `paramRefs` через `parseSqlParams(def.sql).names` с удалением дублей. `orderParams`:
1. собрать карту имя → индекс;
2. для каждой строки проверить ссылки (неизвестная, на себя);
3. отсортировать алгоритмом Кана, сохраняя исходный порядок среди готовых;
4. если остались вершины, найти цикл обходом в глубину от первой оставшейся и вывести путь `a → b → a`; путь ошибки — первая вершина цикла.

- [ ] **Step 3: PUT params**

В `templates/routes.ts`, в `PUT /api/templates/:id/params`, после `uniqueOrFail` и до `checkParamDefaults`: `orderParams(req.body);` (только проверка, порядок хранения не меняется).

`checkParamDefaults` для `query` не проверяет значения по умолчанию: варианты станут известны только при генерации. Проверяется только форма значения (массив допустим лишь при `multiple`), и это уже делает схема. Убедитесь, что `checkValue` в `params.ts` не падает на типе `query`. Полную проверку добавит Task 3, пока достаточно `return null` для `query`.

Интеграционный тест в `templates.int.test.ts` (Review Focus 5):
```ts
it('PUT params с циклом → 400 у строки, сохранённые параметры не меняются', async () => {
  // сначала сохранить корректный набор, затем отправить цикл и проверить, что GET вернул прежний набор
});
```
Тело теста:
1. `PUT` с корректным набором `[region(query, 'select 1'), city(query, 'select 1 where :region = 1')]` возвращает 200.
2. `PUT` с `[a(query, 'select :b'), b(query, 'select :a')]` возвращает 400, и в `details` есть путь `0.sql` или `1.sql` с текстом «циклическая зависимость».
3. `GET /api/templates/:id` (админ) по-прежнему возвращает `region` и `city`.

Используйте хелперы этого файла: `createTemplate`, cookie админа.

- [ ] **Step 4: Прогон, гейты, коммит**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api test:int
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/api
git commit -m "feat(api): query param dependency graph validated on save"
```

---

### Task 3: Варианты, строгая проверка, эндпоинт

**Files:**
- Modify: `apps/api/src/modules/queries/executor.ts`, `apps/api/src/modules/queries/params.ts`, `apps/api/src/modules/reports/service.ts`, `apps/api/src/modules/reports/routes.ts` (предпросмотр и render), `apps/api/src/modules/templates/routes.ts` (эндпоинт и `toDetails`), `apps/api/src/modules/templates/service.ts` (если `toDetails` там)
- Create: `apps/api/src/modules/queries/param-options.ts`, `apps/api/test/param-options.int.test.ts`

**Interfaces:**
- Consumes: `orderParams`, `paramRefs` (Task 2); `MAX_PARAM_OPTIONS`, `SelectOptionValue` (Task 1).
- Produces:
  - `rowsToOptions(columns: string[], rows: Record<string, unknown>[]): SelectOptionValue[]`: колонки `value`/`label`, иначе первая и вторая, иначе первая для обоих. `value` берётся как есть, если это `string` или `number`, иначе `String(v)`; `bigint`/`numeric` уже приходят числом или строкой. Подпись — `String(label ?? value)`.
  - `loadParamOptions(pool, sourceName, items: { def: TemplateParam; params: Record<string, ParamValue> }[], limits): Promise<SelectOptionValue[][]>` — в одной read-only транзакции, лимит `MAX_PARAM_OPTIONS + 1`, при превышении `TOO_MANY_OPTIONS`.
  - `validateQueryParams(deps, full, resolved): Promise<void>` — строгая проверка, обход в порядке `orderParams`, накопление ошибок у полей.
  - `optionsForParam(deps, full, name, input): Promise<ParamOptionsResult>`.
  - Эндпоинт `POST /api/templates/:id/params/:name/options` (requireUser), тело `ParamOptionsBody`. Ответы: 404, если параметра нет или его тип не `query`; иначе `ParamOptionsResult`.

- [ ] **Step 1: Типовая проверка в `resolveParams`**

`checkValue` для `query`:
- если `multiple`: значение — массив строк или чисел (`ScalarValue`), иначе «ожидается список значений». Пустой массив считается пустым значением: для обязательного параметра это «обязательный параметр»;
- иначе: `string | number`, иначе «ожидается одно значение».

`isEmpty` учитывает `[]`.

Для остальных типов массив даёт «недопустимое значение». Модульные тесты в `params.test.ts`: эти случаи плюс массив у `string`.

- [ ] **Step 2: Загрузка вариантов**

В `executor.ts`:
```ts
export function rowsToOptions(columns: string[], rows: Record<string, unknown>[]): SelectOptionValue[] { ... }

export function loadParamOptions(
  pool: pg.Pool,
  sourceName: string,
  items: { def: TemplateParam; params: Record<string, ParamValue> }[],
  limits: QueryLimits,
): Promise<SelectOptionValue[][]> {
  return withReadOnly(pool, sourceName, limits.timeoutMs, async (tx) => {
    const out: SelectOptionValue[][] = [];
    for (const { def, params } of items) {
      const key = `параметр "${def.label}"`;
      const r = await readQuery(tx.client, key, def.sql!, params, MAX_PARAM_OPTIONS);
      await tx.guard(key);
      if (r.truncated) throw new AppError('TOO_MANY_OPTIONS', 400, `${key}: больше ${MAX_PARAM_OPTIONS} вариантов — уточните запрос`);
      out.push(rowsToOptions(r.columns, r.rows));
    }
    return out;
  });
}
```
`readQuery(client, key, sql, params, limit)` уже возвращает `truncated`, если строк больше `limit`. Сверьте семантику: если `truncated` означает «прочитано `limit + 1`», передавайте `MAX_PARAM_OPTIONS` как `limit`.

Модульные тесты на `rowsToOptions` (все три формы колонок, `null` в подписи).

- [ ] **Step 3: Строгая проверка и варианты**

`param-options.ts`:
```ts
export async function validateQueryParams(deps: AppDeps, full: TemplateFull, resolved: Record<string, ParamValue>): Promise<void> {
  const order = orderParams(full.params).filter((d) => d.type === 'query');
  if (order.length === 0) return;
  const toCheck = order.filter((d) => !isEmptyValue(resolved[d.name]));
  if (toCheck.length === 0) return;
  const { pool, name } = await deps.sources.get(full.row.datasourceId);
  const lists = await loadParamOptions(pool, name, toCheck.map((def) => ({ def, params: resolved })), limitsOf(deps));
  const fields: Record<string, string> = {};
  toCheck.forEach((def, i) => {
    const allowed = new Set(lists[i]!.map((o) => String(o.value)));
    const vals = Array.isArray(resolved[def.name]) ? (resolved[def.name] as (string | number)[]) : [resolved[def.name] as string | number];
    if (!vals.every((v) => allowed.has(String(v)))) fields[def.name] = 'значение недоступно';
  });
  if (Object.keys(fields).length) throw new AppError('VALIDATION', 400, 'неверные параметры', { fields });
}
```
Проверка идёт в порядке зависимостей, но все запросы выполняются в одном `loadParamOptions`. Значения родителей уже прошли типовую проверку, а их недопустимость отразится у самого родителя. Ребёнок при этом выполняет свой SQL с недопустимым значением родителя, и это безопасно: SQL только читает, а значения передаются параметрами.

`optionsForParam(deps, full, name, input)`:
1. Найти определение параметра: нет такого или тип не `query` — `notFound('параметр')`.
2. Родители — это `paramRefs(def)`. Для каждого взять значение из `input` с типовой проверкой. Для этого вынесите из `resolveParams` функцию проверки одного параметра; ошибки по родителям здесь не бросаются. Пустое значение заменить на `defaultValue`.
3. Если значение родителя пустое или типово неверное и родитель обязателен — добавить его имя в `waitingFor`.
4. Если `waitingFor` не пуст — вернуть `{ options: [], waitingFor }`.
5. Иначе выполнить `loadParamOptions` с родителями: пустые необязательные передаются как `null`.

`ParamOptionsResult` и `collectReportData` (`reports/service.ts`): после `resolveParams` вызвать `await validateQueryParams(deps, full, params)`. Проверьте, что предпросмотр (`/preview`) и `paramsForErrorRun` проходят через тот же путь. Ошибки проверки параметров не должны создавать запуск со статусом `error`: сверьтесь, как сейчас `VALIDATION` от `resolveParams` обходит запись запуска, и сделайте так же (Review Focus 2).

- [ ] **Step 4: Эндпоинт и DTO пользователя**

```ts
  app.post(
    '/api/templates/:id/params/:name/options',
    { ...anyUser, schema: { params: z.object({ id: z.uuid(), name: z.string() }), body: ParamOptionsBody } },
    async (req) => {
      const full = await loadTemplateFull(db, req.params.id);
      return optionsForParam(deps, full, req.params.name, req.body.params);
    },
  );
```
- **DTO пользователя.** В `toDetails` (не в админском DTO) у параметров `sql: null`.
- **Поле `dependsOn: string[]`.** Добавьте его в DTO параметров (в `toDetails` и в `toAdminDetails`), вычисляя через `paramRefs`. Пользователь не видит SQL, а интерфейсу нужны зависимости.
- **Тип DTO в shared.** Объявите `TemplateParamDto = TemplateParam & { dependsOn: string[] }` и используйте его в `TemplateDetails` и `TemplateAdminDetails`. `PUT params` по-прежнему принимает `TemplateParam`.

- [ ] **Step 5: Интеграционные тесты**

`apps/api/test/param-options.int.test.ts` с источником, у которого таблицы `regions(id, name)` и `cities(id, region_id, name)`. Строки: регион 1 с городами 10, 11 и регион 2 с городом 20. Шаблон:
- параметр `region`: query, required, `select id as value, name as label from regions order by id`;
- параметр `city`: query, `select id as value, name as label from cities where region_id = :region order by id`;
- параметр `cities`: query, `multiple`, тот же SQL, необязательный;
- запрос отчёта `select count(*)::int as n from cities where id = any(:cities)` в режиме `single`.

Поддельный Carbone возвращает JSON данных, как в `reports.int.test.ts`. Тесты:
1. Варианты `region` → два варианта. `city` без `region` → `{ options: [], waitingFor: ['region'] }`. `city` с `region: 1` → города 10 и 11.
2. Генерация `{ region: 1, city: 10 }` → 201.
3. Генерация `{ region: 2, city: 10 }` → 400, `fields.city = 'значение недоступно'`, новых запусков в истории нет (Review Focus 1, 2).
4. Генерация `{ region: 1, cities: [10, 11] }` → 201, в данных `n = 2`. Генерация `{ region: 1, cities: [10, 20] }` → 400 у `cities` (Review Focus 4).
5. `cities` не задан и необязателен → 201, в SQL отчёта `any(null)` даёт `n = 0`.
6. SQL параметра с синтаксической ошибкой → `options` отвечает 400 с текстом ошибки SQL, генерация отвечает тем же кодом (Review Focus 3).
7. Больше 1000 вариантов (`select g from generate_series(1, 1001) g`) → 400 `TOO_MANY_OPTIONS`.
8. В карточке шаблона пользователь получает `sql: null`, админ — текст SQL. У `city` и пользователь, и админ получают `dependsOn: ['region']`.
9. `options` для несуществующего параметра или параметра не-`query` → 404.

- [ ] **Step 6: Прогон, гейты, коммит**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api test:int
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/api
git commit -m "feat(api): query param options endpoint and strict validation"
```

---

### Task 4: Интерфейс

**Files:**
- Modify:
  - `apps/web/src/api/endpoints.ts`;
  - `apps/web/src/components/ParamForm.tsx` и `ParamForm.test.tsx` (если теста нет, создать);
  - `apps/web/src/lib/params.ts`;
  - `apps/web/src/pages/ReportRunPage.tsx`;
  - `apps/web/src/pages/admin/template-editor/{ParamsTab,DataTab,PreviewTab}.tsx` и их тесты.

**Interfaces:**
- Consumes:
  - `POST /api/templates/:id/params/:name/options` → `ParamOptionsResult`;
  - поле `dependsOn: string[]` в DTO параметров (Task 3), тип `TemplateParamDto`.
- Produces:
  - `api.templates.paramOptions(id, name, params)`;
  - `ParamForm` получает проп `templateId: string`.

- [ ] **Step 1: Падающие тесты формы**

`ParamForm.test.tsx` (или тест `ReportRunPage`), моки через `mockApi`:
1. `city` зависит от `region`. До выбора региона поле `city` неактивно и показывает текст «сначала выберите: Регион».
2. После выбора региона 1 запрос `options` для `city` уходит с `params.region = 1`, варианты отображаются.
3. Город 10 выбран, затем регион сменён на 2, а для региона 2 варианты `[20]`. Значение `city` сбрасывается в `null`, и в `onChange` уходит `city: null` (Review Focus 1).
4. При `multiple` можно выбрать два значения, в `onChange` уходит массив.
5. `options` вернул 400 → у поля текст ошибки сервера (Review Focus 3).

- [ ] **Step 2: Реализация формы**

- **`QueryParamField`** внутри `ParamForm.tsx`.
  - `useQuery({ queryKey: ['param-options', templateId, param.name, parentValues], queryFn, enabled: parentsReady })`, где `parentValues` — значения `dependsOn` из `values`.
  - `Select` с `filterable`, `multiple={param.multiple}`, `hasClear={!param.required}`, `loading`, `disabled={!parentsReady || disabled}`.
  - Значения в `Select` — строки (`String(value)`). Обратно в форму возвращается исходный тип из варианта: число или строка.
  - Подсказка `сначала выберите: <label родителей>`, если ответ `waitingFor` не пуст или родитель не заполнен.
  - Ошибка запроса показывается через `error` у `Field`.
- **Сброс недоступных значений.** Эффект после загрузки вариантов: если текущее значение (или элементы массива) не входит в варианты, вызвать `onChange` с отфильтрованным значением или `null`. Не вызывать `onChange`, если ничего не изменилось: иначе получится цикл ререндеров.
- **`ParamForm`.** Проп `templateId` прокидывается во все места использования: `ReportRunPage`, `DataTab` (тестовые параметры), `PreviewTab`.
- **`lib/params.ts`.** `initialValues` и `pickParams` поддерживают массивы.

- [ ] **Step 3: Редактор параметров**

`ParamsTab.tsx`:
- в выборе типа появляется «SQL-список» (`query`);
- для него показываются: редактор SQL (`CodeEditor`, язык `sql`, высота около 120px), флажок «множественный выбор» и строка «зависит от: …», вычисленная локально из SQL простым регэкспом `/(?<![:\w]):([A-Za-z_]\w*)/g` с исключением `::`. Это только подсказка, источник правды — сервер;
- кнопка «Проверить» доступна для сохранённого шаблона: она вызывает `options` с тестовыми параметрами (`useTestParams`) и показывает первые 20 вариантов и их общее число либо ошибку. Если параметр ещё не сохранён, кнопка неактивна с подсказкой «сохраните параметры»;
- ошибки сервера с путём `<i>.sql` показываются у поля SQL строки `i`.

`fieldErrors` уже поддерживает пути `0.name`. Проверьте, что `0.sql` ложится на нужное поле.

Тесты в `ParamsTab.test.tsx`:
- выбор типа «SQL-список» показывает поле SQL и флажок;
- `PUT` уходит с `sql` и `multiple`;
- ошибка `1.sql` показывается у второй строки.

Monaco в тестах замокан, см. существующие тесты.

- [ ] **Step 4: Прогон, гейты, коммит**

```bash
pnpm --filter @carbone-reports/web test
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/web apps/api packages/shared
git commit -m "feat(web): SQL list params with dependent options"
```

---

### Task 5: Демо и E2E

**Files:**
- Modify: `demo/template.ts` (`DEMO_PARAMS`), `scripts/demo-seed.ts` (если нужно), `e2e/tests/*.spec.ts`, `docs/superpowers/notes/2026-10-02-backend-follow-ups.md`, `README.md` (если описывает параметры)

**Interfaces:**
- Демо-шаблон «Счёт (демо)» получает параметры:
  - `companyId` — query, обязательный, подпись «Компания»: `select id as value, name as label from company order by id`;
  - `invoiceId` — query, обязательный, подпись «Счёт»: `select id as value, number as label from invoices where company_id = :companyId order by id`.

  Значения по умолчанию: `companyId = 1`, `invoiceId = 1`. Запросы отчёта не меняются, они используют `:invoiceId`.

- [ ] **Step 1: Демо**

Обновите `DEMO_PARAMS`, добавив поля `sql` и `multiple` всем параметрам. `demo:seed` должен идемпотентно приводить параметры к новому эталону, и он это уже делает через `PUT params`.

- [ ] **Step 2: E2E**

- **Существующие тесты, которые полагаются на `invoiceId` как на число.** Сценарий пользователя: генерация со значениями по умолчанию должна по-прежнему давать счёт 1. Global setup сбрасывает параметры к `DEMO_PARAMS`.
- **Новый тест `e2e/tests/sql-params.spec.ts`:**
  1. пользователь (через `loginAdminUi` — админ, этого достаточно) открывает отчёт «Счёт (демо)»;
  2. выбирает «Компания» → «АО «Лютик»»;
  3. проверяет, что в «Счёт» доступен только `СЧ-002`;
  4. выбирает его и формирует DOCX;
  5. проверяет, что в нём есть `СЧ-002` и «Стол офисный».

  Затем сменить компанию обратно на «ООО «Ромашка»» и проверить, что «Счёт» сброшен или заменён на `СЧ-001`.
- Нарушений CSP нет (проверяет фикстура).

- [ ] **Step 3: Живой прогон**

```bash
df -h /System/Volumes/Data | tail -1
pnpm stack:demo
pnpm e2e && pnpm e2e
BASE_URL=https://localhost:${WEB_HTTPS_PORT:-443} pnpm stack:smoke -- --insecure
docker compose --profile demo down
```
Expected: E2E зелёные дважды подряд, smoke зелёный. Удалите висячие образы `carbone-reports`.

- [ ] **Step 4: Документация, коммит**

- **README:** короткий раздел о параметре «SQL-список» — колонки `value`/`label`, зависимость через `:имя`, `= any(:param)` для множественного выбора, лимит 1000 вариантов, строгая проверка.
- **Заметка:** «Итоги Плана 7».

```bash
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add demo scripts e2e README.md docs/superpowers/notes
git commit -m "test(e2e): dependent SQL params in demo; docs"
```
