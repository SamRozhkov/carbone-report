# ИИ-ассистент, этап 3 (формирование в документе) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** при OnlyOffice с действующей лицензией и Automation API ассистент вносит предложенное в открытый текстовый документ шаблона по кнопке автора: фрагмент у курсора, документ целиком, замены значений заполненного документа тегами.

**Architecture:** сервер узнаёт о лицензии командой `{c:'license'}` к сервису команд OnlyOffice (с кэшем) и отдаёт `documentAutomation` вместе с конфигом редактора; браузер дополнительно проверяет `createConnector`. Вкладка «Документ» регистрирует в мосте ассистента адаптер документа поверх одного connector; панель шлёт снимок документа в `page.editor.document`. Новые авторские инструменты (`get_document`, `propose_document`, `propose_replacements`) включаются, только если обе проверки «да» и шаблон docx/odt; пути тегов во всех `propose_*` сверяются с черновиком.

**Tech Stack:** Fastify 5 + zod (API), React 19 + Gravity UI + `@onlyoffice/document-editor-react` 2.2.0 (веб), vitest; docker compose.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §52 (контекст — §50, §51).

## Global Constraints

- Ветка `feat/ai-assistant`; в main не сливается, тегов и выпусков нет. Новых npm-зависимостей нет.
- Только текстовые шаблоны `docx`, `odt`; для `xlsx`, `ods`, `pptx` — всё как в §51 (инструментов этапа 3 нет, кнопок нет).
- Ассистент только предлагает: документ меняется только кнопкой автора в браузере; сервер документ не правит (никакого `/docbuilder`).
- Без возможности (§52.2) — ни кнопок, ни упоминаний, ни инструментов этапа 3, промпт о формировании не говорит.
- Возможность на сервере: `server.packageType !== 0` и `server.resultType ∈ {3, 7}`; кэш 10 минут, ошибка/таймаут — «нет» на 1 минуту. В браузере: `typeof docEditor.createConnector === 'function'` и вызов не бросил.
- Снимок: блоки `{type:'p', text, area}` | `{type:'table', rows, area}`, `area ∈ 'body'|'header'|'footer'`; ≤ 30 000 символов суммарно (дальше `truncated: true`), ячейка ≤ 500 символов, таблиц ≤ 30.
- Лимиты инструментов: `propose_document` — ≤ 60 блоков, уровни заголовков 1..3; `propose_replacements` — `items` ≤ 100, `tables` ≤ 10; карточек ≤ 5; авторский режим — 12 вызовов, 120 с.
- Тексты интерфейса — во всех семи каталогах `packages/shared/src/i18n/{ru,en,es,pt-BR,fr,de,zh-CN}`; `pnpm i18n:check`; кириллицы в коде веба и в аргументах `AppError` нет; ключи `common:assistant.*` плоские (не глубже 2 уровней).
- Точные тексты (ru): «Вставить в документ», «Сформировать документ», «Заменить выбранное ({{count}})», «Заменить содержимое документа? Отменить можно через Ctrl+Z», «Изменено в документе», «не найдено», «Чтобы изменить документ, начните редактирование»; история — «Предложен документ: <заголовки>», «Предложены замены: N значений, M таблиц»; предупреждение администратору — «Если OnlyOffice поддерживает формирование в документе, модели также передаётся текст документа шаблона, открытого в редакторе».
- Комментарии — по-русски, в стиле окружающего кода. Коммиты заканчиваются абзацем `Co-Authored-By: <модель> <noreply@anthropic.com>` и `Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB`.
- Node: `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH`; в zsh глобы в кавычках. Наборы тестов не запускать одновременно; веб — `--maxWorkers=2`; `render-onlyoffice.int.test.ts` не запускать. `.env`, `certs/` и конфиг Document Server не читать. Ошибки lint в `cades/cadesplugin_api.js` — локальный шум.

## Review Focus

