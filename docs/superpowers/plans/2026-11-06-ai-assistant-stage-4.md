# ИИ-ассистент, этап 4 (формирование в таблице) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** при той же возможности, что §52 (лицензия с Automation API, проверка сервера и браузера), ассистент формирует табличный шаблон (xlsx, ods) прямо в активном листе редактора по кнопке автора: фрагмент/таблица у активной ячейки, лист по описанию (простая таблица или с подитогами), шаблон из заполненной таблицы.

**Architecture:** итоги и подитоги считает Carbone (агрегаторы §31.1, вложенный массив строк группы из `json_agg`), числа и даты остаются числами и датами (`:formatN`, `:cellDate` §54) — приём закрепляется тестом рендера. Сервер получает снимок активного листа (`page.editor.sheet`), проверяет ключи/колонки (`queries/check` и новая пробная строка `queries/probe` для вложенных колонок) и сам строит раскладку ячеек (`SheetLayout`) или план замен (`SheetReplaceTable`); модель задаёт только ключ, колонки и группировку. Вкладка «Документ» для xlsx/ods регистрирует в мосте адаптер листа поверх того же connector; адаптер только исполняет раскладку фиксированным набором стилей.

**Tech Stack:** Fastify 5 + zod (API), React 19 + Gravity UI + `@onlyoffice/document-editor-react` 2.2.0 (веб), vitest, mocha (`packages/carbone`).

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §53 (опирается на §52, §51, §31.1, §54).

## Global Constraints

- Ветка `feat/ai-assistant`; в main не сливается, тегов и выпусков нет; ветку не переключать, `/Users/sam/carbone-reports-dates` не трогать. Новых npm-зависимостей нет.
- Только `xlsx`, `ods`, только активный лист. Инструменты §52 — по-прежнему только `docx`/`odt`; инструменты §53 — только `xlsx`/`ods`; `pptx` — как в §51.
- Без возможности (§52.2) — ни кнопок, ни упоминаний, ни инструментов этапа 4; промпт о формировании в таблице не говорит.
- Ассистент только предлагает: лист меняется только кнопкой автора через Automation API (Ctrl+Z, обычное сохранение §38). Сервер файл не правит.
- Итоги — только агрегаторы Carbone (`aggSum`, `aggCount`, `aggAvg`, `aggMin`, `aggMax`), никаких формул Excel: тексты, начинающиеся с `=`, сервер отклоняет. Диаграмм, сводных, условного форматирования, закрепления, печатных настроек нет.
- Теги ставит сервер: целое → `:formatN(0)`, дробное/деньги → `:formatN(2)`, дата → `:cellDate`, текст — без форматтера; агрегатор → `:aggX:formatN(n)` (`aggCount` — 0 знаков, `aggAvg` — 2, прочие — по типу колонки). Форматтер типа — последний и единственный тег в ячейке.
- `SHEET_SNAPSHOT_LIMITS`: ячеек ≤ 5000, ячейка ≤ 500 символов, сумма ≤ 30 000 символов (пустые ячейки в снимок не входят), используемая область ≤ 500 строк × 50 колонок; сверх — `truncated: true`. `page.editor.sheet` и `page.editor.document` взаимоисключающи.
- Лимиты инструментов: `propose_sheet` — `header` ≤ 20, `columns` 1..20, `group` 1..5; `propose_sheet_replacements` — `items` ≤ 100; карточек ≤ 5; авторский режим — 12 вызовов.
- Схемы инструментов для модели: `type` — всегда одна строка (GigaChat не принимает массив `type`, `anyOf`, `oneOf`); «без колонки» — пустая строка; варианты таблицы — одним объектом с необязательными полями.
- Адаптер: очередь команд, таймаут команды 10 с, снимок для чата — 3 с; код `callCommand` без замыканий, данные через `Asc.scope`, ошибки возвращаются результатом `{error}`.
- Тексты интерфейса — во всех семи каталогах `packages/shared/src/i18n/{ru,en,es,pt-BR,fr,de,zh-CN}`; `pnpm i18n:check`; кириллицы в коде веба и аргументах `AppError` нет; ключи `common:assistant.*` плоские.
- Точные тексты (ru): «Вставить в таблицу», «Сформировать лист», «Заменить содержимое листа? Отменить можно через Ctrl+Z», «Перезаписать непустые ячейки? Отменить можно через Ctrl+Z» (текст плана — спецификация его не задаёт), «Итого», «Итого по группе»; история — «Предложен лист: <ключ запроса>», «Предложены замены: N значений, таблица» (без таблицы — «Предложены замены: N значений»); уведомления и подсказка просмотра — те же ключи, что §52 («Изменено в документе», «Не удалось изменить документ», «Чтобы изменить документ, начните редактирование»); предупреждение администратору — «Если OnlyOffice поддерживает формирование в документе, модели также передаётся текст документа или таблицы шаблона, открытых в редакторе».
- Clean-room: код Carbone EE не читать (поведение — по §31.1 и своим тестам). `.env`, `certs/`, конфиг Document Server не читать.
- Node: `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH`; в zsh глобы в кавычках. Наборы тестов не запускать одновременно; веб — `--maxWorkers=2`; `render-onlyoffice.int.test.ts` не запускать. Ошибки lint в `cades/cadesplugin_api.js` — локальный шум.
- Комментарии — по-русски, в стиле окружающего кода. Каждый коммит заканчивается отдельным `-m`: `"Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"`.

## Review Focus

1. Числовая ячейка примера показывает «1 234,50», а хранит 1234.5: `find`, равный всему отображаемому тексту, заменяет значение ячейки тегом целиком; частичный `find` в числовой ячейке — «не найдено», число не портится (тест в Task 8).
2. Подпись, заголовок или значение шапки от модели начинается с `=` (`=SUM(B2:B9)`): сервер отклоняет с ошибкой модели, в лист формула не попадает (тест в Task 6; `propose_sheet_replacements` — Task 7).
3. Запрос групп с `where date between :from and :to` при пустых параметрах пробы возвращает 0 строк: вложенные колонки не проверяются, путь принимается, раскладка строится, тип неизвестных вложенных колонок — `decimal` для `subtotal`/`total`, иначе `text` (тест в Task 6).
4. В `sheetReplace` таблица снята галочкой или не нашлась по отпечатку: адреса `items` ниже таблицы не сдвигаются (тест в Task 8).
5. Используемая область не с A1 и за колонкой Z (`C3:AB40`): снимок, разбор адресов, номера строк и отпечаток таблицы верны (тесты в Task 3 и Task 8).