1. Community-сервер отвечает на `{c:'license'}` «успехом» (`resultType` 3, `packageType` 0): возможности нет, инструментов этапа 3 нет (тест в Task 2).
2. Браузер без `createConnector` (Community) при сервере «да» и наоборот: в запросе чата нет `documentAutomation`, кнопок нет, сервер инструментов этапа 3 не даёт (тесты в Task 2, Task 5, Task 6).
3. `find` встречается в снимке только внутри строк данных таблицы, которую `tables` удаляет, или повторяется в `items`: ошибка модели, карточки нет (тест в Task 4).
4. Документ открыт только для просмотра (нет блокировки редактирования) или открыта другая вкладка с несохранёнными правками: кнопка неактивна с подсказкой / вкладка не переключается и правки не теряются (тест в Task 6).
5. Шаблон xlsx с лицензией: инструментов этапа 3 нет, у карточек только «Копировать» (тест в Task 4).

---

### Task 1: Образ и файл лицензии OnlyOffice в `.env`

**Files:**
- Modify: `docker-compose.yml` (сервис `onlyoffice`), `.env.example`
- Create: `docker-compose.onlyoffice-license.yml`

- [ ] **Step 1:** `docker-compose.yml`: `image: ${ONLYOFFICE_IMAGE:-onlyoffice/documentserver:9.4.0.1}`.
- [ ] **Step 2:** `docker-compose.onlyoffice-license.yml` — только `services.onlyoffice.volumes: ["${ONLYOFFICE_LICENSE_FILE:?задайте ONLYOFFICE_LICENSE_FILE в .env}:/var/www/onlyoffice/Data/license.lic:ro"]` (комментарий в файле: включается `COMPOSE_FILE=docker-compose.yml:docker-compose.onlyoffice-license.yml`).
- [ ] **Step 3:** `.env.example`: закомментированные `ONLYOFFICE_IMAGE=onlyoffice/documentserver-de:9.3.1.2`, `ONLYOFFICE_LICENSE_FILE=./certs/onlyoffice-license.lic`, `COMPOSE_FILE=…` с пояснением по-русски (DE — для разработки; формирование в документе работает только с лицензией с Automation API, §52).
- [ ] **Step 4: Проверка.** `ONLYOFFICE_JWT_SECRET=x docker compose --env-file /dev/null config --images | grep onlyoffice` → `onlyoffice/documentserver:9.4.0.1`; с `ONLYOFFICE_IMAGE=foo:1` → `foo:1`; `ONLYOFFICE_LICENSE_FILE=/tmp/l.lic … -f docker-compose.yml -f docker-compose.onlyoffice-license.yml config` показывает монтирование. (Секреты из `.env` не печатать: `--env-file /dev/null` и заглушки переменных; при ошибке обязательных переменных — подставить заглушки в окружение команды.)
- [ ] **Step 5: Commit** `feat(compose): ONLYOFFICE_IMAGE and optional license file`.

### Task 2: Проверка лицензии и `documentAutomation` в конфиге редактора

**Files:**
- Modify: `apps/api/src/deps.ts` (`OnlyOfficeCommands`), `apps/api/src/modules/onlyoffice/commands.ts`, `commands.test.ts`, `apps/api/src/modules/onlyoffice/routes.ts`, сборка deps (где создаётся `createOnlyOfficeCommands`), фейковые `onlyoffice` в тестах API (поиск `forceSave:` в `apps/api/test` и `apps/api/src`)
- Create: `apps/api/src/modules/onlyoffice/automation.ts`, `automation.test.ts`

**Interfaces:**
- Produces: `OnlyOfficeCommands.license(): Promise<OnlyOfficeLicense>`, где `OnlyOfficeLicense = { packageType: number; resultType: number }` (из `server.*` ответа; бросает `AppError('ONLYOFFICE_ERROR', 502, …)` при сети/`error !== 0`/непонятном ответе — как `forceSave`).
- Produces: `createAutomationProbe(commands: OnlyOfficeCommands, now?: () => number): () => Promise<boolean>`; в `AppDeps` — поле `documentAutomation: () => Promise<boolean>`.
- Produces: ответ `GET /api/templates/:id/editor-config` = конфиг OnlyOffice (как сейчас, подписанный `token` без нового поля) + верхнее поле `documentAutomation: boolean` (`true` только при возможности **и** `row.fileExt ∈ {docx, odt}`).

- [ ] **Step 1: Тесты `commands.test.ts`:** `license()` шлёт `{c:'license'}` на `/command` с JWT в заголовке и теле (как `forceSave`) и возвращает `{packageType: 2, resultType: 3}` из `{error:0, server:{packageType:2, resultType:3}}`; `{error: 1}` и сетевая ошибка → `AppError` с кодом `ONLYOFFICE_ERROR`.
- [ ] **Step 2: Тесты `automation.test.ts`:** `(2,3)`→true; `(1,7)`→true; `(0,3)`→false; `(2,2)`,`(2,6)`→false; второй вызов в пределах 10 мин не зовёт `license()`; через 10 мин+1 мс — зовёт; ошибка → false и повтор через 60 000 мс, не раньше; параллельные вызовы делят один запрос.
- [ ] **Step 3: Тест маршрута** (рядом с существующими тестами `editor-config`, найти `editor-config` в `apps/api/test`): docx + probe true → `documentAutomation: true`, а декодированный `token` не содержит `documentAutomation`; xlsx + probe true → false; docx + probe false → false.
- [ ] **Step 4:** Запустить — FAIL. Реализовать. Запустить — PASS (`pnpm --filter @carbone-reports/api exec vitest run src/modules/onlyoffice` и затронутый интеграционный файл по одному).
- [ ] **Step 5: Commit** `feat(api): OnlyOffice license probe and documentAutomation flag`.

### Task 3: Общие типы: снимок документа и карточки `document`/`replace`

**Files:**
- Modify: `packages/shared/src/index.ts` (`EditorDraft`), `packages/shared/src/assistant.ts` (`Card`), их тесты

**Interfaces (Produces):**
- `DocArea = 'body'|'header'|'footer'`; `DocSnapshotBlock = {type:'p'; text: string; area: DocArea} | {type:'table'; rows: string[][]; area: DocArea}`; `DocSnapshot = {blocks: DocSnapshotBlock[]; truncated: boolean}` — zod-схема `DocSnapshot` с лимитами Global Constraints (сумма символов ≤ 30 000 проверяется `superRefine`; ячейка ≤ 500; таблиц ≤ 30; `text` абзаца ≤ 30 000).
- `EditorDraft` += `document: DocSnapshot.optional()`, `documentAutomation: z.literal(true).optional()`.
- `DocBlock = {type:'heading'; level: 1|2|3; text} | {type:'p'; text} | {type:'table'; key; rows: string[][]}` (строки таблицы построены сервером, как у карточки `table`).
- `ReplaceItem = {find: string; tag: string; note?: string; count: number}` (`count` — вхождений в снимке); `ReplaceTable = {block: number; headerRows: number; key: string; fingerprint: {header: string[][]; columns: number}; rowTags: (string|null)[]; serviceRow: string[]}`.
- `Card` += `{type:'document'; templateId; templateName; blocks: DocBlock[]; explanation}` | `{type:'replace'; templateId; templateName; items: ReplaceItem[]; tables: ReplaceTable[]; explanation}`.

- [ ] **Step 1: Тесты:** `DocSnapshot` принимает пример с абзацем, таблицей и колонтитулом; отклоняет 31 таблицу, ячейку 501 символ, сумму 30 001; `EditorDraft` без `document` по-прежнему валиден.
- [ ] **Step 2:** FAIL → реализовать → PASS (`pnpm --filter @carbone-reports/shared exec vitest run`), `pnpm -r typecheck` (ошибки исчерпывающих `switch` по `Card` в вебе — закрыть заглушкой `return null` с комментарием «Task 7»).
- [ ] **Step 3: Commit** `feat(shared): document snapshot and document/replace cards`.

### Task 4: Сервер: сверка путей тегов и инструменты этапа 3