---

### Task 1: Слить `origin/main` (§54 `:cellDate`) в `feat/ai-assistant`

**Files:** слияние; конфликты — `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, возможно `CHANGELOG.md`.

- [ ] **Step 1:** `git fetch origin && git log --oneline origin/main -10` и `git grep -n cellDate origin/main -- packages/carbone/lib` — если `cellDate` в `origin/main` нет, остановиться и сообщить контроллеру (§54 ещё не влит; дальше Task 2 не проверяем).
- [ ] **Step 2:** `git merge origin/main`. Конфликт спецификации: в результате разделы по порядку номеров — §49, §50, §51, §52, §53, §54 (текст §50–53 из ветки, §54 из main, без потерь). `CHANGELOG.md` `[Unreleased]` — оба набора пунктов. Прочие конфликты — сообщить контроллеру, не решать наугад.
- [ ] **Step 3: Проверка.** `grep -c "^## 5[0-4]\." docs/superpowers/specs/2026-10-02-carbone-reports-design.md` → 5, номера по возрастанию (`grep -n "^## 5"`); `pnpm --filter @carbone-reports/carbone test` — PASS (есть тесты `cellDate`); `pnpm -r typecheck` — PASS.
- [ ] **Step 4: Commit** — коммит слияния `merge: origin/main (§54 cellDate) into feat/ai-assistant` с абзацем атрибуции.

### Task 2: Тест рендера Carbone: простая таблица, итог и подитоги в xlsx и ods

**Files:**
- Create: `packages/carbone/test/test.sheet-forming.js`
- Modify: `packages/carbone/test/golden-lib.js` (только если нет подходящего сборщика: `buildXlsx(sheetXml)` — минимальная книга с одним листом и inline-строками, по образцу `buildXlsxWithChart`; ods — существующий `buildOdf('ods', …)`)

**Interfaces:**
- Produces: решение о приёме подитогов для Task 5 — «агрегаторы» (ожидаемо) или «стоп» (см. Step 4).

Данные теста: `GROUPS = [{contractor: 'Альфа', rows: [{date: '2026-01-05', sum: 100.5, qty: 2}, {date: '2026-01-07', sum: 50, qty: 1}]}, {contractor: 'Бета', rows: [{date: '2026-02-01', sum: 10.25, qty: 3}]}]`, опции `{lang: 'ru', timezone: 'Europe/Moscow'}`; рендер через `renderBuffer` полного файла (чтобы работал препроцессор ячеек), разбор `xl/worksheets/sheet1.xml` / `content.xml`.

- [ ] **Step 1: Тесты (по `describe` на xlsx и ods):**
  - простая таблица: шапка, строка `{d.list[i].date:cellDate}` `{d.list[i].sum:formatN(2)}` `{d.list[i].qty:formatN(0)}`, строка `[i+1]` → 3 строки данных; ячейки сумм — числа (xlsx `t="n"`, `<v>100.5</v>`; ods `office:value-type="float"`, `office:value="100.5"`), даты — даты (xlsx — серийный номер `46027` для 2026-01-05; ods `office:value-type="date"`, `office:date-value="2026-01-05"`);
  - итог под таблицей `{d.list[].sum:aggSum:formatN(2)}` → число `160.75`; `{d.list[].qty:aggCount:formatN(0)}` → `3`;
  - подитоги §53.2: строка группы `{d.groups[i].contractor}`, вложенная `{d.groups[i].rows[i].date:cellDate}`/`…sum:formatN(2)`, служебная `{d.groups[i].rows[i+1].date}`, подитог `{d.groups[i].rows[].sum:aggSum:formatN(2)}`, служебная группы `{d.groups[i+1].contractor}`, общий итог `{d.groups[].rows[].sum:aggSum:formatN(2)}` → порядок строк «Альфа, 100.5, 50, 150.5, Бета, 10.25, 10.25, 160.75», подитоги и итог — числовые ячейки.
- [ ] **Step 2:** Запустить `pnpm --filter @carbone-reports/carbone exec mocha test/test.sheet-forming.js --timeout 20000 --exit`. Ожидается PASS без правок движка (приём опирается на §31.1 «по вложенному массиву» и §54).
- [ ] **Step 3:** Если падает только сборка теста (неверный XML) — исправить тест. Движок ради подитогов не правится (§53.2).
- [ ] **Step 4: Ветвление по результату.** Подитог или общий итог выводится неверно → не продолжать Task 5–7: зафиксировать фактический вывод в тесте как `it.skip` с комментарием и сообщить контроллеру — по §53.2 подитог тогда берётся полем SQL запроса групп, а форма аргументов `subtotal`/`total` уточняется в спецификации с владельцем. При PASS — ничего не менять.
- [ ] **Step 5: Commit** `test(carbone): sheet tables with totals and subtotals render numbers and dates (§53)`.

### Task 3: Общие типы: снимок листа, раскладка, карточки `sheet`/`sheetReplace`, проба запроса

**Files:**
- Create: `packages/shared/src/sheet.ts`, `packages/shared/src/sheet.test.ts`
- Modify: `packages/shared/src/index.ts` (`export * from './sheet'`, `EditorDraft`), `packages/shared/src/assistant.ts` (`Card`, `QueryProbe`), `packages/shared/src/index.test.ts`

**Interfaces (Produces):**
- `parseRef(ref: string): {row: number; col: number} | null` (0-based; `'A1'` → `{0,0}`, `'AB40'` → `{row: 39, col: 27}`; регистр важен — только заглавные, `$` не принимается); `toRef(row: number, col: number): string`; `parseRange(range: string): {top; left; bottom; right} | null` (`'C3:AB40'`; одиночная ячейка `'A1'` — диапазон 1×1).
- `SHEET_SNAPSHOT_LIMITS = {cells: 5000, cell: 500, chars: 30_000, rows: 500, cols: 50} as const`.
- zod `SheetSnapshot = {name: string ≤ 200; cells: {ref, text ≤ 500}[] ≤ 5000; usedRange: string; active: string; truncated: boolean}`; `superRefine`: `ref`/`active` разбираются `parseRef`, `usedRange` — `parseRange` и не больше 500×50, сумма длин `text` ≤ 30 000, `ref` не повторяются.
- `SheetCellKind = 'text'|'integer'|'decimal'|'date'`; `SheetCellStyle = 'plain'|'title'|'label'|'header'|'group'|'data'|'subtotal'|'total'`; `SheetLayoutCell = {row: number; col: number; value: string; kind: SheetCellKind; style: SheetCellStyle}` (координаты от левого верхнего угла раскладки); `SheetLayout = {rows: number; cols: number; cells: SheetLayoutCell[]; widths: number[]}` (`widths` — в символах, по колонке).
- `EditorDraft` += `sheet: SheetSnapshot.optional()`; `.refine(d => !(d.sheet && d.document))`.
- В `assistant.ts`: `SheetReplaceItem = {ref: string; find: string; tag: string; note?: string}`; `SheetReplaceRow = {styleFrom: number; cells: (string | null)[]}` (`styleFrom` — 0-based строка примера, чьё оформление и текст берутся; `null` — оставить текст ячейки `styleFrom`); `SheetReplaceTable = {key: string; grouped: boolean; firstCol: number; headerRow: number; firstDataRow: number; lastDataRow: number; fingerprint: {header: string[]; columns: number; sample: string[]}; rows: SheetReplaceRow[]; totals: {row: number; cells: {col: number; tag: string}[]} | null}` (все номера 0-based).
- `Card` += `{type: 'sheet'; templateId; templateName; key: string; layout: SheetLayout; explanation}` | `{type: 'sheetReplace'; templateId; templateName; items: SheetReplaceItem[]; table: SheetReplaceTable | null; explanation}`; карточка `table` += `layout?: SheetLayout`.
- `QueryProbe = {ok: true; sampled: boolean; nested: {column: string; columns: QueryCheckColumn[]}[]} | {ok: false; error: string}` (типы вложенных колонок: `'number'|'date'|'text'|'boolean'`).

- [ ] **Step 1: Тесты `sheet.test.ts`:** `parseRef('A1')`, `'Z9'`, `'AA10'` → `{row: 9, col: 26}`, `'AX500'` → `{row: 499, col: 49}`; `'a1'`, `'A0'`, `'1A'`, `'$A$1'` → null; `toRef(parseRef(x))` === x для `A1, Z9, AA10, AX500`; `parseRange('C3:AB40')` → `{top: 2, left: 2, bottom: 39, right: 27}`. `SheetSnapshot` принимает пример с `usedRange: 'C3:AB40'`; отклоняет 5001 ячейку, ячейку 501 символ, сумму 30 001, область `A1:A501` и `A1:AY1`, повтор `ref`, `ref` `'a1'`.
- [ ] **Step 2: Тест `index.test.ts`:** `EditorDraft` с `sheet` валиден; с `sheet` и `document` — нет; без обоих — валиден, как раньше.
- [ ] **Step 3:** FAIL → реализовать → PASS (`pnpm --filter @carbone-reports/shared exec vitest run`), `pnpm -r typecheck` (исчерпывающие `switch` по `Card` в вебе — заглушка `return null` с комментарием «Task 10»).
- [ ] **Step 4: Commit** `feat(shared): sheet snapshot, layout and sheet/sheetReplace cards`.

### Task 4: Сервер: пробная строка запроса, вложенные пути тегов, `documentAutomation` для таблиц

**Files:**
- Modify: `apps/api/src/modules/queries/executor.ts` (`probeQuery`), `apps/api/src/modules/schema/routes.ts`, `apps/api/test/schema.int.test.ts`, `apps/api/src/modules/assistant/tag-paths.ts`, `tag-paths.test.ts`, `apps/api/src/modules/onlyoffice/routes.ts`, `apps/api/test/onlyoffice.int.test.ts`

**Interfaces:**
- Consumes: `QueryProbe`, `CheckQueryBody` (Task 3).
- Produces: `probeQuery(pool, sourceName, sql, timeoutMs, locale): Promise<QueryProbe>` — `select * from (<sql>) q limit 1` в `withReadOnly` с тем же таймаутом и `assertReadOnly`, параметры — `null`, как `checkQuery`; `sampled` — вернулась ли строка; `nested` — колонки, чьё значение в строке — массив (в том числе пустой): `columns` — объединение ключей первых ≤ 50 элементов-объектов (≤ 50 ключей), тип по первому не-null значению: число → `number`, строка `^\d{4}-\d{2}-\d{2}` → `date`, логическое → `boolean`, иначе `text`. Значения строки из функции не выходят.
- Produces: `POST /api/templates/:id/queries/probe` (тело `CheckQueryBody`, `requireTemplateEdit`, как `queries/check`) → `QueryProbe`; ошибки SQL/таймаут — `{ok: false, error}` как у `checkQuery`.
- Produces в `tag-paths.ts`: путь `d.<key>[idx].<col>[idx2].<sub>` — если у ключа есть вложенный путь, `col` проверяется по `queries/check`, а `sub` — по `nested` пробы этого запроса (кэш на вызов чекера; проба зовётся, только если в тексте есть вложенный сегмент). `idx`/`idx2` — `i`, `i+1` или пусто (`[]`). Проба `ok:false`, `sampled:false` или `columns: []` → `sub` не проверяется. `sampled` и `col` не среди `nested` → ошибка `"<col>" of "<key>" is not a nested array of rows; build it with json_agg(json_build_object(...))`.
- Produces: `editor-config` отдаёт `documentAutomation: true` и для `xlsx`/`ods` (условие — `fileExt ∈ {docx, odt, xlsx, ods}` ∧ probe); `pptx` — false.

- [ ] **Step 1: Тесты `schema.int.test.ts`:** проба `select 'A' as c, json_agg(json_build_object('date', d, 'sum', s)) as rows from (values ('2026-01-05'::date, 1.5::numeric)) v(d, s)` → `{ok: true, sampled: true, nested: [{column: 'rows', columns: [{name: 'date', type: 'date'}, {name: 'sum', type: 'number'}]}]}`, в ответе нет значений (`JSON.stringify` не содержит `'1.5'` и `'A'`); `where false` → `sampled: false, nested: []`; запрос на запись → `ok: false`; без права правки — 403.
- [ ] **Step 2: Тесты `tag-paths.test.ts`** (фейковый `inject` отвечает на `/queries/check` и `/queries/probe`): `{d.groups[i].rows[i].sum}` и `{d.groups[].rows[].sum:aggSum}` при вложенной `sum` → null; `{d.groups[i].rows[i].nope}` → ошибка с `nope`; `rows` не массив при `sampled: true` → ошибка с `json_agg`; `sampled: false` → любая вложенная колонка принята; текст без вложенных сегментов не вызывает `/queries/probe`.
- [ ] **Step 3: Тест `onlyoffice.int.test.ts` (`describe('editor-config')`):** xlsx и ods + probe true → `documentAutomation: true`; pptx → false (существующий тест «xlsx → false» заменить).
- [ ] **Step 4:** FAIL → реализовать → PASS (`vitest run src/modules/assistant/tag-paths.test.ts`, затем `schema.int.test.ts`, затем `onlyoffice.int.test.ts` — по одному), typecheck.
- [ ] **Step 5: Commit** `feat(api): query probe for nested rows, nested tag paths, sheet automation flag`.

### Task 5: Сервер: построитель раскладки листа

**Files:**
- Create: `apps/api/src/modules/assistant/sheet-layout.ts`, `sheet-layout.test.ts`

**Interfaces:**
- Consumes: `SheetLayout`, `SheetCellKind` (Task 3); решение Task 2 (агрегаторы).
- Produces:
  - `columnKind(type: string): SheetCellKind` — `smallint|integer|bigint` → `integer`; `numeric…|real|double precision|money|number` → `decimal`; `date|timestamp…` (в том числе тип пробы `date`) → `date`; иначе `text`.
  - `valueTag(path: string, kind: SheetCellKind): string` — `{<path>:formatN(0)}` / `:formatN(2)` / `:cellDate` / без форматтера.
  - `aggTag(path: string, agg: SheetAgg, kind: SheetCellKind): string`, `SheetAgg = 'aggSum'|'aggCount'|'aggAvg'|'aggMin'|'aggMax'` — `{<path>:<agg>:formatN(n)}`, `n`: `aggCount` 0, `aggAvg` 2, прочие — 0 для `integer`, иначе 2.
  - `SheetColumn = {column: string; label: string; kind: SheetCellKind}`.
  - `buildSheetLayout(spec: {title?: string; header: {label: string; value: string}[]; table: SimpleTableSpec | GroupedTableSpec; labels: {total: string; subtotal: string}}): SheetLayout`, где `SimpleTableSpec = {key; columns: SheetColumn[]; total: string[]}`, `GroupedTableSpec = {key; group: SheetColumn[]; rows: string; columns: SheetColumn[]; subtotal: string[]; total: string[]}`.
  - `tableLayout(table: SimpleTableSpec, labels): SheetLayout` — только таблица (для карточки `table` в листе).
- Раскладка (строки сверху вниз, колонка A = 0): `title` — A, стиль `title`; `header` — подпись A (`label`), значение B (`plain`, как дано); пустая строка, если были `title`/`header`. Простая: шапка (`header`) → строка `[i]` (`valueTag('d.<key>[i].<col>')`, `data`) → служебная (`{d.<key>[i+1].<первая колонка>}`, прочие пусто, `plain`) → итог при `total` (`aggTag('d.<key>[].<col>', 'aggSum')` в колонках `total`, «Итого» в A, если A не итоговая, стиль `total` у всей строки). С подитогами: строка подписей групп (`header`, если `group` есть) → строка подписей колонок (`header`) → строка группы (`valueTag('d.<key>[i].<g>')`, `group`, ширина — вся таблица) → вложенная `[i]` (`d.<key>[i].<rows>[i].<col>`, `data`) → вложенная служебная (`d.<key>[i].<rows>[i+1].<первая>`, `plain`) → подитог при `subtotal` (`aggTag('d.<key>[i].<rows>[].<col>', 'aggSum')`, «Итого по группе» в A по тому же правилу, `subtotal`) → служебная группы (`{d.<key>[i+1].<первая g>}`, `plain`) → итог при `total` (`d.<key>[].<rows>[].<col>`, `total`). Стилизованные ячейки без значения входят в `cells` (границы на всю строку). `cols` — ширина таблицы (≥ 2, если есть `header`).
  - Ширины: `clamp(max(label.length + 2, W[kind]), 8, 60)`, `W = {text: 20, integer: 10, decimal: 14, date: 12}`; колонка A/B шапки — не меньше длины подписей.

- [ ] **Step 1: Тесты:** `columnKind` для `integer`, `numeric(12,2)`, `timestamp with time zone`, `number`, `date`, `text`, `jsonb`; `valueTag`/`aggTag` для каждого типа и `aggCount`/`aggAvg`; простая таблица `orders(date: date, sum: decimal)` с `total: ['sum']` без заголовка → ровно 4 строки, строка 1 — `['{d.orders[i].date:cellDate}', '{d.orders[i].sum:formatN(2)}']`, строка 3 — `['Итого', '{d.orders[].sum:aggSum:formatN(2)}']`, стили `header/data/plain/total`; с `title` и двумя `header` — таблица начинается со строки 4 (0-based), подписи в A; таблица с подитогами по данным Task 2 → те же теги, что в Task 2, по строкам; `total` по первой колонке — «Итого» не ставится; ширины в пределах 8..60.
- [ ] **Step 2:** FAIL → реализовать → PASS (`vitest run src/modules/assistant/sheet-layout.test.ts`).
- [ ] **Step 3: Commit** `feat(api): sheet layout builder for assistant forming`.

### Task 6: Сервер: `get_sheet`, `propose_sheet`, включение инструментов, промпт

**Files:**
- Create: `apps/api/src/modules/assistant/sheet-tools.ts`, `sheet-tools.test.ts`
- Modify: `apps/api/src/modules/assistant/routes.ts`, `author-tools.ts` (`propose_table` в листе), `author-tools.test.ts`, `prompt.ts`, `agent.test.ts`, `document-tools.test.ts` (тест схем — на все наборы), `apps/api/test/assistant-chat.int.test.ts`, 7× `packages/shared/src/i18n/*/common.json` (`assistant.sheetTotal`, `assistant.sheetSubtotal`)

**Interfaces:**
- Consumes: `SheetSnapshot`, карточки (Task 3); `/queries/probe`, чекер путей (Task 4); `buildSheetLayout`, `tableLayout`, `columnKind` (Task 5); `listQueryError`, `tagsError`, `issuesText`, `str` (`author-tools.ts`).
- Produces: `createSheetTools(ctx: ToolContext & {templateId; templateName; draft: EditorDraft; snapshot: SheetSnapshot | undefined; checkPaths: PathChecker}): AgentTools` с `get_sheet()`, `propose_sheet(title?, header?, table, explanation)` (и `propose_sheet_replacements` — Task 7).
- Produces: `queryColumns(ctx: DraftContext, key: string): Promise<QueryCheckColumn[] | null>` и `nestedColumns(ctx, key, column): Promise<QueryCheckColumn[] | null>` в `sheet-tools.ts` (null — проверка/проба не дала колонок); подписи итогов — `createTranslator(ctx.locale)('common:assistant.sheetTotal' | 'common:assistant.sheetSubtotal')`.
- Включение (routes): `inSheet = author && draft.documentAutomation === true && fileExt ∈ {xlsx, ods} && await deps.documentAutomation()`; снимок — `draft.sheet`; промпт — `author.sheet: true` только тогда; `createAuthorTools({..., sheet: inSheet})`.
- `propose_table` при `sheet: true`: колонки получают тип из `queries/check`, карточка `table` получает `layout = tableLayout(...)`, а `rows` — тексты строк этой раскладки; формат модели у колонок `integer/decimal/date` отбрасывается (форматтер типа должен быть последним), у `text` — сохраняется.
- Схема `propose_sheet.table` — один объект: `key` (обязательно), `columns: {column, label}[]` (обязательно), необязательные `group: {column, label}[]`, `rows: string`, `subtotal: string[]`, `total: string[]`; с подитогами — если задан `rows` (тогда `group` обязателен).

- [ ] **Step 1: Тесты `sheet-tools.test.ts`:**
  - нет снимка → все инструменты: `{error}` с «spreadsheet is not open — ask the author to open the Document tab»;
  - `get_sheet` → `{name, usedRange, active, cells, truncated}` как в снимке;
  - `propose_sheet`: ключ не-список / неизвестная колонка → ошибка как `listQueryError`; `total: ['name']` (текстовая) → ошибка «not a numeric column»; 21 `header` → ошибка; `header.value` с Handlebars → `not Carbone syntax`; `title: '=SUM(A1:A3)'` или `label` с `=` → ошибка «formulas are not allowed»; `rows` без `group` → ошибка; `rows` не вложенный массив при `sampled: true` → ошибка с `json_agg`; проба `sampled: false` → карточка строится, `subtotal: ['sum']` принят, его тег `:formatN(2)`; успех простой и с подитогами → карточка `sheet` с `key` и `layout` (сверка с ожиданием Task 5), модели `{ok: true}`.
  - тест схем в `document-tools.test.ts` расширить прогоном по `createDocumentTools`, `createSheetTools`, `createAuthorTools`: нигде `type` не массив, нет `anyOf`/`oneOf`.
- [ ] **Step 2: Тест `author-tools.test.ts`:** `propose_table` с `sheet: true` по `orders(date, sum)` → в карточке `layout`, `rows[1]` = `['{d.orders[i].date:cellDate}', '{d.orders[i].sum:formatN(2)}']` даже при `format: 'formatC(2)'` у `sum`; без `sheet` — как раньше, `layout` нет.
- [ ] **Step 3: Интеграция (`assistant-chat.int.test.ts`):** xlsx + `documentAutomation: true` + `sheet` + probe true → у фейковой модели есть `get_sheet`, `propose_sheet`, нет `get_document`; docx с тем же → нет `get_sheet`; xlsx + probe false → нет `get_sheet`, в системном промпте нет «get_sheet»; тело с `sheet` и `document` → 400.
- [ ] **Step 4: Промпт (`prompt.ts`, английский, только при `author.sheet`):** открыт лист — `get_sheet` даёт текст ячеек активного листа (адреса A1); фрагмент/таблица у активной ячейки — `propose_tags`/`propose_table`; лист по описанию — `propose_sheet`; подитоги — запрос-список групп с колонкой вложенных строк, пример `select contractor, json_agg(json_build_object('date', date, 'sum', sum) order by date) as rows from … group by contractor`, нет запроса — сначала `propose_query`; заполненная таблица — сначала запросы и параметры, затем `propose_sheet_replacements` (адреса и номера строк — из `get_sheet`); формулы Excel не писать, форматы чисел и дат ставит сервер. Тест в `agent.test.ts`: строки есть при `sheet: true`, нет без него; при `document: true` строк листа нет.
- [ ] **Step 5:** FAIL → реализовать → PASS (`vitest run src/modules/assistant`, затем интеграционный файл чата отдельно), `pnpm i18n:check`, typecheck, lint.
- [ ] **Step 6: Commit** `feat(api): sheet tools — get_sheet and propose_sheet`.

### Task 7: Сервер: `propose_sheet_replacements`

**Files:**
- Modify: `apps/api/src/modules/assistant/sheet-tools.ts`, `sheet-tools.test.ts`

**Interfaces:**
- Consumes: `SheetReplaceItem`, `SheetReplaceTable`, `SheetReplaceRow` (Task 3); `valueTag`, `aggTag`, `columnKind` (Task 5); `queryColumns`, `nestedColumns`, чекер путей (Task 6).
- Аргументы модели (номера строк — 1-based, как в листе): `items: {ref, find, tag, note?}[]` ≤ 100; `table?: {headerRow, firstDataRow, lastDataRow, key, columns: string[], totals?: {row, cells: {ref, column, agg}[]}, grouped?: {groupRow, subtotalRow, group: string[], rows: string, subtotal: string[]}}`; `agg` — `enum` из `SheetAgg`; `''` в `columns`/`group` — ячейка без тега.
- **Решение плана (уточняет §53.3 п. 3):** ширина таблицы — от левой до правой непустой ячейки `headerRow` в снимке (`firstCol` — левая); `columns` — по ячейкам этой ширины слева направо, длина равна ширине; при `grouped` `columns` — вложенные колонки строки данных (поле `grouped.columns` из спецификации не вводится — оно повторяло бы `table.columns`), `group` — колонки строки группы по тем же позициям, `subtotal` — подмножество `columns`; ячейки строки подитога под колонками `subtotal` получают агрегатор, прочие сохраняют текст примера.
- Проверки: `ref` — ячейка снимка, её `text` содержит `find` (иначе «not found in cell»); один `ref` дважды — ошибка; `ref` в строках `firstDataRow..lastDataRow` внутри ширины таблицы или в ячейке `totals` — ошибка; `tag`/тексты — `tagsError` + чекер путей, `=` в начале `tag` — ошибка «formulas are not allowed»; `headerRow < firstDataRow ≤ lastDataRow` в пределах `usedRange`; простая — `listQueryError(key, непустые columns)`; `grouped` — `groupRow === firstDataRow`, `groupRow + 1 < subtotalRow ≤ lastDataRow`, `group` той же длины и хоть одна непустая, `rows` — колонка запроса, вложенные — по пробе (как Task 6); `totals.row > lastDataRow`, ячейки — в этой строке и в ширине таблицы, `column` — из `columns`, тип числовой, кроме `aggCount`.
- Построение `SheetReplaceTable` (0-based): `fingerprint = {header: тексты headerRow по ширине, columns: ширина, sample: тексты firstDataRow}`; простая — `rows = [{styleFrom: firstDataRow, cells: теги [i] | null}, {styleFrom: firstDataRow, cells: служебная [i+1] (первая непустая колонка, прочие '')}]`; `grouped` — `[группа ← groupRow, вложенная [i] ← groupRow+1, вложенная [i+1] ← groupRow+1, подитог ← subtotalRow (агрегаторы | null), служебная группы ← groupRow]`; `totals.cells` — `aggTag(d.<key>[].<col> | d.<key>[].<rows>[].<col>, agg, kind)`.

- [ ] **Step 1: Тесты:** `find` не из текста ячейки → ошибка; `ref` повторён → ошибка; `ref` внутри строк данных → ошибка; `columns` длиной ≠ ширине → ошибка с обеими длинами; `totals` по текстовой колонке с `aggSum` → ошибка, с `aggCount` → принято (`:aggCount:formatN(0)`); `grouped` с `subtotalRow === groupRow + 1` → ошибка; `tag: '=A1'` → ошибка; таблица с `usedRange: 'C3:AB40'` и шапкой в C5:F5 → `firstCol: 2`, `headerRow: 4`; успех простой → `rows` из 2 строк, `totals` с тегом `{d.orders[].sum:aggSum:formatN(2)}`; успех `grouped` → 5 строк с `styleFrom` по правилу выше; только `items` без `table` → карточка `sheetReplace` с `table: null`; пусто и то и другое → «nothing to replace».
- [ ] **Step 2:** FAIL → реализовать → PASS (`vitest run src/modules/assistant/sheet-tools.test.ts`), typecheck, lint.
- [ ] **Step 3: Commit** `feat(api): propose_sheet_replacements — turn a filled sheet into a template`.

### Task 8: Веб: адаптер листа поверх connector

**Files:**
- Create: `apps/web/src/features/assistant/sheetAdapter.ts`, `sheetAdapter.test.ts`
- Modify: `apps/web/src/features/assistant/documentAdapter.ts` (вынести очередь команд `createCommandQueue(connector): {run(fn, scope): Promise<unknown>; dispose(): void}` для обоих адаптеров; поведение документа не меняется)

**Interfaces:**
- Consumes: `Connector` (§52), `SheetSnapshot`, `SHEET_SNAPSHOT_LIMITS`, `SheetLayout`, `SheetReplaceItem`, `SheetReplaceTable` (Task 3).
- Produces: `createSheetAdapter(connector: Connector): SheetAdapter`, где `SheetAdapter = { snapshot(): Promise<SheetSnapshot>; insertCells(ref: string | undefined, layout: SheetLayout): Promise<void>; applyLayout(layout: SheetLayout): Promise<void>; replace(items: SheetReplaceItem[], table: SheetReplaceTable | null): Promise<{notFound: {items: number[]; table: boolean}}>; dispose(): void }`; `gridLayout(rows: string[][]): SheetLayout` — ячейки как есть, `plain`/`text`, без ширин; `textLayout(text: string) = gridLayout(строки текста по одной в колонке)`.
- `insertCells`: раскладка от `ref` (нет — от активной ячейки). `applyLayout`: очистка значений и форматов используемой области активного листа, затем раскладка с A1, ширины колонок.
- Стили — константы адаптера: `title`, `label`, `group`, `subtotal`, `total` — жирный; `header` — жирный, заливка RGB(242, 242, 242), границы; `group`, `data`, `subtotal`, `total` — тонкие границы RGB(166, 166, 166); формат числа по `kind` у не-`plain` ячеек: `integer` `#,##0`, `decimal` `#,##0.00`, `date` `dd.mm.yyyy`; `text` — без формата.
- `replace`: сначала таблица — отпечаток (тексты `headerRow`, ширина, тексты `firstDataRow`) сверяется; не совпал → `notFound.table = true`, сдвига нет; совпал → строки `firstDataRow..lastDataRow` заменяются строками `rows` (оформление и текст `null`-ячеек — из строки `styleFrom` примера), сдвиг `rows.length − (lastDataRow − firstDataRow + 1)` применяется к `totals.row` и к `items` ниже `lastDataRow`; затем `items`: `find` равен всему отображаемому тексту ячейки → значение ячейки = `tag`; иначе подстрока заменяется в строковом значении (`GetValue`), числовое значение или `find` нет в значении → индекс в `notFound.items`.
- **Методы Spreadsheet API — проверить на DE 9.3.1.2 (Task 12) и изолировать в командах адаптера** (при отсутствии — запасной путь внутри команды, проверка `typeof … === 'function'`, как `CreateTable` в §52): `Api.GetActiveSheet()`, `ApiWorksheet.GetName()`, `GetUsedRange()`, `GetRange(ref)`, `GetRangeByNumber(row, col)`, `GetActiveCell()` / `Api.GetSelection()`, `SetColumnWidth(col, width)` (единицы — символы?); `ApiRange.GetAddress(…)`, `GetRow()`/`GetCol()`, `GetRows()`/`GetCols()`/`GetCount()`, `GetText()` (отображаемый текст) и `GetValue()`, `SetValue()`, `SetNumberFormat(code)`, `SetBold(true)`, `SetFillColor(Api.CreateColorFromRGB(r, g, b))`, `SetBorders(edge, 'Thin', color)` (имена сторон), `Clear()`/`ClearContents()`/`ClearFormats()`, `Insert('down')`/`Delete('up')` для строк, `Copy(dest)` или `PasteSpecial` для оформления строки; значение с ведущим `'` остаётся текстом. Список фактически подошедших — комментарием в начале файла, как в `documentAdapter.ts`.

- [ ] **Step 1: Тесты на фейковом connector** (фейковый лист в памяти: значения, отображаемый текст, формат, жирность, заливка, границы, ширины; `fn` вызывается синхронно с подставленными `globalThis.Api`/`Asc`):
  - `snapshot`: непустые ячейки области `C3:AB40` с адресами `C3`, `AB40`; ячейка 501 символ обрезана до 500; после 30 000 символов или 5000 ячеек — `truncated`; область 600×60 — только 500×50 и `truncated`;
  - `applyLayout`: лист очищен, ячейки раскладки на местах с A1, шапка жирная с заливкой и границами, `decimal` — `#,##0.00`, ширины выставлены; `insertCells('D4', textLayout('a\nb'))` → D4 = a, D5 = b, прочее не тронуто;
  - `replace`: простая таблица 5 строк данных → 2 строки (`[i]`, `[i+1]`) с оформлением первой строки данных, `item` ниже таблицы (B12 до сдвига) применён к B9; отпечаток не совпал → `notFound.table`, `item` применён по исходному адресу B12; числовая ячейка «1 234,50» (значение 1234.5): `find: '1 234,50'` → значение = тег, `find: '234'` → `notFound.items`; `grouped`-таблица → 5 строк, подитог с оформлением строки подитога примера;
  - ошибка внутри `fn` → отклонённый Promise; нет ответа 10 с → «command timeout» (фейковые таймеры).
- [ ] **Step 2:** FAIL → реализовать → PASS (`pnpm --filter @carbone-reports/web exec vitest run src/features/assistant --maxWorkers=2`; тесты адаптера документа — без изменений и зелёные).
- [ ] **Step 3: Commit** `feat(web): sheet adapter over the OnlyOffice connector`.

### Task 9: Веб: регистрация листа в мосте, вкладка «Документ», снимок в запросе чата

**Files:**
- Modify: `apps/web/src/features/assistant/bridge.tsx`, `bridge.test.tsx`, `apps/web/src/features/assistant/useDocumentAction.ts`, `apps/web/src/pages/admin/template-editor/DocumentTab.tsx`, `DocumentTab.test.tsx`, `apps/web/src/features/assistant/useAssistantChat.ts`, `useAssistantChat.test.tsx`

**Interfaces:**
- Consumes: `createSheetAdapter`, `SheetAdapter` (Task 8).
- Produces в мосте: `SheetRegistration = {templateId: string; adapter: SheetAdapter; editable: () => boolean}`; `sheet: SheetRegistration | null`; `registerSheet(r): () => void`; `applySheet<T>(templateId, run: SheetRun<T>, dropped?): Promise<T | 'opened' | 'queued' | null>` (семантика `applyDocument`); `sheetSnapshot(): Promise<SheetSnapshot | undefined>` (3 с, как `snapshot()`). Очередь отложенных run — общая, с полем `kind: 'document' | 'sheet'`; регистрация листа запускает только `kind: 'sheet'` своего шаблона. `documentAutomation` (templateId) выставляется и регистрацией листа; `revokeDocument` снимает и отложенные `sheet`.
- Produces: `useFormingAction<K extends 'document' | 'sheet'>(kind: K, templateId: string): FormingActionState<K>` в `useDocumentAction.ts` (тело нынешнего `useDocumentAction`, адаптер и `editable` — из `bridge.document` или `bridge.sheet`, применение — `applyDocument`/`applySheet`); `useDocumentAction(id) = useFormingAction('document', id)`, `useSheetAction(id) = useFormingAction('sheet', id)`; `DocumentActionButton` принимает `FormingActionState<'document' | 'sheet'>`.
- `DocumentTab`: при готовности документа и возможности — `template.fileExt ∈ {xlsx, ods}` → `createSheetAdapter` + `registerSheet`, `docx`/`odt` → как сейчас; снятие, `dispose`, `revoke` — общие для обоих.
- `useAssistantChat`: лист этого шаблона зарегистрирован → `page.editor.sheet = await bridge.sheetSnapshot()` и `documentAutomation: true`; снимок не получился — без обоих полей; `document` и `sheet` вместе не отправляются.

- [ ] **Step 1: Тесты `bridge.test.tsx`:** `applySheet` без листа открывает вкладку «Документ» и выполняет run после `registerSheet`; регистрация **документа** того же шаблона отложенный `sheet`-run не запускает; «грязная» вкладка → `'queued'`; `sheetSnapshot()` без листа → `undefined`; `revokeDocument` сбрасывает отложенные `sheet` с вызовом `dropped`.
- [ ] **Step 2: Тест `DocumentTab.test.tsx`:** шаблон xlsx + `documentAutomation: true` + `createConnector` → `registerSheet` вызван, `registerDocument` — нет; docx — наоборот; `createConnector` бросает → ничего не зарегистрировано, ошибки на экране нет.
- [ ] **Step 3: Тест `useAssistantChat.test.tsx`:** при зарегистрированном листе тело содержит `sheet` и `documentAutomation: true` и не содержит `document`; без листа — ни того, ни другого.
- [ ] **Step 4:** FAIL → реализовать → PASS (веб `--maxWorkers=2`), typecheck.
- [ ] **Step 5: Commit** `feat(web): register the open sheet with the assistant bridge`.

### Task 10: Веб: карточки `sheet`/`sheetReplace`, вставка в таблицу, тексты

**Files:**
- Create: `apps/web/src/features/assistant/SheetCardView.tsx`, `SheetReplaceCardView.tsx`, `apps/web/src/features/assistant/sheetOverlap.ts` (+ тест в `cards.test.tsx`)
- Modify: `TagsCardView.tsx`, `TableCardView.tsx`, `AssistantPanel.tsx` (выбор карточки), `useAssistantChat.ts` (история), `assistant.css`, `cards.test.tsx`, 7× `packages/shared/src/i18n/*/common.json`, 7× `packages/shared/src/i18n/*/admin.json` (`privacyAuthor`)

**Interfaces:**
- Consumes: `useSheetAction`, `DocumentActionButton` (Task 9); карточки (Task 3); `textLayout`, `gridLayout` (Task 8).
- Produces: `overlaps(snapshot: SheetSnapshot, anchor: string, layout: SheetLayout): boolean` — хоть одна ячейка раскладки от `anchor` попадает на непустую ячейку снимка; `truncated` → `true`.
- `tags`/`table` в табличном шаблоне (есть `bridge.sheet` или `documentAutomation` этого шаблона и он xlsx/ods — признак из `bridge.editor`): кнопка «Вставить в таблицу»; действие — свежий `snapshot()`, при `overlaps` — подтверждение «Перезаписать непустые ячейки? …», затем `insertCells(snapshot.active, layout)`; `tags` → `textLayout(card.text)`, `table` → `card.layout ?? gridLayout(card.rows)` (без оформления). В текстовом шаблоне — как сейчас («Вставить в документ»).
- `sheet`: превью сеткой — первые 10 строк раскладки (`<table>`, тексты ячеек), «Сформировать лист»; свежий снимок непуст → диалог «Заменить содержимое листа? Отменить можно через Ctrl+Z» → `applyLayout`.
- `sheetReplace`: «было → станет» с галочками (все отмечены; `ref` слева), таблица отдельным пунктом — «Таблица: строки {{first}}–{{last}} → «{{key}}»» (1-based), кнопка «Заменить выбранное ({{count}})», неактивна при 0; после применения — «не найдено» у пунктов из `notFound`.
- История: `sheet` — `cardSheetText` «Предложен лист: {{key}}»; `sheetReplace` — `cardSheetReplaceText` «Предложены замены: {{items}} значений, таблица» или `cardSheetReplaceItemsText` «Предложены замены: {{items}} значений»; ≤ 4000 символов.
- Новые ключи `common:assistant.*`: `cardInsertSheet`, `cardFormSheet`, `cardReplaceSheetConfirm`, `cardOverwriteCellsConfirm`, `cardSheetTable`, `cardSheetText`, `cardSheetReplaceText`, `cardSheetReplaceItemsText` (+ `sheetTotal`, `sheetSubtotal` из Task 6); `admin:…privacyAuthor` — текст из Global Constraints, 7 языков.

- [ ] **Step 1: Тесты `cards.test.tsx`:** без возможности у `tags`/`table` в xlsx нет кнопок формирования; с листом — «Вставить в таблицу» вызывает `insertCells` с активной ячейкой снимка; непустые ячейки под раскладкой → подтверждение, отказ — `insertCells` не вызван; `truncated` снимок → подтверждение всегда; `sheet` — превью из 10 строк при раскладке в 14, непустой лист → подтверждение перед `applyLayout`, пустой — без него; `sheetReplace` — снятие галочки уменьшает счётчик и исключает пункт (`table: null`, если снята таблица), `notFound` помечает «не найдено»; `editable() === false` → кнопки неактивны с подсказкой; тексты истории для обоих видов `sheetReplace`.
- [ ] **Step 2:** FAIL → реализовать → PASS (веб `--maxWorkers=2`), `pnpm i18n:check`, typecheck, lint.
- [ ] **Step 3: Commit** `feat(web): form templates in the sheet from assistant cards`.

### Task 11: Документация

**Files:** `README.md` (раздел «Формирование в документе»), `README.en.md` (соответствующий), `CHANGELOG.md`.

- [ ] **Step 1:** README ru/en: подраздел «Формирование в таблице»: условия (та же возможность §52, xlsx/ods, только активный лист); три сценария; подитоги — запрос групп с `json_agg(json_build_object(…))` и пример; итоги — агрегаторы Carbone, числа и даты остаются числами и датами (`:formatN`, `:cellDate`), формул Excel ассистент не пишет; оформление листа по описанию — фиксированное; что передаётся модели (текст ячеек используемой области активного листа, в том числе значения заполненного отчёта); пробная строка запроса выполняется на сервере, значения в модель не уходят.
- [ ] **Step 2:** `CHANGELOG.md`, `[Unreleased]`: пункт про формирование в таблице. `pnpm docs:check`.
- [ ] **Step 3: Commit** `docs: forming templates in the sheet (§53)`.

### Task 12: Ручная проверка на DE 9.3.1.2 (контроллер вместе с владельцем)

- [ ] **Step 1:** Сборка api и web по одному с `docker builder prune -f` между ними (диск тесный); `docker compose up -d --wait`; стек уже на DE с лицензией (§52, Task 9) — `.env` не читать.
- [ ] **Step 2:** Сверить методы Spreadsheet API из Task 8 на DE 9.3.1.2 (консоль редактора / пробные команды через connector): единицы ширины колонки, имена сторон границ, вставка/удаление строк, копирование оформления строки, ведущий `'`. Расхождения — правки адаптера отдельными коммитами `fix(web): sheet adapter — …` с обновлением списка методов в его комментарии.
- [ ] **Step 3:** Вместе с владельцем на xlsx и ods: фрагмент и таблица у активной ячейки (с перезаписью и без); лист по описанию — простая таблица с итогом и таблица с подитогами; шаблон из заполненного реестра (с итоговой строкой и с группами); Ctrl+Z; сохранение; сформированный шаблон рендерится в отчёт — суммы и даты числами/датами, подитоги и итог верны; просмотр без блокировки — кнопки неактивны; Community — кнопок нет. Найденное — отдельными коммитами.