**Files:**
- Create: `apps/api/src/modules/assistant/tag-paths.ts`, `tag-paths.test.ts`, `apps/api/src/modules/assistant/document-tools.ts`, `document-tools.test.ts`
- Modify: `apps/api/src/modules/assistant/author-tools.ts` (`propose_tags`, `propose_table` используют сверку; экспорт `tagsError`, `tableRows`, `formatError` для переиспользования), `routes.ts` (`authorMode` возвращает и `fileExt`; включение инструментов), `prompt.ts`, `agent.test.ts`, интеграционный тест чата ассистента (найти `assistant-chat` в `apps/api/test`)

**Interfaces:**
- Consumes: `deps.documentAutomation()` (Task 2); `DocSnapshot`, `DocBlock`, `ReplaceItem`, `ReplaceTable`, карточки (Task 3).
- Produces: `createPathChecker(ctx: {inject; templateId; draft: EditorDraft}): (text: string) => Promise<string | null>` — для каждого тега `{d.…}`/`{d.params.…}` в тексте: ключ запроса есть в черновике; список — с `[i]`/`[i+1]`, одна строка — без индекса; колонка (первый сегмент после ключа/индекса) — из `POST …/queries/check` запроса (кэш проверки на вызов чекера); параметр есть в `draft.params`. Ошибка — строка для модели с перечнем допустимых путей (как `get_template_design`). Проверка SQL не прошла/ответ не 200 → колонки не проверяются. Теги `{c.…}`, `{t(…)}`, `{$…}`, `{#…=}` не сверяются.
- Produces: `createDocumentTools(ctx: ToolContext & {templateId; templateName; draft: EditorDraft; snapshot: DocSnapshot | undefined; checkPaths}): AgentTools` с `get_document()`, `propose_document(blocks, explanation)`, `propose_replacements(items, tables, explanation)`.
- Включение (routes): `author && draft.documentAutomation === true && fileExt ∈ {docx, odt} && await deps.documentAutomation()`; системный промпт получает `author.document: true` только тогда.

- [ ] **Step 1: Тесты `tag-paths.test.ts`:** `{d.orders[i].name}` при списке `orders` с колонкой `name` → null; `{d.orders.name}` при списке → ошибка с «[i]»; `{d.company[i].x}` при одной строке → ошибка; неизвестная колонка → ошибка с перечнем; `{d.params.from}` без параметра → ошибка; `{d.orders[i+1].name}` → null; `{c.now:formatD('L')}`, `{$total}` → null; проверка SQL вернула `{ok:false}` → путь с любой колонкой принят.
- [ ] **Step 2: Тесты сверки в `author-tools.test.ts`:** `propose_tags` с тегом на несуществующую колонку → `{error}` и нет карточки; существующий тест «валидные фрагменты» дополнить черновиком с нужными запросами.
- [ ] **Step 3: Тесты `document-tools.test.ts`:**
  - нет снимка → все три инструмента возвращают `{error}` с текстом «document is not open — ask the author to open the Document tab»;
  - `get_document` → `{blocks: [{n, type, area, text|rows}], truncated}` (номера — индексы `blocks`);
  - `propose_document`: 61 блок → ошибка; `heading` level 4 → ошибка; блок с Handlebars → ошибка `not Carbone syntax`; `table` по ключу не-списку → ошибка как у `propose_table`; успех → карточка `document`, `table`-блок развёрнут в `rows` (3 строки, как `tableRows`), модели `{ok:true}`;
  - `propose_replacements`: `find` нет в снимке → ошибка; один `find` дважды → ошибка; `find` только внутри строк данных таблицы из `tables` → ошибка; `block` не таблица → ошибка; число `columns` ≠ числу ячеек строки `headerRows` → ошибка; неверный путь в `tag` → ошибка; успех → карточка `replace` с `count` (число вхождений по всем блокам, включая колонтитулы), `fingerprint` (строки заголовка и число колонок), `rowTags` (`{d.<key>[i].<col>}` или `null`), `serviceRow` (`{d.<key>[i+1].<первая непустая колонка>}`, прочие пусто);
  - `routes`/интеграция: инструменты этапа 3 есть только при `documentAutomation: true` в черновике **и** probe true **и** docx; xlsx → нет; probe false → нет; в запросе к фейковой модели при отсутствии возможности нет слов `propose_document`.
- [ ] **Step 4: Промпт (`prompt.ts`, на английском), только при `author.document`:** документ открыт — `get_document` даёт его текст; три сценария (фрагмент/таблица у курсора — `propose_tags`/`propose_table`, автор вставляет кнопкой; документ с нуля — `propose_document`; заполненный документ → шаблон — сначала нужные запросы и параметры `propose_query`/`propose_param`, затем `propose_replacements`); `find` — точный текст из документа, подлиннее, если короткое значение встречается в разных смыслах; не менять оформление. Тест в `agent.test.ts`: строки есть при `document: true` и отсутствуют без него.
- [ ] **Step 5:** FAIL → реализовать → PASS (`vitest run src/modules/assistant`, интеграционный файл чата по одному), `pnpm -r typecheck`, lint.
- [ ] **Step 6: Commit** двумя коммитами: `feat(api): check tag paths against the template draft` и `feat(api): document tools for forming templates in the editor`.

### Task 5: Веб: адаптер документа поверх connector

**Files:**
- Create: `apps/web/src/features/assistant/documentAdapter.ts`, `documentAdapter.test.ts`

**Interfaces:**
- Consumes: типы Task 3.
- Produces: `interface Connector { callCommand(fn: () => unknown, cb: (r: unknown) => void): void; executeMethod(name: string, args: unknown[], cb?: (r: unknown) => void): void; disconnect(): void }`; `createDocumentAdapter(connector: Connector): DocumentAdapter`, где
  `DocumentAdapter = { snapshot(): Promise<DocSnapshot>; insertTags(text: string): Promise<void>; insertTable(rows: string[][]): Promise<void>; replaceAll(blocks: DocBlock[]): Promise<void>; replace(items: ReplaceItem[], tables: ReplaceTable[]): Promise<{notFound: {items: number[]; tables: number[]}}>; dispose(): void }`.
- Код внутри `callCommand` не видит замыканий: входные данные — через `Asc.scope` (присвоить `window.Asc.scope = {...}` перед вызовом), результат — возвращаемым значением; всё тело в `try/catch`, ошибка → `{error: String(e)}`, адаптер превращает её в отклонённый Promise.
- Office JS API (Document), сверить имена по https://api.onlyoffice.com/docs/office-api/ перед реализацией: `Api.GetDocument()`, `GetElementsCount()`/`GetElement(i)`/`GetClassType()` (`'paragraph'`/`'table'`), `GetText()`, таблица — `GetRowsCount()`, `GetRow(r).GetCellsCount()`, `GetCell(c).GetContent()`; колонтитулы — `GetFinalSection().GetHeader('default', false)`/`GetFooter(...)`; вставка — `Api.CreateParagraph()`, `Api.CreateTable(cols, rows)`, `doc.InsertContent([...])` (в позицию курсора, заменяя выделение); замена всего тела — `RemoveAllElements()` + `Push()`; поиск-замена — `doc.SearchAndReplace({searchString, replaceString, matchCase: true})` (действует и на колонтитулы — проверить вручную в Task 9; если нет — пройти колонтитулы отдельно); строки таблицы — `RemoveRow`/`AddRow`. Порядок `replace`: сначала таблицы (поиск по `block`, сверка с `fingerprint`, иначе поиск по отпечатку среди таблиц), затем `items`.

- [ ] **Step 1: Тесты на фейковом connector**, который вызывает `fn` синхронно с подставленными `globalThis.Api` и `globalThis.Asc` (фейковый документ в памяти: абзацы, таблицы, колонтитулы): `snapshot` собирает тело и колонтитулы с `area`, обрезает ячейки до 500 и ставит `truncated` после 30 000 символов; `insertTags('a\nb')` вставляет два абзаца; `insertTable` — таблицу 3×N; `replaceAll` — тело из заголовков, абзацев и таблицы, колонтитулы не тронуты; `replace` — таблица с отпечатком превращается в «заголовок + [i] + [i+1]» с удалением остальных строк, затем значения заменены; изменённый заголовок таблицы → она в `notFound.tables`; `find` которого нет → в `notFound.items`; ошибка внутри `fn` → отклонённый Promise.
- [ ] **Step 2:** FAIL → реализовать → PASS (`pnpm --filter @carbone-reports/web exec vitest run src/features/assistant --maxWorkers=2`).
- [ ] **Step 3: Commit** `feat(web): document adapter over the OnlyOffice connector`.

### Task 6: Веб: регистрация документа в мосте и снимок в запросе чата

**Files:**
- Modify: `apps/web/src/features/assistant/bridge.tsx`, `bridge.test.tsx`, `apps/web/src/pages/admin/template-editor/DocumentTab.tsx`, `apps/web/src/features/assistant/useAssistantChat.ts`, `apps/web/src/api/endpoints.ts` (тип ответа editor-config с `documentAutomation`)

**Interfaces:**
- Consumes: `createDocumentAdapter`, `Connector` (Task 5); `documentAutomation` из editor-config (Task 2).
- Produces в мосте: `DocumentRegistration = {templateId: string; adapter: DocumentAdapter; editable: () => boolean}`; `registerDocument(r): () => void`; `document: DocumentRegistration | null` (в состоянии, как `editor`); `applyDocument(templateId: string, run: (a: DocumentAdapter) => Promise<T>): Promise<T | 'opened' | 'queued' | null>` — документ смонтирован → `run`; иначе открыть вкладку «Документ» (если другие вкладки не «грязные», иначе `'queued'`) и выполнить `run` после регистрации документа; `snapshot(): Promise<DocSnapshot | undefined>`.
- `EditorRegistration.openTab` принимает и `'document'` (значение вкладки — как в `TemplateEditorPage`).
- `DocumentTab`: конфиг редактора передаётся в `DocumentEditor` без поля `documentAutomation`; если `documentAutomation` и `window.DocEditor?.instances['cr-doc-editor']?.createConnector` — функция, после `events_onDocumentReady` создать connector (в `try/catch`; ошибка — без возможности), `registerDocument`; при размонтировании и смене конфига — `dispose()` (→ `disconnect()`) и снятие регистрации. `editable` — `lock.editing`.
- `useAssistantChat`: при открытом документе того же шаблона — `page.editor.document = await bridge.snapshot()` и `page.editor.documentAutomation = true`; снимок не получился — без обоих полей.

- [ ] **Step 1: Тесты `bridge.test.tsx`:** без зарегистрированного документа `applyDocument` открывает вкладку «Документ» и выполняет `run` после регистрации; при «грязной» вкладке — `'queued'` без переключения; `snapshot()` без документа → `undefined`; снятие регистрации сбрасывает `document`.
- [ ] **Step 2: Тест `DocumentTab`** (в существующем `DocumentTab.test.tsx`, мок редактора уже есть): при `documentAutomation: false` connector не создаётся и документ не регистрируется; при `true` и наличии `createConnector` — регистрируется после готовности документа; `createConnector` бросает → не регистрируется, ошибки на экране нет.
- [ ] **Step 3: Тест `useAssistantChat`:** тело запроса содержит `document` и `documentAutomation: true` при зарегистрированном документе и не содержит их без него.
- [ ] **Step 4:** FAIL → реализовать → PASS (веб с `--maxWorkers=2`), typecheck.
- [ ] **Step 5: Commit** `feat(web): register the open document with the assistant bridge`.

### Task 7: Веб: кнопки и карточки формирования, тексты

**Files:**
- Create: `apps/web/src/features/assistant/DocumentCardView.tsx`, `ReplaceCardView.tsx`
- Modify: `TagsCardView.tsx`, `TableCardView.tsx`, `AssistantPanel.tsx`, `useAssistantChat.ts` (текст истории), `assistant.css`, `cards.test.tsx`, 7× `packages/shared/src/i18n/*/common.json`, страница «Администрирование → Ассистент» (предупреждение; найти текущий ключ с «передаются SQL запросов шаблона») и её 7 каталогов

**Interfaces:**
- Consumes: `bridge.document`, `bridge.applyDocument` (Task 6), карточки (Task 3).
- Общее правило кнопок формирования: видны, только если `bridge.document?.templateId === card.templateId` **или** открыт редактор этого шаблона с `documentAutomation` (документ ещё не смонтирован — применится после открытия вкладки); неактивны с подсказкой «Чтобы изменить документ, начните редактирование», если `!document.editable()`. Без возможности — разметка как в §51.
- `tags`/`table`: кнопка «Вставить в документ» → `insertTags`/`insertTable`.
- `document`: превью (заголовки, абзацы, таблицы как в `TableCardView`), «Сформировать документ»; если в последнем снимке есть непустой блок `area:'body'` — диалог «Заменить содержимое документа? Отменить можно через Ctrl+Z» перед `replaceAll`.
- `replace`: список «было → станет» с галочками (все отмечены), «×N» при `count > 1`, таблицы отдельными пунктами («Таблица: <заголовки> → строки «<key>»»); кнопка «Заменить выбранное ({{count}})», неактивна при 0; после применения пункты из `notFound` помечаются «не найдено».
- Успех — уведомление «Изменено в документе»; ошибка адаптера — общее уведомление об ошибке (новый ключ, текст «Не удалось изменить документ»).
- История: `document` — «Предложен документ: <тексты heading через «; »>» (без заголовков — первые 100 символов первого абзаца); `replace` — «Предложены замены: N значений, M таблиц»; ≤ 4000 символов.

- [ ] **Step 1: Тесты `cards.test.tsx`:** без возможности у `tags`/`table` нет «Вставить в документ»; с документом — есть и вызывает адаптер; `editable() === false` → кнопка неактивна с подсказкой; `document` с непустым снимком спрашивает подтверждение, отказ — `replaceAll` не вызван; `replace`: снятие галочки уменьшает счётчик и исключает пункт из вызова; `notFound` помечает пункт «не найдено»; тексты истории.
- [ ] **Step 2:** FAIL → реализовать → PASS (веб `--maxWorkers=2`), `pnpm i18n:check`, typecheck, lint.
- [ ] **Step 3: Commit** `feat(web): form templates in the document from assistant cards`.

### Task 8: Документация

**Files:** `README.md`, `README.en.md` (или фактические имена ru/en README — найти раздел «ИИ-ассистент (экспериментально)»), `CHANGELOG.md`.

- [ ] **Step 1:** README ru/en: подраздел «Формирование в документе»: `ONLYOFFICE_IMAGE`, `ONLYOFFICE_LICENSE_FILE` + `COMPOSE_FILE`; условия (лицензия с Automation API, docx/odt); три сценария; что дополнительно передаётся модели (текст открытого документа, включая значения заполненного отчёта); переход Community 9.4 → DE 9.3: если документы не открываются — пересоздать тома `oo_*` (шаблоны в S3).
- [ ] **Step 2:** `CHANGELOG.md`, `[Unreleased]`: пункт про формирование в документе и сверку путей тегов. `pnpm docs:check`, если есть.
- [ ] **Step 3: Commit** `docs: forming templates in the document (§52)`.

### Task 9: Переключение локального стека на DE и ручная проверка (контроллер вместе с владельцем)

- [ ] **Step 1:** Владелец кладёт файл лицензии и прописывает в `.env` `ONLYOFFICE_IMAGE`, `ONLYOFFICE_LICENSE_FILE`, `COMPOSE_FILE` (контроллер `.env` не читает и не правит без просьбы владельца).
- [ ] **Step 2:** Сборка api и web по одному с `docker builder prune -f` между ними; `docker compose up -d --wait`; проверить открытие и сохранение существующего docx-шаблона на DE 9.3.
- [ ] **Step 3:** Вместе с владельцем: три сценария на docx и odt; Ctrl+Z; сохранение; колонтитулы в снимке и замене; просмотр без блокировки — кнопка неактивна; Community (`ONLYOFFICE_IMAGE` по умолчанию) — кнопок нет. Найденное — правки отдельными коммитами.
