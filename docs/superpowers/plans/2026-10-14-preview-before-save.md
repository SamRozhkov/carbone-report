# Просмотр отчёта перед сохранением (План 13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Пользователь сначала видит отчёт, потом выбирает формат:
- «Сформировать» собирает данные один раз, сохраняет снимок запуска (данные и копию шаблона) и показывает PDF на странице;
- под просмотром — «Сохранить как» с кнопкой для каждого формата шаблона; файл формата собирается из снимка по первому запросу и совпадает с просмотром;
- история предлагает меню форматов для новых запусков, старые запуски скачиваются как раньше;
- очистка и удаление пользователя удаляют каталог снимка целиком.

**Architecture:**
- **Снимок и пути.** Всё о запуске лежит в `reports/<runId>/`: `data.json`, `template.<ext>`, `out.<формат>`. Пути, проверка формата, поля DTO и сборка — в новом модуле `apps/api/src/modules/reports/snapshot.ts`. У запуска со снимком `report_runs.file_path` = `reports/<runId>/template.<ext>`. Отсюда берётся расширение шаблона (`outputFormatsFor(ext)`) без новой колонки: шаблон может быть удалён (`template_id → null`), а запуск по-прежнему скачивается во всех форматах. Каталог для удаления выводится из `runId`.
- **Одна схема рендера.** PDF при «Сформировать» и любой другой формат позже собираются одной функцией `renderFromSnapshot`: она читает `data.json` и копию шаблона и вызывает `renderReport`. Поэтому PDF и DOCX получают от Carbone одни и те же данные (после `JSON.stringify` — так же, как их и так сериализует `CarboneClient`). `renderReport` теперь принимает `TemplateFileRef` вместо `TemplateFull`; предпросмотр админа передаёт `templateFileRef(deps, full.row)` и не меняется.
- **Carbone.** `CarboneClient` не меняется. Копия шаблона передаётся как `TemplateFileRef { id: 'run:<runId>', version: templateVersion, ext, read }`, поэтому кэш id шаблона Carbone (память или Redis, ключ `cr:carbone:tpl:run:<runId>`, TTL 7 дней) ключуется по запуску (§24.2). Прежний повтор при «template not found» перезагружает копию снимка. Кэш в памяти (без Redis) получает предел 1000 записей, иначе он рос бы на каждый запуск (Task 2).
- **Одна сборка на запуск и формат — advisory-блокировка Postgres.** Сборка идёт в транзакции:
  1. `set_config('lock_timeout', <остаток срока>ms, true)`;
  2. `pg_advisory_xact_lock(726100002, hashtext('<runId>:<формат>'))`;
  3. `select … from report_runs … for share`;
  4. повторная проверка `report_run_files`;
  5. рендер → `storage.write` → `insert report_run_files` → commit.

  Второй запрос ждёт блокировку, затем находит строку и отдаёт готовый файл. Почему не `insert … on conflict` с состоянием «собирается»:
  - блокировка живёт в общей БД, поэтому работает с любым числом экземпляров API;
  - она снимается сама при rollback, обрыве соединения или падении процесса — не бывает «вечного building», не нужны опрос и уборка зависших строк;
  - ожидание ограничено `lock_timeout`, то есть остатком `REPORT_TIMEOUT_MS`;
  - пара int4 — отдельное пространство ключей и не пересекается с bigint-ключом бэкапа `STORAGE_REMOVE_LOCK_KEY = 726100001`.

  Цена — одно соединение пула (max 10) на время идущей или ожидающей сборки. Сборки запускает пользователь кнопкой, и каждая ограничена `REPORT_TIMEOUT_MS`; узкое место — Carbone. `FOR SHARE` на строке запуска упорядочивает сборку с очисткой и удалением пользователя: их `UPDATE`/`DELETE` ждут конца сборки, каталог удаляется уже вместе с новым файлом, сирот не остаётся.
- **Срок.** `GET /api/runs/:id/file` создаёт `Deadline(REPORT_TIMEOUT_MS)` в начале запроса. Ожидание блокировки (`lock_timeout`) и рендер (`deadline.race`, таймаут Carbone через `deadline.cap`) не выходят за этот срок. Истечение — `504 TIMEOUT` «превышено время формирования отчёта». Код `55P03` распознаёт новый `isLockTimeout` в `lib/db-errors.ts`.
- **Модель данных.** Миграция `0006_run_files` (через `db:generate`):
  - `report_runs.output_format` становится nullable;
  - добавляется `report_runs.snapshot boolean not null default false`;
  - новая таблица `report_run_files (run_id → report_runs on delete cascade, format, file_path, created_at, pk(run_id, format))`.

  Заполнять ничего не нужно: старые строки получают `snapshot = false` и сохраняют свой `output_format`, это ровно «старые запуски не меняются» (§24.3). Новые запуски с ошибкой: `output_format = null`, `snapshot = false`, снимка нет. Если формирование упало после начала записи снимка, каталог удаляется без ожидания (`void storage.remove`), чтобы бэкап, который держит удаления, не задерживал ответ.
- **Формат файла и DTO.** Правила проверки формата из §24.4 — чистые функции `allowedFormats`/`resolveRunFormat`/`runFormats` с юнит-тестами. `RunDto.outputFormat` становится `nullable`. Добавлены `formats` и `readyFormats`, `fileAvailable` сохранён. `RenderBody = { params }`: лишний `format` zod-объект отбрасывает, то есть игнорирует.
- **Веб.** Обычная ссылка не умеет показывать спиннер и ошибку сборки. Поэтому «Сохранить как» загружает файл через `fetch` (новый `apiFile` → `{ blob, filename }` из `Content-Disposition`) и сохраняет его тем же `triggerDownload(blobUrl, filename)` (§24.6). Общий хук `useRunDownload` используют `ReportRunPage` (ряд кнопок) и `HistoryPage` (меню `DropdownMenu`). В колонке «Формат» истории у старого запуска — его формат, у нового — собранные форматы (`PDF, DOCX`). `PreviewTab` не меняется.
- **Порядок задач.**
  - Task 1 меняет общий DTO (`RenderBody`, `RunDto`), поэтому в нём же — минимальные правки веба для гейтов: тело без `format`, скачивание прежним переключателем через `?format=`, null-безопасная колонка «Формат». Промежуточное состояние работает правильно.
  - Task 3 заменяет переключатель на «Сохранить как».

**Tech Stack:**
- API: Fastify 5, drizzle-orm 0.45 + drizzle-kit 0.31 (`db:generate`), zod 4, vitest + testcontainers (`pnpm test:int`);
- shared: zod-DTO;
- веб: React 19, Gravity UI 7.50 (`Button`, `DropdownMenu`, `Alert`), TanStack Query, vitest + testing-library;
- скрипт: `scripts/smoke.ts` (tsx);
- E2E: Playwright на демо-стеке.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §24.

## Global Constraints

- Node 22: каждую команду начинать с `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null &&`.
- Гейты: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test`; если менялся `apps/api` — ещё `pnpm test:int`. Код в плане может быть не отформатирован по prettier, поэтому перед гейтами — `pnpm exec prettier --write <изменённые файлы>`.
- Сообщения коммитов заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `.env` и `certs/` не коммитятся. Секреты (`ADMIN_PASSWORD`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD` и др.) не печатаются в вывод: скрипты берут их из `.env` сами, `docker compose config`/`env` не запускать.
- Перед `docker build` / `up --build` / `pnpm stack:demo`: `df -h /System/Volumes/Data`. Если свободно меньше 2 GiB — BLOCKED. Новые образы не тянуть: стек и testcontainers используют уже скачанные образы. Не делать `prune` чужих docker-ресурсов; удалять можно только висячие образы проекта `carbone-reports`. `down` — без `-v`.
- Весь текст интерфейса — на русском.
- Новых зависимостей нет.
- Миграции — только через `pnpm --filter @carbone-reports/api db:generate --name <имя>`; SQL коммитится вместе с `drizzle/meta`. Повторный `db:generate` должен сообщить «No schema changes».
- §24.1:
  - на странице запуска отчёта выбора формата нет; «Сформировать» формирует отчёт и показывает его в PDF на странице;
  - под просмотром — «Сохранить как» с кнопкой для каждого формата из `outputFormatsFor(fileExt)`: Word-шаблон — PDF, DOCX, ODT; Excel-шаблон — PDF, XLSX, ODS; PowerPoint — PDF, PPTX;
  - формат по умолчанию из настроек шаблона (`defaultOutput`) — основная кнопка, остальные второстепенные;
  - просмотр всегда в PDF, для Excel тоже (печатный вид по настройкам печати шаблона);
  - повторное «Сформировать» создаёт новый запуск и новый просмотр.
- §24.2:
  - «Сформировать» один раз собирает данные (проверка параметров, SQL — как сейчас) и сохраняет снимок: данные — `reports/<runId>/data.json`, копия файла шаблона той версии, что использовалась, — `reports/<runId>/template.<ext>`; из снимка собирается PDF `reports/<runId>/out.pdf`; ответ — `201 { runId }`;
  - файл формата F собирается из снимка при первом запросе и сохраняется как `reports/<runId>/out.<F>`, дальше отдаётся готовым; повторной выборки данных нет;
  - одновременные запросы одного формата одного запуска собирают файл один раз: блокировка на время сборки, второй ждёт и получает готовый файл;
  - сборка из снимка укладывается в `REPORT_TIMEOUT_MS`, отсчёт — от начала запроса на скачивание;
  - кэш id шаблона Carbone для снимка ключуется по `runId`, а не по шаблону.
- §24.3:
  - `report_runs.output_format` — необязательный; `report_runs.snapshot boolean not null default false`;
  - `report_run_files(run_id uuid → report_runs on delete cascade, format text, file_path text, created_at timestamptz, primary key (run_id, format))`;
  - старые запуски (`snapshot = false`) не меняются: их файл доступен только в формате `output_format`.
- §24.4:
  - `POST /api/reports/:id/render` — тело `{ params }`; пришедший `format` игнорируется; ответ `201 { runId }` после сборки PDF;
  - `GET /api/runs/:id/file?format=<F>&inline=0|1` — файл формата F, при необходимости собранный из снимка; без `format` — PDF для снимковых запусков и `output_format` для старых;
  - формат вне `outputFormatsFor(ext)`, а для старых запусков — любой, кроме `output_format`, → `400 VALIDATION` «формат недоступен для этого отчёта»;
  - снимок удалён → `410 GONE` «файл удалён — сформируйте отчёт заново»;
  - ошибка сборки (в том числе `CARBONE_COMMUNITY`) возвращается как есть, статус запуска не меняется;
  - `GET /api/runs` — у каждого запуска `formats: OutputFormat[]` (доступные) и `readyFormats: OutputFormat[]` (собранные); `fileAvailable` остаётся;
  - доступ к файлам — владелец или админ, иначе 404; снимок данных наружу не отдаётся.
- §24.5: очистка по `REPORT_RETENTION_DAYS` удаляет каталог `reports/<runId>/` и строки `report_run_files` и ставит `file_deleted = true` (старые запуски — как сейчас); удаление пользователя удаляет каталоги его запусков.
- §24.6:
  - **ReportRunPage.** Форма параметров и «Сформировать». После успеха — `iframe` с `/api/runs/:id/file?format=pdf&inline=1` и ряд кнопок «Сохранить как». У нажатой кнопки, пока файл собирается, виден спиннер. Ошибка сборки показывается под кнопками. Скачивание идёт через `triggerDownload`.
  - **HistoryPage.** У успешного запуска со снимком — меню «Скачать» со всеми форматами из `formats`; у старых — одна ссылка, как сейчас.
  - Вкладка «Предпросмотр» редактора не меняется.

## Review Focus

1. **Файл расходится с просмотром.** Опасные места:
   - DOCX собирается из живого шаблона или повторной выборкой SQL;
   - копия шаблона берётся не той версии;
   - кэш Carbone ключуется по шаблону, и после замены файла старый запуск рендерится новым шаблоном.

   Ожидание: любой формат — из `data.json` и `template.<ext>` каталога запуска, `tpl.id = run:<runId>`. Тест: Task 1, `run-files.int.test.ts` «файл собирается из снимка: данные в источнике и шаблон изменились» и «формирование создаёт снимок и PDF…»; `snapshot.test.ts` «snapshotTemplateRef…».
2. **Двойная сборка или зависшее ожидание.** Опасные места:
   - два одновременных запроса формата дважды вызывают Carbone;
   - ожидание блокировки не ограничено сроком и держит соединение;
   - блокировка остаётся после прерванной сборки;
   - ключ блокировки не включает формат или запуск.

   Тест: Task 1, `run-files.int.test.ts` «два одновременных запроса DOCX — одна сборка», «ожидание чужой сборки ограничено сроком» (блокировку держит тест тем же ключом `726100002, hashtext('<runId>:docx')`), «сборка, прерванная по сроку, снимает блокировку».
3. **Проверка формата и старые запуски.** Опасные места:
   - DOCX для Excel-шаблона;
   - PDF для старого DOCX-запуска;
   - неверный формат по умолчанию;
   - сборка до проверки формата;
   - `format` в теле рендера по-прежнему влияет на результат.

   Тест: Task 1, `snapshot.test.ts` (`resolveRunFormat`, `runFormats`), `run-files.int.test.ts` «недопустимый формат → 400 VALIDATION; ничего не собирается», «Excel-шаблон…», «старый запуск: только его формат…», `reports.int.test.ts` «`format` в теле игнорируется».
4. **Жизненный цикл и доступ.** Опасные места:
   - снимок удалён, а API отвечает 502 или собирает пустой файл;
   - ошибка сборки портит статус запуска или оставляет `out.<F>`;
   - очистка удаляет только копию шаблона и оставляет каталог и строки `report_run_files`;
   - удаление пользователя оставляет каталоги;
   - чужой запуск собирается до проверки доступа.

   Тест: Task 1, `run-files.int.test.ts` «снимок удалён → 410…», «ошибка сборки возвращается как есть…», «чужой запуск → 404 без сборки»; Task 2, `cleanup.int.test.ts` «запуск со снимком: удаляется весь каталог…», `hardening.int.test.ts` «удаляет каталоги снимков…».
5. **Интерфейс.** Опасные места:
   - на форме остался выбор формата;
   - просмотр не PDF;
   - кнопки не по расширению шаблона;
   - основная кнопка не по `defaultOutput`;
   - нет спиннера у нажатой кнопки, ошибка сборки не видна;
   - история без меню форматов.

   Тест: Task 3, `ReportRunPage.test.tsx` (Word, Excel, спиннер, ошибка, повторное «Сформировать»), `HistoryPage.test.tsx` «запуск со снимком: меню «Скачать»…», `download.test.ts`; Task 4, `e2e/tests/user.spec.ts` («Сформировать» → PDF → «Сохранить как» DOCX скачивает файл, меню в истории).

---

## Task 1: Модель данных, DTO и API снимка (§24.2–24.4)

**Files:**
- Modify: `packages/shared/src/index.ts:307-308` (`RenderBody`), `:323-338` (`RunDto`)
- Modify: `packages/shared/src/index.test.ts:1-9` (импорт), новый `describe` после `:122`
- Modify: `apps/api/src/db/schema.ts:177-193` (`reportRuns`), после `:193` (`reportRunFiles`), `:200` (тип `RunFileRow`)
- Create: `apps/api/drizzle/0006_run_files.sql`, `apps/api/drizzle/meta/0006_snapshot.json`, правка `apps/api/drizzle/meta/_journal.json` (всё через `db:generate`)
- Modify: `apps/api/src/lib/db-errors.ts` (в конец — `isLockTimeout`), `apps/api/src/lib/db-errors.test.ts` (новый тест)
- Modify: `apps/api/src/modules/reports/service.ts:1-15` (импорты), `:60-83` (`assertFormat` удалить, `renderReport` принимает `TemplateFileRef`)
- Create: `apps/api/src/modules/reports/snapshot.ts`
- Create: `apps/api/src/modules/reports/snapshot.test.ts`
- Modify: `apps/api/src/modules/reports/routes.ts:1-27` (импорты), `:47-100` (рендер), `:128-142` (история), `:147-183` (файл), `:208` (предпросмотр)
- Create: `apps/api/test/run-files.int.test.ts`
- Modify: `apps/api/test/reports.int.test.ts:160-163`, `:271-282`
- Modify: `apps/api/test/db.int.test.ts:17-24`
- Modify: `apps/web/src/api/endpoints.ts:1-29` (импорт `OutputFormat`), `:139-140` (`runFileUrl`)
- Modify: `apps/web/src/pages/ReportRunPage.tsx:42`, `:45`, `:130`, `:137`
- Modify: `apps/web/src/pages/ReportRunPage.test.tsx:47-53`, `:67`, `:241-244`
- Modify: `apps/web/src/pages/HistoryPage.tsx:93`

**Interfaces:**
- Consumes:
  - `collectReportData(deps, full, input, deadline)` (`reports/service.ts:21`);
  - `templateFileRef(deps, row)` (`templates/service.ts:159`, повторяет чтение при замене файла);
  - `CarboneRenderer.render(tpl: TemplateFileRef, data, opts)` (`deps.ts:22-24`, кэш по `tpl.id` + `tpl.version` в `carbone/client.ts:38-40`);
  - `Storage.write/read/remove/exists` (`lib/storage.ts`, `write` атомарна через tmp + rename, `remove` рекурсивна и ждёт бэкап);
  - `Deadline` (`lib/deadline.ts`);
  - `MIME`, `contentDisposition` (`lib/http.ts`);
  - `outputFormatsFor`, `TemplateExt`, `OutputFormat` (`@carbone-reports/shared`).
- Produces:
  - `RenderBody = { params }`; `RunDto.outputFormat: OutputFormat | null`, `RunDto.formats: OutputFormat[]`, `RunDto.readyFormats: OutputFormat[]`;
  - таблица `reportRunFiles` и колонка `reportRuns.snapshot` (drizzle), `RunRow.outputFormat: OutputFormat | null`;
  - `isLockTimeout(e): boolean`;
  - `renderReport(deps, tpl: TemplateFileRef, data, format, deadline?)`;
  - из `reports/snapshot.ts`: `RUN_FILE_LOCK_CLASS = 726100002`, `runDir`, `snapshotPaths`, `snapshotGone`, `formatUnavailable`, `snapshotExt`, `allowedFormats`, `resolveRunFormat`, `runFormats`, `runStoragePath` (его использует Task 2), `snapshotTemplateRef`, `writeSnapshot`, `renderFromSnapshot`, `ensureRunFile`;
  - веб: `runFileUrl(runId, { format?, inline? })` (её использует Task 3).

- [ ] **Step 1: Падающие тесты**

`packages/shared/src/index.test.ts` — в импорт добавить `RenderBody`; после `describe('outputFormatsFor', …)` (строка 122):

```ts
describe('RenderBody', () => {
  it('формата в теле больше нет: пришедший format отбрасывается (§24.4)', () => {
    expect(RenderBody.parse({ params: { a: 1 }, format: 'docx' })).toEqual({ params: { a: 1 } });
  });
});
```

`apps/api/src/lib/db-errors.test.ts` — в импорт добавить `isLockTimeout`; в `describe('db-errors', …)`:

```ts
  it('isLockTimeout узнаёт 55P03 в самой ошибке и в cause', () => {
    expect(isLockTimeout({ code: '55P03' })).toBe(true);
    expect(isLockTimeout({ cause: { code: '55P03' } })).toBe(true);
    expect(isLockTimeout({ code: '57014' })).toBe(false);
    expect(isLockTimeout(null)).toBe(false);
  });
```

`apps/api/src/modules/reports/snapshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  allowedFormats,
  resolveRunFormat,
  runFormats,
  runStoragePath,
  snapshotExt,
  snapshotPaths,
  snapshotTemplateRef,
} from './snapshot';

const snap = {
  id: 'r1',
  status: 'ok' as const,
  snapshot: true,
  outputFormat: null,
  filePath: 'reports/r1/template.xlsx',
  fileDeleted: false,
};
const legacy = {
  id: 'r2',
  status: 'ok' as const,
  snapshot: false,
  outputFormat: 'docx' as const,
  filePath: 'reports/r2.docx',
  fileDeleted: false,
};

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('исключения не было');
};
const UNAVAILABLE = {
  code: 'VALIDATION',
  status: 400,
  message: 'формат недоступен для этого отчёта',
};

describe('snapshotPaths / snapshotExt / runStoragePath', () => {
  it('всё о запуске — в reports/<runId>/', () => {
    const p = snapshotPaths('r1', 'docx');
    expect(p).toMatchObject({
      dir: 'reports/r1',
      data: 'reports/r1/data.json',
      template: 'reports/r1/template.docx',
    });
    expect(p.out('pdf')).toBe('reports/r1/out.pdf');
    expect(snapshotExt('reports/r1/template.pptx')).toBe('pptx');
  });
  it('удаляется каталог снимка или единственный файл старого запуска', () => {
    expect(runStoragePath(snap)).toBe('reports/r1');
    expect(runStoragePath(legacy)).toBe('reports/r2.docx');
  });
});

describe('resolveRunFormat', () => {
  it('снимок: без format — PDF; доступны форматы шаблона', () => {
    expect(resolveRunFormat(snap, undefined)).toBe('pdf');
    expect(resolveRunFormat(snap, 'xlsx')).toBe('xlsx');
    expect(resolveRunFormat(snap, 'ods')).toBe('ods');
  });
  it('снимок: формат вне outputFormatsFor(ext) → 400 VALIDATION', () => {
    for (const f of ['docx', 'pptx', 'exe', '']) {
      expect(errorOf(() => resolveRunFormat(snap, f))).toMatchObject(UNAVAILABLE);
    }
  });
  it('старый запуск: только output_format, он же по умолчанию', () => {
    expect(resolveRunFormat(legacy, undefined)).toBe('docx');
    expect(resolveRunFormat(legacy, 'docx')).toBe('docx');
    for (const f of ['pdf', 'odt']) {
      expect(errorOf(() => resolveRunFormat(legacy, f))).toMatchObject(UNAVAILABLE);
    }
  });
});

describe('runFormats', () => {
  it('снимок: все форматы шаблона; собранные — в порядке formats', () => {
    expect(runFormats(snap, ['xlsx', 'pdf'])).toEqual({
      formats: ['pdf', 'xlsx', 'ods'],
      readyFormats: ['pdf', 'xlsx'],
    });
  });
  it('старый запуск — только его формат, он же собран', () => {
    expect(runFormats(legacy, [])).toEqual({ formats: ['docx'], readyFormats: ['docx'] });
  });
  it('файл удалён или запуск с ошибкой — ничего', () => {
    const none = { formats: [], readyFormats: [] };
    expect(runFormats({ ...snap, fileDeleted: true }, ['pdf'])).toEqual(none);
    expect(runFormats({ ...snap, status: 'error', filePath: null }, [])).toEqual(none);
    expect(allowedFormats({ ...legacy, status: 'error' })).toEqual([]);
  });
});

describe('snapshotTemplateRef', () => {
  it('кэш Carbone ключуется по запуску; содержимое — копия из снимка', async () => {
    const file = Buffer.from('копия');
    const ref = snapshotTemplateRef('r1', 'docx', 3, file);
    expect(ref).toMatchObject({ id: 'run:r1', version: 3, ext: 'docx' });
    expect(await ref.read()).toBe(file);
  });
});
```

`apps/api/test/run-files.int.test.ts`:

```ts
import { createHash } from 'node:crypto';
import type { RunDto } from '@carbone-reports/shared';
import { and, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportRunFiles, reportRuns, templates } from '../src/db/schema';
import type { CarboneRenderer } from '../src/deps';
import { AppError } from '../src/lib/errors';
import { RUN_FILE_LOCK_CLASS } from '../src/modules/reports/snapshot';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  openTemplate,
  type SourceConn,
  type TestApp,
} from './helpers';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const GONE = 'файл удалён — сформируйте отчёт заново';
const UNAVAILABLE = { code: 'VALIDATION', message: 'формат недоступен для этого отчёта' };

let t: TestApp;
let admin: string;
let userA: string;
let userAId: string;
let userB: string;
let src: SourceConn;
let dsId: string;
let tplId: string;
let xlsxId: string;

const renders: { tplId: string; convertTo: string }[] = [];
let delayMs = 0;
let failWith: AppError | null = null;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Поддельный Carbone: отвечает JSON-описанием того, что получил.
const carbone: CarboneRenderer = {
  async render(tpl, data, opts) {
    renders.push({ tplId: tpl.id, convertTo: opts.convertTo });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failWith) throw failWith;
    return Buffer.from(
      JSON.stringify({
        tplId: tpl.id,
        version: tpl.version,
        tplSha: sha(await tpl.read()),
        data,
        convertTo: opts.convertTo,
      }),
    );
  },
};

const render = (cookie: string, id = tplId) =>
  t.app.inject({
    method: 'POST',
    url: `/api/reports/${id}/render`,
    headers: { cookie },
    payload: { params: {} },
  });
const file = (cookie: string, runId: string, q = '') =>
  t.app.inject({ method: 'GET', url: `/api/runs/${runId}/file${q}`, headers: { cookie } });
const newRun = async (cookie = userA, id = tplId): Promise<string> => {
  const r = await render(cookie, id);
  expect(r.statusCode).toBe(201);
  return r.json().runId as string;
};
const listed = async (cookie: string, runId: string): Promise<RunDto> =>
  (
    (await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie } })).json()
      .items as RunDto[]
  ).find((x) => x.id === runId)!;
const srcExec = async (q: string) => {
  const c = new pg.Client({
    host: src.host,
    port: src.port,
    database: src.database,
    user: src.username,
    password: src.password,
  });
  await c.connect();
  try {
    await c.query(q);
  } finally {
    await c.end();
  }
};
const tplRow = async () =>
  (await t.deps.db.select().from(templates).where(eq(templates.id, tplId)))[0]!;

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = (await loginAs(t, 'admin')).cookie;
  const a = await loginAs(t, 'user');
  userA = a.cookie;
  userAId = a.user.id;
  userB = (await loginAs(t, 'user')).cookie;
  src = await createSourceDatabase(
    'create table orders(id int, total numeric); insert into orders values (1, 100);',
  );
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: { name: 'src', ...src, sslMode: 'disable' },
  });
  dsId = ds.json().id;
  tplId = await createTemplate(t, admin, dsId, {
    public: true,
    queries: [{ key: 'orders', mode: 'list', sql: 'select id, total from orders order by id' }],
  });
  const x = await t.app.inject({
    method: 'POST',
    url: '/api/templates',
    headers: { cookie: admin },
    payload: { name: 'Таблица', datasourceId: dsId, blank: 'xlsx' },
  });
  xlsxId = x.json().id;
  await openTemplate(t, xlsxId);
});
afterAll(() => t.close());
beforeEach(() => {
  renders.length = 0;
  delayMs = 0;
  failWith = null;
});

describe('снимок запуска', () => {
  it('формирование создаёт снимок и PDF; Carbone получает копию шаблона под ключом запуска', async () => {
    const runId = await newRun();
    const [run] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, runId));
    expect(run).toMatchObject({
      status: 'ok',
      snapshot: true,
      outputFormat: null,
      filePath: `reports/${runId}/template.docx`,
    });
    expect(await t.deps.storage.read(`reports/${runId}/template.docx`)).toEqual(
      await t.deps.storage.read((await tplRow()).filePath),
    );
    expect(
      JSON.parse((await t.deps.storage.read(`reports/${runId}/data.json`)).toString('utf8')),
    ).toEqual({ orders: [{ id: 1, total: 100 }], params: {} });
    expect(await t.deps.storage.exists(`reports/${runId}/out.pdf`)).toBe(true);
    expect(renders).toEqual([{ tplId: `run:${runId}`, convertTo: 'pdf' }]);
    const files = await t.deps.db
      .select()
      .from(reportRunFiles)
      .where(eq(reportRunFiles.runId, runId));
    expect(files.map((f) => [f.format, f.filePath])).toEqual([
      ['pdf', `reports/${runId}/out.pdf`],
    ]);

    const pdf = await file(userA, runId, '?format=pdf&inline=1');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/^inline;/);
    expect(renders).toHaveLength(1); // PDF готов — повторного рендера нет
  });

  it('без format — PDF; DOCX собирается по требованию один раз, дальше отдаётся готовым', async () => {
    const runId = await newRun();
    const def = await file(userA, runId);
    expect(def.headers['content-type']).toBe('application/pdf');
    renders.length = 0;

    const d1 = await file(userA, runId, '?format=docx');
    expect(d1.statusCode).toBe(200);
    expect(d1.headers['content-type']).toBe(DOCX_MIME);
    expect(d1.headers['content-disposition']).toMatch(/^attachment; filename=".*\.docx"/);
    expect(JSON.parse(d1.body)).toMatchObject({ tplId: `run:${runId}`, convertTo: 'docx' });
    const d2 = await file(userA, runId, '?format=docx');
    expect(d2.body).toBe(d1.body);
    expect(renders).toEqual([{ tplId: `run:${runId}`, convertTo: 'docx' }]);
    expect(await t.deps.storage.exists(`reports/${runId}/out.docx`)).toBe(true);

    expect(await listed(userA, runId)).toMatchObject({
      outputFormat: null,
      fileAvailable: true,
      formats: ['pdf', 'docx', 'odt'],
      readyFormats: ['pdf', 'docx'],
    });
  });

  it('Excel-шаблон: просмотр PDF, XLSX и ODS по требованию; DOCX — 400', async () => {
    const runId = await newRun(userA, xlsxId);
    expect(renders).toEqual([{ tplId: `run:${runId}`, convertTo: 'pdf' }]);
    expect((await file(userA, runId, '?format=xlsx')).statusCode).toBe(200);
    expect((await file(userA, runId, '?format=ods')).statusCode).toBe(200);
    const docx = await file(userA, runId, '?format=docx');
    expect(docx.statusCode).toBe(400);
    expect(docx.json().error).toEqual(UNAVAILABLE);
    expect((await listed(userA, runId)).formats).toEqual(['pdf', 'xlsx', 'ods']);
  });

  it('файл собирается из снимка: данные в источнике и шаблон изменились', async () => {
    const runId = await newRun();
    const preview = JSON.parse((await file(userA, runId)).body);
    const tpl = await tplRow();
    const original = await t.deps.storage.read(tpl.filePath);
    await srcExec('insert into orders values (2, 999)');
    await t.deps.storage.write(tpl.filePath, Buffer.from('другой шаблон'));
    await t.deps.db
      .update(templates)
      .set({ version: tpl.version + 1 })
      .where(eq(templates.id, tplId));
    try {
      const docx = JSON.parse((await file(userA, runId, '?format=docx')).body);
      expect(docx.data).toEqual(preview.data);
      expect(docx.tplSha).toBe(preview.tplSha);
      expect(docx.version).toBe(preview.version);
      expect(docx.tplId).toBe(`run:${runId}`);
      // Новый запуск видит новые данные и новый шаблон.
      const fresh = JSON.parse((await file(userA, await newRun())).body);
      expect(fresh.tplSha).toBe(sha(Buffer.from('другой шаблон')));
      expect(fresh.data.orders).toHaveLength(2);
    } finally {
      await srcExec('delete from orders where id = 2');
      await t.deps.storage.write(tpl.filePath, original);
    }
  });

  it('два одновременных запроса DOCX — одна сборка, оба получают один и тот же файл', async () => {
    const runId = await newRun();
    renders.length = 0;
    delayMs = 300;
    const [a, b] = await Promise.all([
      file(userA, runId, '?format=docx'),
      file(userA, runId, '?format=docx'),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.body).toBe(b.body);
    expect(renders).toEqual([{ tplId: `run:${runId}`, convertTo: 'docx' }]);
  });

  it('недопустимый формат → 400 VALIDATION; ничего не собирается', async () => {
    const runId = await newRun();
    renders.length = 0;
    for (const q of ['?format=xlsx', '?format=pptx', '?format=exe', '?format=']) {
      const r = await file(userA, runId, q);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toEqual(UNAVAILABLE);
    }
    expect(renders).toHaveLength(0);
  });

  it('старый запуск: только его формат, без format — он же; в истории formats = [его формат]', async () => {
    const id = crypto.randomUUID();
    await t.deps.storage.write(`reports/${id}.docx`, Buffer.from('old-docx'));
    await t.deps.db.insert(reportRuns).values({
      id,
      templateId: tplId,
      templateName: 'старый',
      templateVersion: 1,
      userId: userAId,
      params: {},
      outputFormat: 'docx',
      status: 'ok',
      filePath: `reports/${id}.docx`,
      durationMs: 1,
    });
    const def = await file(userA, id);
    expect(def.statusCode).toBe(200);
    expect(def.headers['content-type']).toBe(DOCX_MIME);
    expect(def.body).toBe('old-docx');
    expect((await file(userA, id, '?format=docx')).body).toBe('old-docx');
    const pdf = await file(userA, id, '?format=pdf');
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json().error).toEqual(UNAVAILABLE);
    expect(await listed(userA, id)).toMatchObject({
      outputFormat: 'docx',
      fileAvailable: true,
      formats: ['docx'],
      readyFormats: ['docx'],
    });
    expect(renders).toHaveLength(0);
  });

  it('снимок удалён → 410 «файл удалён — сформируйте отчёт заново», сборки нет', async () => {
    const runId = await newRun();
    await t.deps.storage.remove(`reports/${runId}`);
    renders.length = 0;
    for (const q of ['?format=docx', '']) {
      const r = await file(userA, runId, q);
      expect(r.statusCode).toBe(410);
      expect(r.json().error).toEqual({ code: 'GONE', message: GONE });
    }
    expect(renders).toHaveLength(0);

    const expired = await newRun();
    await t.deps.db
      .update(reportRuns)
      .set({ fileDeleted: true })
      .where(eq(reportRuns.id, expired));
    const r = await file(userA, expired, '?format=odt');
    expect(r.statusCode).toBe(410);
    expect(r.json().error.message).toBe(GONE);
    expect(await listed(userA, expired)).toMatchObject({
      fileAvailable: false,
      formats: [],
      readyFormats: [],
    });
  });

  it('ошибка сборки возвращается как есть; статус запуска не меняется; повтор собирает заново', async () => {
    const runId = await newRun();
    const message =
      'в шаблоне используется aggSum — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»';
    failWith = new AppError('CARBONE_COMMUNITY', 400, message);
    const r = await file(userA, runId, '?format=docx');
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: 'CARBONE_COMMUNITY', message });
    failWith = null;
    const [run] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, runId));
    expect(run).toMatchObject({ status: 'ok', error: null, fileDeleted: false });
    expect(await t.deps.storage.exists(`reports/${runId}/out.docx`)).toBe(false);
    expect((await listed(userA, runId)).readyFormats).toEqual(['pdf']);
    expect((await file(userA, runId, '?format=docx')).statusCode).toBe(200);
  });

  it('чужой запуск → 404 без сборки; админ — 200', async () => {
    const runId = await newRun(userB);
    renders.length = 0;
    expect((await file(userA, runId, '?format=docx')).statusCode).toBe(404);
    expect(renders).toHaveLength(0);
    expect((await file(admin, runId, '?format=docx')).statusCode).toBe(200);
  });

  it('ошибка Carbone при формировании → 502; запуск со status=error без формата и снимка; каталог удалён', async () => {
    failWith = new AppError('CARBONE_ERROR', 502, 'ошибка генерации: boom');
    const r = await render(userA);
    expect(r.statusCode).toBe(502);
    const [run] = await t.deps.db
      .select()
      .from(reportRuns)
      .where(and(eq(reportRuns.userId, userAId), eq(reportRuns.status, 'error')))
      .orderBy(desc(reportRuns.createdAt))
      .limit(1);
    expect(run).toMatchObject({
      status: 'error',
      error: 'ошибка генерации: boom',
      snapshot: false,
      outputFormat: null,
      filePath: null,
    });
    await expect.poll(() => t.deps.storage.exists(`reports/${run!.id}`)).toBe(false);
    expect(await listed(userA, run!.id)).toMatchObject({ formats: [], readyFormats: [] });
  });
});

describe('срок сборки', () => {
  let s: TestApp;
  let sUser: string;
  let sTpl: string;
  let slowMs = 0;
  let slowRenders = 0;
  const slow: CarboneRenderer = {
    async render(_tpl, _data, opts) {
      if (opts.convertTo === 'pdf') return Buffer.from('%PDF');
      slowRenders++;
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      return Buffer.from(`собран ${opts.convertTo}`);
    },
  };

  beforeAll(async () => {
    s = await createTestApp({ carbone: slow }, { reportTimeoutMs: 600 });
    const sAdmin = (await loginAs(s, 'admin')).cookie;
    sUser = (await loginAs(s, 'user')).cookie;
    const ds = await s.app.inject({
      method: 'POST',
      url: '/api/datasources',
      headers: { cookie: sAdmin },
      payload: { name: 'src', ...src, sslMode: 'disable' },
    });
    sTpl = await createTemplate(s, sAdmin, ds.json().id, { public: true });
  });
  afterAll(() => s.close());
  beforeEach(() => {
    slowMs = 0;
    slowRenders = 0;
  });

  const newSlowRun = async () =>
    (
      await s.app.inject({
        method: 'POST',
        url: `/api/reports/${sTpl}/render`,
        headers: { cookie: sUser },
        payload: { params: {} },
      })
    ).json().runId as string;
  const getDocx = (runId: string) =>
    s.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/file?format=docx`,
      headers: { cookie: sUser },
    });

  it('ожидание чужой сборки ограничено сроком (lock_timeout) и не вызывает Carbone', async () => {
    const runId = await newSlowRun();
    // Чужая сборка — тот же ключ, что берёт API: (726100002, hashtext('<runId>:docx')).
    const holder = new pg.Client({ connectionString: s.deps.config.databaseUrl });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock($1::int, hashtext($2))', [
        RUN_FILE_LOCK_CLASS,
        `${runId}:docx`,
      ]);
      const started = Date.now();
      const r = await getDocx(runId);
      expect(Date.now() - started).toBeLessThan(1200);
      expect(r.statusCode).toBe(504);
      expect(r.json().error.message).toBe('превышено время формирования отчёта');
      expect(slowRenders).toBe(0);
    } finally {
      await holder.end(); // закрытие сессии снимает блокировку
    }
    const ok = await getDocx(runId);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('собран docx');
  });

  it('сборка, прерванная по сроку, снимает блокировку и не оставляет файла', async () => {
    const runId = await newSlowRun();
    slowMs = 1500;
    const started = Date.now();
    const r = await getDocx(runId);
    expect(Date.now() - started).toBeLessThan(1200);
    expect(r.statusCode).toBe(504);
    expect(
      await s.deps.db.select().from(reportRunFiles).where(eq(reportRunFiles.runId, runId)),
    ).toHaveLength(1); // только pdf
    expect(await s.deps.storage.exists(`reports/${runId}/out.docx`)).toBe(false);
    slowMs = 0;
    const again = await getDocx(runId);
    expect(again.statusCode).toBe(200);
    expect(slowRenders).toBe(2);
  });
});
```

`apps/api/test/reports.int.test.ts`, строки 160–163 — заменить тест «формат, недоступный для шаблона → 400»:

```ts
  it('format в теле игнорируется: 201, файл по умолчанию — PDF', async () => {
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'xlsx' });
    expect(r.statusCode).toBe(201);
    const file = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${r.json().runId}/file`,
      headers: { cookie: userA },
    });
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(JSON.parse(file.body).convertTo).toBe('pdf');
  });
```

Там же строки 274–275 (тест «файл отчёта удалён с диска → 410»): у запуска со снимком `filePath` — копия шаблона, а удалить надо весь каталог:

```ts
    await t.deps.storage.remove(`reports/${runId}`);
```
Строку `const [run] = …` (274) убрать. `reportRuns` (строка 5) и `eq` (строка 2) используются в файле только там, поэтому оба импорта тоже убрать, иначе упадёт lint.

`apps/api/test/db.int.test.ts`, в `arrayContaining` (строки 17–24) добавить `'report_run_files',`.

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/shared exec vitest run && pnpm --filter @carbone-reports/api exec vitest run src/lib/db-errors.test.ts src/modules/reports/snapshot.test.ts
```
Ожидание: FAIL — `RenderBody` оставляет `format` или не принимает тело без него, `isLockTimeout` и `./snapshot` не существуют.

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/run-files.int.test.ts test/reports.int.test.ts test/db.int.test.ts
```
Ожидание: FAIL — модуль `snapshot` не найден, нет таблицы `report_run_files`.

- [ ] **Step 2: Схема, миграция и DTO**

`packages/shared/src/index.ts`, строки 307–308:

```ts
/** Формата при формировании нет (§24.4): лишний `format` zod отбрасывает. */
export const RenderBody = z.object({ params: ParamsInput });
export type RenderBody = z.infer<typeof RenderBody>;
```

Там же, `RunDto` (строки 323–338):

```ts
export const RunDto = z.object({
  id: z.string(),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  templateVersion: z.number(),
  userId: z.string(),
  userLogin: z.string(),
  params: ParamsInput,
  /** Формат запуска до Плана 13; у запусков со снимком — null. */
  outputFormat: OutputFormat.nullable(),
  status: z.enum(['ok', 'error']),
  error: z.string().nullable(),
  fileAvailable: z.boolean(),
  /** Форматы, доступные для скачивания (§24.4). */
  formats: z.array(OutputFormat),
  /** Уже собранные форматы. */
  readyFormats: z.array(OutputFormat),
  durationMs: z.number(),
  createdAt: z.string(),
});
export type RunDto = z.infer<typeof RunDto>;
```

`apps/api/src/db/schema.ts`, `reportRuns` (строки 177–193):

```ts
export const reportRuns = pgTable('report_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
  templateName: text('template_name').notNull(),
  templateVersion: integer('template_version').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  params: jsonb('params').$type<Record<string, ParamValue>>().notNull(),
  /** Формат старого запуска (snapshot = false); у новых — null, файлы в report_run_files. */
  outputFormat: text('output_format').$type<OutputFormat>(),
  status: text('status').$type<'ok' | 'error'>().notNull(),
  error: text('error'),
  /** Старый запуск — его единственный файл; запуск со снимком — копия шаблона `reports/<id>/template.<ext>`. */
  filePath: text('file_path'),
  fileDeleted: boolean('file_deleted').notNull().default(false),
  /** Запуск со снимком (§24.2): данные и копия шаблона в `reports/<id>/`. */
  snapshot: boolean('snapshot').notNull().default(false),
  durationMs: integer('duration_ms').notNull(),
  createdAt: createdAt(),
});

/** Собранные из снимка файлы запуска (§24.3). */
export const reportRunFiles = pgTable(
  'report_run_files',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => reportRuns.id, { onDelete: 'cascade' }),
    format: text('format').$type<OutputFormat>().notNull(),
    filePath: text('file_path').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.format] })],
);
```

Там же, после `export type RunRow = …` (строка 200):

```ts
export type RunFileRow = typeof reportRunFiles.$inferSelect;
```

Миграция:

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api db:generate --name run_files
```
Ожидание:
- файл `apps/api/drizzle/0006_run_files.sql`, `meta/0006_snapshot.json`, запись `idx: 6` в `_journal.json`;
- в SQL (порядок операторов может отличаться): `CREATE TABLE "report_run_files" (… CONSTRAINT "report_run_files_run_id_format_pk" PRIMARY KEY("run_id","format"))`, `ALTER TABLE "report_runs" ALTER COLUMN "output_format" DROP NOT NULL;`, `ALTER TABLE "report_runs" ADD COLUMN "snapshot" boolean DEFAULT false NOT NULL;` и внешний ключ `… FOREIGN KEY ("run_id") REFERENCES "public"."report_runs"("id") ON DELETE cascade`.

Ручных правок нет. Заполнять ничего не нужно: существующие строки получают `snapshot = false` и сохраняют `output_format`, то есть остаются «старыми запусками» (§24.3). Обе операции `ALTER` — только изменение каталога, без перезаписи таблицы. Повторный `db:generate` должен сообщить «No schema changes»; лишний сгенерированный файл, если появится, удалить. Если генератор задаёт вопрос интерактивно (переименование колонки/таблицы), ответить «create» — переименований здесь нет.

- [ ] **Step 3: `isLockTimeout`, `renderReport` и модуль снимка**

`apps/api/src/lib/db-errors.ts`, в конец:

```ts

/** Истёк lock_timeout Postgres (55P03): блокировку не дождались. */
export const isLockTimeout = (e: unknown): boolean =>
  (e as { code?: string })?.code === '55P03' ||
  (e as { cause?: { code?: string } })?.cause?.code === '55P03';
```

`apps/api/src/modules/reports/service.ts`:
- импорты (строки 1–15):

```ts
import {
  CARBONE_LANG,
  type OutputFormat,
  type ParamValue,
  type ParamsInput,
} from '@carbone-reports/shared';
import type { AppDeps, TemplateFileRef } from '../../deps';
import { type Deadline, reportTimeout } from '../../lib/deadline';
import { AppError } from '../../lib/errors';
import { buildReportData } from '../queries/build-data';
import { runQueries } from '../queries/executor';
import { validateQueryParams } from '../queries/param-options';
import { resolveParams } from '../queries/params';
import type { TemplateFull } from '../templates/service';
```

- строки 60–83 (`assertFormat` удаляется: формат при формировании больше не передаётся, проверка формата файла — `resolveRunFormat`):

```ts
/**
 * Рендер в Carbone. С `deadline` таймаут Carbone — не дольше остатка срока, ожидание ограничено сроком.
 * `tpl` — живой файл шаблона (предпросмотр админа) или копия из снимка запуска.
 */
export function renderReport(
  deps: AppDeps,
  tpl: TemplateFileRef,
  data: unknown,
  format: OutputFormat,
  deadline?: Deadline,
): Promise<Buffer> {
  // Срок уже истёк — не нагружать Carbone заведомо прерванной задачей.
  if (deadline && deadline.remaining() <= 0) return Promise.reject(reportTimeout());
  const work = deps.carbone.render(tpl, data, {
    convertTo: format,
    lang: CARBONE_LANG,
    timezone: deps.config.tz,
    timeoutMs: deadline ? deadline.cap(deps.config.renderTimeoutMs) : deps.config.renderTimeoutMs,
  });
  return deadline ? deadline.race(work) : work;
}
```

`apps/api/src/modules/reports/snapshot.ts`:

```ts
import { posix } from 'node:path';
import { outputFormatsFor, TemplateExt, type OutputFormat } from '@carbone-reports/shared';
import { and, eq, sql } from 'drizzle-orm';
import { reportRunFiles, reportRuns, type RunRow } from '../../db/schema';
import type { AppDeps, TemplateFileRef } from '../../deps';
import { isLockTimeout } from '../../lib/db-errors';
import { type Deadline, reportTimeout } from '../../lib/deadline';
import { AppError } from '../../lib/errors';
import { renderReport } from './service';

/**
 * Класс advisory-блокировок «сборка файла запуска». Ключ — пара int4 (класс, hashtext('<runId>:<формат>')):
 * пространство пар не пересекается с bigint-ключом бэкапа STORAGE_REMOVE_LOCK_KEY (lib/storage-gate.ts).
 * Блокировка живёт в общей БД, поэтому одна сборка на запуск и формат соблюдается для любого числа экземпляров API.
 */
export const RUN_FILE_LOCK_CLASS = 726100002;

export const runDir = (runId: string) => `reports/${runId}`;

/** Всё о запуске со снимком — в `reports/<runId>/` (§24.2). */
export function snapshotPaths(runId: string, ext: TemplateExt) {
  const dir = runDir(runId);
  return {
    dir,
    data: `${dir}/data.json`,
    template: `${dir}/template.${ext}`,
    out: (format: OutputFormat) => `${dir}/out.${format}`,
  };
}

export const snapshotGone = () =>
  new AppError('GONE', 410, 'файл удалён — сформируйте отчёт заново');
export const formatUnavailable = () =>
  new AppError('VALIDATION', 400, 'формат недоступен для этого отчёта');

type RunFileFields = Pick<
  RunRow,
  'id' | 'status' | 'snapshot' | 'outputFormat' | 'filePath' | 'fileDeleted'
>;

/** У запуска со снимком file_path — копия шаблона `reports/<runId>/template.<ext>`. */
export function snapshotExt(filePath: string): TemplateExt {
  return TemplateExt.parse(posix.extname(filePath).slice(1));
}

/** Форматы файла запуска: снимок — все форматы шаблона, старый запуск — только его формат. */
export function allowedFormats(run: RunFileFields): OutputFormat[] {
  if (run.status !== 'ok' || !run.filePath) return [];
  if (run.snapshot) return outputFormatsFor(snapshotExt(run.filePath));
  return run.outputFormat ? [run.outputFormat] : [];
}

/** Формат запроса файла (§24.4): без `format` — PDF у снимка и `output_format` у старого запуска. */
export function resolveRunFormat(run: RunFileFields, requested: string | undefined): OutputFormat {
  const want = requested ?? (run.snapshot ? 'pdf' : run.outputFormat);
  const format = allowedFormats(run).find((f) => f === want);
  if (!format) throw formatUnavailable();
  return format;
}

/** Поля истории: доступные и уже собранные форматы (в порядке `formats`). */
export function runFormats(
  run: RunFileFields,
  built: readonly OutputFormat[],
): { formats: OutputFormat[]; readyFormats: OutputFormat[] } {
  if (run.fileDeleted) return { formats: [], readyFormats: [] };
  const formats = allowedFormats(run);
  return {
    formats,
    readyFormats: run.snapshot ? formats.filter((f) => built.includes(f)) : formats,
  };
}

/** Что удалить в хранилище: каталог снимка целиком или единственный файл старого запуска. */
export function runStoragePath(run: Pick<RunRow, 'id' | 'snapshot' | 'filePath'>): string | null {
  return run.snapshot ? runDir(run.id) : run.filePath;
}

/**
 * Копия шаблона для Carbone. id `run:<runId>` — ключ кэша id шаблона Carbone (§24.2): копия загружается
 * как обычный шаблон, а замена живого шаблона не влияет на запуск.
 */
export function snapshotTemplateRef(
  runId: string,
  ext: TemplateExt,
  version: number,
  file: Buffer,
): TemplateFileRef {
  return { id: `run:${runId}`, version, ext, read: async () => file };
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

async function readSnapshotFile(deps: AppDeps, path: string): Promise<Buffer> {
  try {
    return await deps.storage.read(path);
  } catch (e) {
    if (isEnoent(e)) throw snapshotGone();
    throw e;
  }
}

export async function writeSnapshot(
  deps: AppDeps,
  runId: string,
  ext: TemplateExt,
  data: unknown,
  template: Buffer,
): Promise<void> {
  const p = snapshotPaths(runId, ext);
  await deps.storage.write(p.data, Buffer.from(JSON.stringify(data)));
  await deps.storage.write(p.template, template);
}

/**
 * Рендер формата только из снимка: данные и шаблон читаются из каталога запуска до вызова Carbone
 * (нет файла — 410, а не «сервис генерации недоступен»).
 */
export async function renderFromSnapshot(
  deps: AppDeps,
  runId: string,
  ext: TemplateExt,
  version: number,
  format: OutputFormat,
  deadline: Deadline,
): Promise<Buffer> {
  const p = snapshotPaths(runId, ext);
  const [data, template] = await Promise.all([
    readSnapshotFile(deps, p.data),
    readSnapshotFile(deps, p.template),
  ]);
  return renderReport(
    deps,
    snapshotTemplateRef(runId, ext, version, template),
    JSON.parse(data.toString('utf8')) as unknown,
    format,
    deadline,
  );
}

/** Готовый файл формата или сборка из снимка под блокировкой; всё — в пределах `deadline`. */
export async function ensureRunFile(
  deps: AppDeps,
  run: RunRow,
  format: OutputFormat,
  deadline: Deadline,
): Promise<Buffer> {
  const [ready] = await deps.db
    .select({ filePath: reportRunFiles.filePath })
    .from(reportRunFiles)
    .where(and(eq(reportRunFiles.runId, run.id), eq(reportRunFiles.format, format)));
  if (ready) return readSnapshotFile(deps, ready.filePath);
  return deadline.race(buildRunFile(deps, run, format, deadline));
}

async function buildRunFile(
  deps: AppDeps,
  run: RunRow,
  format: OutputFormat,
  deadline: Deadline,
): Promise<Buffer> {
  const ext = snapshotExt(run.filePath!);
  try {
    return await deps.db.transaction(async (tx) => {
      // Ждать чужую сборку — не дольше остатка срока; set_config(..., true) действует до конца транзакции.
      const wait = `${deadline.cap(deps.config.reportTimeoutMs)}ms`;
      await tx.execute(sql`select set_config('lock_timeout', ${wait}, true)`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_FILE_LOCK_CLASS}::int, hashtext(${`${run.id}:${format}`}::text))`,
      );
      // FOR SHARE: очистка и удаление пользователя ждут конца сборки и удаляют каталог уже с новым файлом.
      const [cur] = await tx
        .select({ fileDeleted: reportRuns.fileDeleted })
        .from(reportRuns)
        .where(eq(reportRuns.id, run.id))
        .for('share');
      if (!cur || cur.fileDeleted) throw snapshotGone();
      // Пока ждали блокировку, файл мог собрать другой запрос.
      const [done] = await tx
        .select({ filePath: reportRunFiles.filePath })
        .from(reportRunFiles)
        .where(and(eq(reportRunFiles.runId, run.id), eq(reportRunFiles.format, format)));
      if (done) return await readSnapshotFile(deps, done.filePath);
      const file = await renderFromSnapshot(
        deps,
        run.id,
        ext,
        run.templateVersion,
        format,
        deadline,
      );
      const out = snapshotPaths(run.id, ext).out(format);
      await deps.storage.write(out, file);
      await tx.insert(reportRunFiles).values({ runId: run.id, format, filePath: out });
      return file;
    });
  } catch (e) {
    if (isLockTimeout(e)) throw reportTimeout();
    throw e;
  }
}
```

- [ ] **Step 4: Маршруты**

`apps/api/src/modules/reports/routes.ts`, импорты (строки 1–27):

```ts
import { randomUUID } from 'node:crypto';
import {
  IdParams,
  type OutputFormat,
  type ParamsInput,
  type ParamValue,
  PreviewBody,
  RenderBody,
  RunQueryBody,
  RUNS_PAGE_SIZE,
  RunsQuery,
  type RunDto,
  type RunsPage,
} from '@carbone-reports/shared';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { App } from '../../app';
import { reportRunFiles, reportRuns, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { Deadline } from '../../lib/deadline';
import { AppError, notFound } from '../../lib/errors';
import { contentDisposition, MIME } from '../../lib/http';
import { assertTemplateAccess } from '../access/access';
import { currentUser, type Guards } from '../auth/guards';
import { previewQuery } from '../queries/executor';
import { resolveParams } from '../queries/params';
import { loadTemplateFull, templateFileRef, type TemplateFull } from '../templates/service';
import { collectReportData, renderReport } from './service';
import {
  ensureRunFile,
  renderFromSnapshot,
  resolveRunFormat,
  runFormats,
  snapshotGone,
  snapshotPaths,
  writeSnapshot,
} from './snapshot';
```

Рендер (строки 47–100):

```ts
  app.post(
    '/api/reports/:id/render',
    { preHandler: guards.requireUser, schema: { params: IdParams, body: RenderBody } },
    async (req, reply) => {
      // Срок отсчитывается от начала обработки запроса.
      const deadline = new Deadline(deps.config.reportTimeoutMs);
      const user = currentUser(req);
      // До загрузки и до любой записи запуска: недоступный шаблон не оставляет следов в истории.
      await assertTemplateAccess(db, user, req.params.id);
      const full = await loadTemplateFull(db, req.params.id);
      const runId = randomUUID();
      const started = Date.now();
      const ext = full.row.fileExt;
      const snap = snapshotPaths(runId, ext);
      const base = {
        id: runId,
        templateId: full.row.id,
        templateName: full.row.name,
        templateVersion: full.row.version,
        userId: user.id,
      };
      let snapshotStarted = false;
      try {
        const { data, params } = await collectReportData(deps, full, req.body.params, deadline);
        // Снимок (§24.2): данные и копия файла шаблона; любой формат запуска собирается только из него.
        snapshotStarted = true;
        await writeSnapshot(deps, runId, ext, data, await templateFileRef(deps, full.row).read());
        const pdf = await renderFromSnapshot(deps, runId, ext, full.row.version, 'pdf', deadline);
        await storage.write(snap.out('pdf'), pdf);
        await db.transaction(async (tx) => {
          await tx.insert(reportRuns).values({
            ...base,
            params,
            status: 'ok',
            snapshot: true,
            filePath: snap.template,
            durationMs: Date.now() - started,
          });
          await tx
            .insert(reportRunFiles)
            .values({ runId, format: 'pdf', filePath: snap.out('pdf') });
        });
        return reply.status(201).send({ runId });
      } catch (e) {
        // Незавершённый снимок не нужен. Удаление не ждём: во время бэкапа удаления стоят в очереди.
        if (snapshotStarted) {
          void storage
            .remove(snap.dir)
            .catch((err) => req.log.warn({ err, runId }, 'снимок запуска не удалён'));
        }
        // Ошибки ввода пользователя историю не засоряют.
        if (!(e instanceof AppError && e.code === 'VALIDATION')) {
          try {
            await db.insert(reportRuns).values({
              ...base,
              params: paramsForErrorRun(full, req.body.params),
              status: 'error',
              error: e instanceof AppError ? e.message : 'внутренняя ошибка сервера',
              durationMs: Date.now() - started,
            });
          } catch (insertErr) {
            req.log.error(insertErr);
          }
        }
        throw e;
      }
    },
  );
```

История: после `const [rows, [totalRow]] = await Promise.all(…)` (строка 126) и вместо `items` (строки 128–142):

```ts
      // Собранные форматы — только для запусков со снимком на этой странице.
      const snapIds = rows.filter(({ run }) => run.snapshot).map(({ run }) => run.id);
      const built = new Map<string, OutputFormat[]>();
      if (snapIds.length > 0) {
        const files = await db
          .select({ runId: reportRunFiles.runId, format: reportRunFiles.format })
          .from(reportRunFiles)
          .where(inArray(reportRunFiles.runId, snapIds));
        for (const f of files) built.set(f.runId, [...(built.get(f.runId) ?? []), f.format]);
      }

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
        ...runFormats(run, built.get(run.id) ?? []),
        durationMs: run.durationMs,
        createdAt: run.createdAt.toISOString(),
      }));
```

Файл (строки 147–183):

```ts
  app.get(
    '/api/runs/:id/file',
    {
      preHandler: guards.requireUser,
      schema: {
        params: IdParams,
        querystring: z.object({
          // Строка, а не enum: любой недоступный формат — одна ошибка «формат недоступен…» (§24.4).
          format: z.string().max(16).optional(),
          inline: z.enum(['0', '1']).optional(),
        }),
      },
    },
    async (req, reply) => {
      // Сборка из снимка — в общем сроке, отсчёт от начала запроса на скачивание (§24.2).
      const deadline = new Deadline(deps.config.reportTimeoutMs);
      const me = currentUser(req);
      const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, req.params.id));
      // Чужой запуск для пользователя неотличим от несуществующего.
      if (!run || (me.role !== 'admin' && run.userId !== me.id)) throw notFound('запуск');
      if (run.status !== 'ok' || !run.filePath) throw notFound('файл');
      const format = resolveRunFormat(run, req.query.format);
      let content: Buffer;
      if (run.snapshot) {
        if (run.fileDeleted) throw snapshotGone();
        // Ошибка сборки (в том числе CARBONE_COMMUNITY) уходит как есть; статус запуска не меняется.
        content = await ensureRunFile(deps, run, format, deadline);
      } else {
        if (run.fileDeleted) throw new AppError('GONE', 410, 'файл удалён по сроку хранения');
        try {
          content = await storage.read(run.filePath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            throw new AppError('GONE', 410, 'файл удалён по сроку хранения');
          throw e;
        }
      }
      const date = run.createdAt.toISOString().slice(0, 10);
      return reply
        .header('content-type', MIME[format])
        .header(
          'content-disposition',
          contentDisposition(`${run.templateName} ${date}.${format}`, req.query.inline === '1'),
        )
        .send(content);
    },
  );
```

Предпросмотр (строка 208):

```ts
      const pdf = await renderReport(deps, templateFileRef(deps, full.row), data, 'pdf', deadline);
```

- [ ] **Step 5: Совместимость веба с новым DTO**

Веб в этой задаче не меняет интерфейс. Он только перестаёт слать `format` и скачивает выбранный переключателем формат через `?format=`. Это рабочее промежуточное состояние; «Сохранить как» — в Task 3.

`apps/web/src/api/endpoints.ts`: в импорт типов из `@carbone-reports/shared` (строки 1–29) добавить `OutputFormat,`. Строки 139–140:

```ts
export const runFileUrl = (
  runId: string,
  opts: { format?: OutputFormat; inline?: boolean } = {},
) => {
  const sp = new URLSearchParams();
  if (opts.format) sp.set('format', opts.format);
  if (opts.inline) sp.set('inline', '1');
  const qs = sp.toString();
  return `/api/runs/${runId}/file${qs ? `?${qs}` : ''}`;
};
```

`apps/web/src/pages/ReportRunPage.tsx`:
- строка 42: `mutationFn: () => api.reports.render(id, { params: pickParams(t!.params, values) }),`
- строка 45: `if (format !== 'pdf') triggerDownload(runFileUrl(runId, { format }));`
- строка 130: `<Button view="outlined" href={runFileUrl(run.id, { format: run.format })}>`
- строка 137: `src={runFileUrl(run.id, { inline: true })}`

`apps/web/src/pages/HistoryPage.tsx`, строка 93:

```tsx
    { id: 'format', name: 'Формат', template: (r) => r.outputFormat?.toUpperCase() ?? '—', width: 80 },
```

`apps/web/src/pages/ReportRunPage.test.tsx`:
- строки 48–51: ожидаемый `href` — `'/api/runs/r1/file?format=pdf'`;
- строка 53: `expect(body).toEqual({ params: { company: 'ООО Ромашка', limit: 5 } });`
- строка 67: `await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/runs/r2/file?format=docx'));`
- строки 241–244: `expect(calls.find((c) => c.path === '/api/reports/t1/render')?.body).toEqual({ params: { region: 7 } }),`

- [ ] **Step 6: Запуск — должно пройти**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/shared exec vitest run && pnpm --filter @carbone-reports/api exec vitest run && pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/run-files.int.test.ts test/reports.int.test.ts test/db.int.test.ts test/cleanup.int.test.ts test/access.int.test.ts test/param-options.int.test.ts test/hardening.int.test.ts && pnpm --filter @carbone-reports/web exec vitest run src/pages/ReportRunPage.test.tsx src/pages/HistoryPage.test.tsx
```
Ожидание: все зелёные. Прежние тесты, которые шлют `format: 'pdf'`, проходят: поле игнорируется. `cleanup.int` и `hardening.int` вставляют старые запуски с `outputFormat`, а колонка теперь просто nullable.

```bash
cd /Users/sam/carbone-reports && source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api db:generate --name check_no_changes
```
Ожидание: «No schema changes, nothing to migrate»; файл не создан.

- [ ] **Step 7: Гейты и коммит**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm test:int
git add packages/shared/src/index.ts packages/shared/src/index.test.ts apps/api/src/db/schema.ts apps/api/drizzle/0006_run_files.sql apps/api/drizzle/meta/0006_snapshot.json apps/api/drizzle/meta/_journal.json apps/api/src/lib/db-errors.ts apps/api/src/lib/db-errors.test.ts apps/api/src/modules/reports/service.ts apps/api/src/modules/reports/snapshot.ts apps/api/src/modules/reports/snapshot.test.ts apps/api/src/modules/reports/routes.ts apps/api/test/run-files.int.test.ts apps/api/test/reports.int.test.ts apps/api/test/db.int.test.ts apps/web/src/api/endpoints.ts apps/web/src/pages/ReportRunPage.tsx apps/web/src/pages/ReportRunPage.test.tsx apps/web/src/pages/HistoryPage.tsx
git commit -m "feat(api): run snapshot, PDF on render, other formats built on demand under advisory lock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Очистка, удаление пользователя, кэш Carbone в памяти, smoke (§24.2, §24.5)

**Files:**
- Modify: `apps/api/src/modules/reports/cleanup.ts:1-34`
- Modify: `apps/api/test/cleanup.int.test.ts:1-5` (импорт), новый тест после `:83`
- Modify: `apps/api/src/modules/users/routes.ts:1-10` (импорт), `:118-137`
- Modify: `apps/api/test/hardening.int.test.ts:3` (импорт), новый тест после `:124`
- Modify: `apps/api/src/modules/carbone/template-cache.ts:14-27`
- Modify: `apps/api/src/modules/carbone/template-cache.test.ts:3` (импорт), новый тест после `:17`
- Modify: `scripts/smoke.ts:82-96`, `:112-114`, `:139-142`, `:274-286`

**Interfaces:**
- Consumes:
  - `runStoragePath(run)`, `reportRunFiles` (Task 1);
  - `Storage.remove` — рекурсивная, ждёт бэкап;
  - сборка из Task 1 держит строку запуска `FOR SHARE`, поэтому `UPDATE report_runs` очистки и каскадный `DELETE` при удалении пользователя ждут её конца.
- Produces:
  - `cleanupOldReports` для снимков: в одной транзакции ставит `file_deleted = true` и удаляет строки `report_run_files`, затем удаляет каталог `reports/<runId>/`; для старых запусков поведение прежнее;
  - удаление пользователя удаляет каталоги снимков;
  - `memoryTemplateCache(limit = 1000)` — не больше `limit` записей, вытесняется самая давняя запись;
  - smoke скачивает файл формата через `?format=` и после пересоздания Carbone проверяет DOCX запуска, сделанного до пересоздания.

- [ ] **Step 1: Падающие тесты**

`apps/api/test/cleanup.int.test.ts` — импорт схемы: `import { reportRunFiles, reportRuns } from '../src/db/schema';`. После теста «скачивание удалённого файла → 410» (строка 83), внутри `describe`:

```ts
  it('запуск со снимком: удаляется весь каталог и строки report_run_files; скачивание → 410', async () => {
    const snapshotRun = async (daysAgo: number) => {
      const id = crypto.randomUUID();
      const dir = `reports/${id}`;
      await t.deps.storage.write(`${dir}/data.json`, Buffer.from('{}'));
      await t.deps.storage.write(`${dir}/template.docx`, Buffer.from('tpl'));
      await t.deps.storage.write(`${dir}/out.pdf`, Buffer.from('pdf'));
      await t.deps.db.insert(reportRuns).values({
        id,
        templateId: null,
        templateName: 'x',
        templateVersion: 1,
        userId,
        params: {},
        status: 'ok',
        snapshot: true,
        filePath: `${dir}/template.docx`,
        durationMs: 1,
        createdAt: new Date(Date.now() - daysAgo * 86_400_000),
      });
      await t.deps.db
        .insert(reportRunFiles)
        .values({ runId: id, format: 'pdf', filePath: `${dir}/out.pdf` });
      return { id, dir };
    };
    const old = await snapshotRun(45);
    const fresh = await snapshotRun(2);
    expect(await cleanupOldReports(t.deps)).toBe(1);
    expect(await t.deps.storage.exists(old.dir)).toBe(false);
    expect(await t.deps.storage.exists(`${fresh.dir}/out.pdf`)).toBe(true);
    const filesOf = (id: string) =>
      t.deps.db.select().from(reportRunFiles).where(eq(reportRunFiles.runId, id));
    expect(await filesOf(old.id)).toHaveLength(0);
    expect(await filesOf(fresh.id)).toHaveLength(1);
    const [row] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, old.id));
    expect(row!.fileDeleted).toBe(true);
    const cookie = (await loginAs(t, 'admin')).cookie;
    const r = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${old.id}/file?format=docx`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(410);
    expect(r.json().error.message).toBe('файл удалён — сформируйте отчёт заново');
  });
```

`apps/api/test/hardening.int.test.ts` — импорт: `import { reportRunFiles, reportRuns, users } from '../src/db/schema';`. В `describe('удаление пользователя', …)` после первого теста (строка 124):

```ts
  it('удаляет каталоги снимков запусков пользователя', async () => {
    const victim = await loginAs(t, 'user');
    const id = crypto.randomUUID();
    const dir = `reports/${id}`;
    await t.deps.storage.write(`${dir}/data.json`, Buffer.from('{}'));
    await t.deps.storage.write(`${dir}/template.docx`, Buffer.from('tpl'));
    await t.deps.storage.write(`${dir}/out.pdf`, Buffer.from('pdf'));
    await t.deps.db.insert(reportRuns).values({
      id,
      templateId: null,
      templateName: 'x',
      templateVersion: 1,
      userId: victim.user.id,
      params: {},
      status: 'ok',
      snapshot: true,
      filePath: `${dir}/template.docx`,
      durationMs: 1,
    });
    await t.deps.db
      .insert(reportRunFiles)
      .values({ runId: id, format: 'pdf', filePath: `${dir}/out.pdf` });
    const r = await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${victim.user.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(r.statusCode).toBe(204);
    expect(await t.deps.storage.exists(dir)).toBe(false);
    expect(
      await t.deps.db.select().from(reportRunFiles).where(eq(reportRunFiles.runId, id)),
    ).toHaveLength(0);
  });
```

`apps/api/src/modules/carbone/template-cache.test.ts` — в `describe('memoryTemplateCache', …)` после первого теста (строка 17):

```ts
  it('держит не больше limit записей: вытесняется самая давняя (ключи снимков — по запуску)', async () => {
    const cache = memoryTemplateCache(2);
    await cache.set('run:a', { version: 1, carboneId: 'a' });
    await cache.set('run:b', { version: 1, carboneId: 'b' });
    await cache.set('run:a', { version: 1, carboneId: 'a2' }); // повторная запись освежает ключ
    await cache.set('run:c', { version: 1, carboneId: 'c' });
    expect(await cache.get('run:b')).toBeNull();
    expect(await cache.get('run:a')).toEqual({ version: 1, carboneId: 'a2' });
    expect(await cache.get('run:c')).toEqual({ version: 1, carboneId: 'c' });
  });
```

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api exec vitest run src/modules/carbone/template-cache.test.ts && pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/cleanup.int.test.ts test/hardening.int.test.ts
```
Ожидание: FAIL. Кэш не ограничен (`run:b` не вытеснен). Очистка удаляет только `template.docx`: каталог и строка `report_run_files` остаются. При удалении пользователя каталог остаётся.

- [ ] **Step 2: Очистка и удаление пользователя**

`apps/api/src/modules/reports/cleanup.ts`, строки 1–34:

```ts
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { reportRunFiles, reportRuns } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { runStoragePath } from './snapshot';

export async function cleanupOldReports(
  deps: AppDeps,
  now = new Date(),
  log?: { warn(o: unknown, msg?: string): void },
): Promise<number> {
  const threshold = new Date(now.getTime() - deps.config.reportRetentionDays * 86_400_000);
  const rows = await deps.db
    .select({ id: reportRuns.id, filePath: reportRuns.filePath, snapshot: reportRuns.snapshot })
    .from(reportRuns)
    .where(
      and(
        eq(reportRuns.fileDeleted, false),
        isNotNull(reportRuns.filePath),
        lt(reportRuns.createdAt, threshold),
      ),
    );
  let done = 0;
  for (const r of rows) {
    try {
      // Сначала отметка в базе, затем удаление: при сбое удаления остаётся безвредный файл-сирота,
      // а не строка, указывающая на отсутствующий файл. Строки собранных файлов уходят вместе с отметкой;
      // идущая сборка держит строку запуска FOR SHARE, поэтому отметка ждёт её конца.
      await deps.db.transaction(async (tx) => {
        await tx.update(reportRuns).set({ fileDeleted: true }).where(eq(reportRuns.id, r.id));
        await tx.delete(reportRunFiles).where(eq(reportRunFiles.runId, r.id));
      });
      // Снимок — каталог reports/<runId>/ целиком, старый запуск — его единственный файл.
      await deps.storage.remove(runStoragePath(r)!);
      done++;
    } catch (err) {
      log?.warn({ err, runId: r.id }, 'не удалось удалить файл отчёта');
    }
  }
  return done;
}
```
Тест «сбой удаления одного файла…» подменяет `storage.remove` по пути `bad.filePath`. Для старых запусков путь не меняется, поэтому тест остаётся зелёным.

`apps/api/src/modules/users/routes.ts` — импорт: `import { runStoragePath } from '../reports/snapshot';`. Строки 118–137:

```ts
  app.delete('/api/users/:id', { ...pre, schema: { params: IdParams } }, async (req, reply) => {
    if (req.params.id === currentUser(req).id)
      throw badRequest('нельзя удалить собственную учётную запись');
    // Запуски удаляются каскадом, поэтому пути файлов нужно собрать до удаления пользователя.
    const runs = await deps.db
      .select({ id: reportRuns.id, filePath: reportRuns.filePath, snapshot: reportRuns.snapshot })
      .from(reportRuns)
      .where(
        and(
          eq(reportRuns.userId, req.params.id),
          isNotNull(reportRuns.filePath),
          eq(reportRuns.fileDeleted, false),
        ),
      );
    const [row] = await deps.db.delete(users).where(eq(users.id, req.params.id)).returning();
    if (!row) throw notFound('пользователь');
    for (const r of runs) {
      // Снимок — каталог reports/<runId>/ целиком (§24.5), старый запуск — его файл.
      const path = runStoragePath(r)!;
      await deps.storage
        .remove(path)
        .catch((err) => req.log.warn({ err, filePath: path }, 'не удалось удалить файл отчёта'));
    }
    return reply.status(204).send();
  });
```

- [ ] **Step 3: Предел кэша в памяти**

`apps/api/src/modules/carbone/template-cache.ts`, строки 14–27:

```ts
const KEY_PREFIX = 'cr:carbone:tpl:';
const TTL_SECONDS = 7 * 24 * 3600;
/** Снимки кэшируются по запуску (`run:<runId>`), поэтому кэш в памяти ограничен; Redis-ключи живут TTL_SECONDS. */
export const MEMORY_CACHE_LIMIT = 1000;

export function memoryTemplateCache(limit = MEMORY_CACHE_LIMIT): TemplateIdCache {
  // Map хранит порядок вставки: первый ключ — самый давний.
  const ids = new Map<string, TemplateIdEntry>();
  return {
    async get(id) {
      return ids.get(id) ?? null;
    },
    async set(id, v) {
      ids.delete(id);
      ids.set(id, v);
      if (ids.size > limit) ids.delete(ids.keys().next().value!);
    },
  };
}
```

- [ ] **Step 4: smoke**

`scripts/smoke.ts`:

1. В `carboneRestart` перед `const renderOnce` (строка 82) добавить `let lastRunId = '';`. В `renderOnce` (строки 82–96):
   - тело запроса (строка 86): `body: JSON.stringify({ params: {} }),`;
   - после `const { runId } = …` (строка 92): `lastRunId = runId;`.
2. Шаг «Carbone: отчёт до пересоздания контейнера» (строки 112–114):

```ts
  let beforeRunId = '';
  await step('Carbone: отчёт до пересоздания контейнера', async () => {
    await renderOnce();
    beforeRunId = lastRunId;
  });
```

3. Шаг после пересоздания (строки 139–142):

```ts
  await step('Carbone: отчёт после пересоздания — шаблон загружен повторно', async () => {
    const type = await renderWithRetry();
    assert(type === 'application/pdf', `content-type: ${type}`);
    // id копии шаблона запуска закэширован под ключом run:<runId>, а Carbone его уже не знает:
    // API должен загрузить копию снимка повторно.
    const docx = await api(`/api/runs/${beforeRunId}/file?format=docx`);
    assert(docx.status === 200, `DOCX запуска до пересоздания: HTTP ${docx.status}`);
  });
```

4. `renderTo` (строки 274–286):

```ts
  async function renderTo(format: 'pdf' | 'docx'): Promise<Buffer> {
    const { runId } = await json<{ runId: string }>(
      await api(`/api/reports/${templateId}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      }),
      201,
    );
    const r = await api(`/api/runs/${runId}/file?format=${format}`);
    assert(r.status === 200, `скачивание: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
```

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm typecheck:scripts
```
Ожидание: без ошибок. Живой запуск smoke — в Task 4.

- [ ] **Step 5: Запуск — должно пройти; гейты; коммит**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api exec vitest run src/modules/carbone && pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/cleanup.int.test.ts test/hardening.int.test.ts test/redis.int.test.ts
```
Ожидание: все зелёные, включая прежние тесты очистки и удаления пользователя.

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm test:int
git add apps/api/src/modules/reports/cleanup.ts apps/api/test/cleanup.int.test.ts apps/api/src/modules/users/routes.ts apps/api/test/hardening.int.test.ts apps/api/src/modules/carbone/template-cache.ts apps/api/src/modules/carbone/template-cache.test.ts scripts/smoke.ts
git commit -m "feat(api): cleanup and user deletion remove run snapshot dirs; bounded memory Carbone cache; smoke uses ?format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: Веб — «Сохранить как» под просмотром и меню форматов в истории (§24.1, §24.6)

**Files:**
- Modify: `apps/web/src/lib/download.ts` (в конец — `filenameFromDisposition`)
- Create: `apps/web/src/lib/download.test.ts`
- Modify: `apps/web/src/api/client.ts:1` (импорт), после `:78` (`apiFile`)
- Create: `apps/web/src/api/useRunDownload.ts`
- Modify: `apps/web/src/pages/ReportRunPage.tsx` (весь файл)
- Modify: `apps/web/src/pages/ReportRunPage.test.tsx:1-5` (импорты), `:35-69` (два первых теста заменить), новые тесты после `:206`
- Modify: `apps/web/src/pages/HistoryPage.tsx:1-13` (импорты), `:39` (хук), `:93`, `:116-130`, `:172`
- Modify: `apps/web/src/pages/HistoryPage.test.tsx:1-22`, новый тест после `:52`
- Modify: `apps/web/src/app/global.css:84` (после `.cr-pdf`)

**Interfaces:**
- Consumes:
  - `runFileUrl(runId, { format?, inline? })` (Task 1);
  - `RunDto.formats`, `RunDto.readyFormats`, `RunDto.outputFormat: OutputFormat | null` (Task 1);
  - `TemplateDetails.outputFormats`, `TemplateDetails.defaultOutput` — `outputFormatsFor(fileExt)` и формат по умолчанию из настроек;
  - `triggerDownload(url, filename?)` (`lib/download.ts`);
  - `send` в `api/client.ts` (ошибка API → `ApiRequestError` с `message` сервера);
  - Gravity UI `Button` (`view="action"` — основная, `view="outlined"` — второстепенная, `loading` → класс `g-button_loading` и `disabled`), `DropdownMenu` (`items[].action`, `renderSwitcher`).
- Produces:
  - `filenameFromDisposition(header: string | null): string | undefined`;
  - `apiFile(path): Promise<{ blob: Blob; filename?: string }>`;
  - `useRunDownload(): { save({ runId, format }), pending?: { runId, format }, error, reset }`;
  - разметка: `iframe[title="Предпросмотр отчёта"]` с `src=/api/runs/<id>/file?format=pdf&inline=1`; `role="group"` с `aria-label="Сохранить как"`, в нём кнопки с текстом формата в верхнем регистре; в истории у запуска со снимком — кнопка «Скачать» (`aria-label`), открывающая меню `menuitem` с форматами. Эту разметку использует E2E в Task 4.

- [ ] **Step 1: Падающие тесты**

`apps/web/src/lib/download.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { filenameFromDisposition } from './download';

describe('filenameFromDisposition', () => {
  it('имя в UTF-8 из filename* (как отдаёт API)', () => {
    expect(
      filenameFromDisposition(
        `attachment; filename="____ 2026-01-10.docx"; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82%202026-01-10.docx`,
      ),
    ).toBe('Счёт 2026-01-10.docx');
  });
  it('без filename* — filename', () => {
    expect(filenameFromDisposition('inline; filename="a.pdf"')).toBe('a.pdf');
  });
  it('нет заголовка или битая кодировка без запасного имени — undefined', () => {
    expect(filenameFromDisposition(null)).toBeUndefined();
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A`)).toBeUndefined();
  });
});
```

`apps/web/src/pages/ReportRunPage.test.tsx` — импорты (строки 1–5):

```ts
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as download from '../lib/download';
import { mockApi, renderRoute, userMe } from '../test/utils';
```

После `const template = {…}` (строка 33):

```ts
const DISPOSITION = `attachment; filename="____ 2026-01-10.docx"; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82%202026-01-10.docx`;
const COMMUNITY =
  'в шаблоне используется aggSum — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»';

/** Задерживает ответы на запросы, чей URL содержит `part`, до release(). */
function holdRequests(part: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fetchMock = vi.mocked(globalThis.fetch);
  const impl = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).includes(part)) await gate;
    return impl(input, init);
  });
  return release;
}

async function formAndRender(): Promise<HTMLElement> {
  await userEvent.type(await screen.findByRole('textbox', { name: 'Компания *' }), 'ООО Ромашка');
  await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
  return screen.findByRole('group', { name: 'Сохранить как' });
}
```

Первые два теста (строки 36–69) заменить:

```ts
  it('Word-шаблон: PDF-просмотр, «Сохранить как» PDF/DOCX/ODT, основная — по defaultOutput; тело без format', async () => {
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
    ]);
    renderRoute('/reports/t1');
    expect(await screen.findByRole('button', { name: 'Сформировать' })).toBeInTheDocument();
    // Выбора формата на форме нет.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText('Формат')).not.toBeInTheDocument();

    const group = await formAndRender();
    expect(screen.getByTitle('Предпросмотр отчёта')).toHaveAttribute(
      'src',
      '/api/runs/r1/file?format=pdf&inline=1',
    );
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'PDF',
      'DOCX',
      'ODT',
    ]);
    expect(within(group).getByRole('button', { name: 'PDF' })).toHaveClass('g-button_view_action');
    expect(within(group).getByRole('button', { name: 'DOCX' })).toHaveClass(
      'g-button_view_outlined',
    );
    expect(within(group).getByRole('button', { name: 'ODT' })).toHaveClass(
      'g-button_view_outlined',
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      params: { company: 'ООО Ромашка', limit: 5 },
    });
  });

  it('Excel-шаблон: PDF, XLSX, ODS; основная — XLSX (defaultOutput); просмотр всё равно PDF', async () => {
    mockApi([
      userMe,
      {
        path: '/api/templates/t1',
        body: { ...template, fileExt: 'xlsx', defaultOutput: 'xlsx', outputFormats: ['pdf', 'xlsx', 'ods'] },
      },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
    ]);
    renderRoute('/reports/t1');
    const group = await formAndRender();
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'PDF',
      'XLSX',
      'ODS',
    ]);
    expect(within(group).getByRole('button', { name: 'XLSX' })).toHaveClass(
      'g-button_view_action',
    );
    expect(within(group).getByRole('button', { name: 'PDF' })).toHaveClass(
      'g-button_view_outlined',
    );
    expect(screen.getByTitle('Предпросмотр отчёта')).toHaveAttribute(
      'src',
      '/api/runs/r1/file?format=pdf&inline=1',
    );
  });
```

После теста «после неудачной генерации прежний предпросмотр убирается» (заканчивается на строке 206):

```ts
  it('«Сохранить как DOCX»: спиннер на нажатой кнопке до готовности файла, затем triggerDownload', async () => {
    const spy = vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:run');
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
      { path: '/api/runs/r1/file', raw: 'DOCX', headers: { 'content-disposition': DISPOSITION } },
    ]);
    const release = holdRequests('/file?format=docx');
    renderRoute('/reports/t1');
    const group = await formAndRender();
    const docx = within(group).getByRole('button', { name: 'DOCX' });
    await userEvent.click(docx);
    await waitFor(() => expect(docx).toHaveClass('g-button_loading'));
    expect(docx).toBeDisabled();
    // Пока идёт сборка, остальные кнопки недоступны.
    expect(within(group).getByRole('button', { name: 'PDF' })).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(spy).toHaveBeenCalledWith('blob:run', 'Счёт 2026-01-10.docx'));
    await waitFor(() => expect(docx).not.toHaveClass('g-button_loading'));
    expect(within(group).getByRole('button', { name: 'PDF' })).toBeEnabled();
    expect(calls.some((c) => c.path === '/api/runs/r1/file?format=docx')).toBe(true);
  });

  it('ошибка сборки показывается под кнопками; просмотр остаётся', async () => {
    const spy = vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
      {
        path: '/api/runs/r1/file',
        status: 400,
        body: { error: { code: 'CARBONE_COMMUNITY', message: COMMUNITY } },
      },
    ]);
    renderRoute('/reports/t1');
    const group = await formAndRender();
    await userEvent.click(within(group).getByRole('button', { name: 'DOCX' }));
    expect(await screen.findByText(COMMUNITY)).toBeInTheDocument();
    expect(screen.getByText('Не удалось сохранить файл')).toBeInTheDocument();
    expect(screen.getByTitle('Предпросмотр отчёта')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'DOCX' })).toBeEnabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('повторное «Сформировать» — новый запуск и новый просмотр; прежняя ошибка сохранения убрана', async () => {
    let n = 0;
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      {
        method: 'POST',
        path: '/api/reports/t1/render',
        handler: () => ({ status: 201, body: { runId: `r${++n}` } }),
      },
      {
        path: '/api/runs/r1/file',
        status: 410,
        body: { error: { code: 'GONE', message: 'файл удалён — сформируйте отчёт заново' } },
      },
    ]);
    renderRoute('/reports/t1');
    const group = await formAndRender();
    expect(screen.getByTitle('Предпросмотр отчёта')).toHaveAttribute(
      'src',
      '/api/runs/r1/file?format=pdf&inline=1',
    );
    await userEvent.click(within(group).getByRole('button', { name: 'ODT' }));
    expect(await screen.findByText('файл удалён — сформируйте отчёт заново')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
    await waitFor(() =>
      expect(screen.getByTitle('Предпросмотр отчёта')).toHaveAttribute(
        'src',
        '/api/runs/r2/file?format=pdf&inline=1',
      ),
    );
    expect(screen.queryByText('файл удалён — сформируйте отчёт заново')).not.toBeInTheDocument();
  });
```

`apps/web/src/pages/HistoryPage.test.tsx`:
- импорты (строки 1–5):

```ts
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as download from '../lib/download';
import { adminMe, mockApi, renderRoute, userMe } from '../test/utils';
import { formatRunParams } from './HistoryPage';
```

- в фикстуре `run` (строки 7–22) после `fileAvailable: true,` добавить:

```ts
  formats: ['pdf'],
  readyFormats: ['pdf'],
```
(фикстура по умолчанию — старый PDF-запуск: одна ссылка «Скачать», как в существующем тесте);

- после первого теста (строка 52):

```ts
  it('запуск со снимком: меню «Скачать» со всеми форматами; выбранный формат скачивается', async () => {
    const spy = vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:run');
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates', body: [] },
      {
        path: '/api/runs',
        body: page([
          run({ outputFormat: null, formats: ['pdf', 'docx', 'odt'], readyFormats: ['pdf', 'docx'] }),
        ]),
      },
      {
        path: '/api/runs/r1/file',
        raw: 'DOCX',
        headers: {
          'content-disposition': `attachment; filename="x.docx"; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82%202026-01-31.docx`,
        },
      },
    ]);
    renderRoute('/history');
    // Колонка «Формат» — уже собранные форматы.
    expect(await screen.findByText('PDF, DOCX')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Скачать' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Скачать' }));
    for (const f of ['PDF', 'DOCX', 'ODT']) {
      expect(await screen.findByRole('menuitem', { name: f })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('menuitem', { name: 'DOCX' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('blob:run', 'Счёт 2026-01-31.docx'));
    expect(calls.some((c) => c.path === '/api/runs/r1/file?format=docx')).toBe(true);
  });
```

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/web exec vitest run src/lib/download.test.ts src/pages/ReportRunPage.test.tsx src/pages/HistoryPage.test.tsx
```
Ожидание: FAIL. Нет `filenameFromDisposition`, на форме есть переключатель формата, нет группы «Сохранить как», в истории нет меню.

- [ ] **Step 2: `filenameFromDisposition`, `apiFile`, `useRunDownload`**

`apps/web/src/lib/download.ts`, в конец:

```ts

/** Имя файла из Content-Disposition: сначала `filename*=UTF-8''…` (кириллица), потом `filename="…"`. */
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // битая кодировка — пробуем обычное имя
    }
  }
  return /filename="([^"]*)"/i.exec(header)?.[1] || undefined;
}
```

`apps/web/src/api/client.ts` — в начало: `import { filenameFromDisposition } from '../lib/download';`. После `apiBlob` (строка 78):

```ts

/** Файл и его имя из Content-Disposition; ошибка API — ApiRequestError с сообщением сервера. */
export async function apiFile(
  path: string,
  opts?: RequestOptions,
): Promise<{ blob: Blob; filename?: string }> {
  const res = await send(path, opts);
  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get('content-disposition')),
  };
}
```

`apps/web/src/api/useRunDownload.ts`:

```ts
import type { OutputFormat } from '@carbone-reports/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { triggerDownload } from '../lib/download';
import { apiFile } from './client';
import { runFileUrl } from './endpoints';

export interface RunFileRequest {
  runId: string;
  format: OutputFormat;
}

/**
 * Скачивание файла запуска с ожиданием сборки (§24.6): пока сервер собирает формат из снимка, виден
 * `pending`; ошибка — в `error`. Готовый файл сохраняется тем же triggerDownload через blob-ссылку.
 */
export function useRunDownload() {
  const queryClient = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ runId, format }: RunFileRequest) => {
      const { blob, filename } = await apiFile(runFileUrl(runId, { format }));
      const url = URL.createObjectURL(blob);
      triggerDownload(url, filename);
      // Ссылка нужна браузеру, пока он забирает файл; потом память освобождается.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    // Новый собранный формат появится в readyFormats истории.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['runs'] }),
  });
  return {
    save: m.mutate,
    pending: m.isPending ? m.variables : undefined,
    error: m.error,
    reset: m.reset,
  };
}
```

- [ ] **Step 3: `ReportRunPage`**

`apps/web/src/pages/ReportRunPage.tsx` целиком:

```tsx
import type { ParamsInput } from '@carbone-reports/shared';
import { Alert, Button, Loader, Text } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, runFileUrl } from '../api/endpoints';
import { ApiRequestError } from '../api/client';
import { fieldErrors } from '../api/errors';
import { useRunDownload } from '../api/useRunDownload';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageHeader';
import { ParamForm } from '../components/ParamForm';
import { initialValues, pickParams } from '../lib/params';

export function ReportRunRoute() {
  const { id = '' } = useParams();
  return <ReportRunPage key={id} />;
}

export function ReportRunPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const template = useQuery({ queryKey: ['template', id], queryFn: () => api.templates.get(id) });
  const t = template.data;

  const [values, setValues] = useState<ParamsInput>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const download = useRunDownload();
  const resetDownload = download.reset;

  // Форма строится заново, если шаблон сменился или админ изменил его описание.
  const version = t ? `${t.id}:${t.updatedAt}` : '';
  useEffect(() => {
    if (!t) return;
    setValues(initialValues(t.params));
    setRunId(null);
    resetDownload();
  }, [version]);

  // Формата при формировании нет (§24.1): сервер сохраняет снимок и собирает PDF для просмотра.
  const render = useMutation({
    mutationFn: () => api.reports.render(id, { params: pickParams(t!.params, values) }),
    onSuccess: ({ runId }) => setRunId(runId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['runs'] }),
    onError: (e) => {
      if (e instanceof ApiRequestError && e.code === 'VALIDATION') void template.refetch();
    },
  });

  if (template.isPending) return <Loader />;
  if (!t) return <ErrorAlert error={template.error} title="Не удалось открыть отчёт" />;

  const errors = fieldErrors(render.error);
  const declared = new Set(t.params.map((p) => p.name));
  const unmatched = Object.entries(errors).filter(([k]) => !declared.has(k));
  const paramLike = unmatched.some(([k]) => k !== '_');
  const generalError = render.error && Object.keys(errors).length === 0 ? render.error : null;

  return (
    <>
      <PageHeader
        title={t.name}
        actions={
          <Button view="flat" onClick={() => navigate('/reports')}>
            К списку
          </Button>
        }
      />
      {t.description && (
        <Text color="secondary" as="p">
          {t.description}
        </Text>
      )}
      <div className="cr-run">
        <form
          className="cr-form"
          onSubmit={(e) => {
            e.preventDefault();
            setRunId(null);
            download.reset();
            render.mutate();
          }}
        >
          {t.params.length === 0 && <Text color="secondary">У отчёта нет параметров.</Text>}
          <ParamForm
            templateId={t.id}
            params={t.params}
            values={values}
            onChange={setValues}
            errors={errors}
            disabled={render.isPending}
            onOptionsLoadingChange={setOptionsLoading}
          />
          <ErrorAlert error={generalError} />
          {unmatched.length > 0 && (
            <Alert
              theme="danger"
              title={paramLike ? 'Параметры отчёта изменились — форма обновлена' : undefined}
              message={unmatched.map(([k, m]) => (k === '_' ? m : `${k}: ${m}`)).join('; ')}
            />
          )}
          <div className="cr-run-actions">
            <Button
              view="action"
              size="l"
              type="submit"
              loading={render.isPending}
              disabled={optionsLoading}
            >
              Сформировать
            </Button>
            {optionsLoading && <Text color="secondary">Загружаются варианты параметров…</Text>}
          </div>
        </form>
        <div>
          {runId && (
            <>
              <div className="cr-page-header">
                <Text variant="subheader-2">Отчёт готов</Text>
              </div>
              {/* Просмотр всегда в PDF, для Excel тоже (§24.1). */}
              <iframe
                title="Предпросмотр отчёта"
                src={runFileUrl(runId, { format: 'pdf', inline: true })}
                className="cr-pdf cr-pdf_run"
              />
              <div className="cr-save" role="group" aria-label="Сохранить как">
                <Text variant="subheader-1">Сохранить как</Text>
                {t.outputFormats.map((f) => {
                  const busy = download.pending?.runId === runId && download.pending.format === f;
                  return (
                    <Button
                      key={f}
                      view={f === t.defaultOutput ? 'action' : 'outlined'}
                      size="l"
                      loading={busy}
                      disabled={!!download.pending && !busy}
                      onClick={() => download.save({ runId, format: f })}
                    >
                      {f.toUpperCase()}
                    </Button>
                  );
                })}
              </div>
              <ErrorAlert error={download.error} title="Не удалось сохранить файл" />
            </>
          )}
        </div>
      </div>
    </>
  );
}
```

`apps/web/src/app/global.css`, после блока `.cr-pdf` (строка 84):

```css

/* Под просмотром — ряд «Сохранить как», поэтому просмотр чуть ниже, чем во вкладке «Предпросмотр». */
.cr-pdf_run {
  height: calc(100vh - 300px);
}

.cr-save {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
```

- [ ] **Step 4: `HistoryPage`**

`apps/web/src/pages/HistoryPage.tsx`:
- импорты (строки 1–13):

```tsx
import type { ParamsInput, RunDto } from '@carbone-reports/shared';
import { RUNS_PAGE_SIZE } from '@carbone-reports/shared';
import { ArrowDownToLine } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import {
  Button,
  DropdownMenu,
  Icon,
  Label,
  Loader,
  Pagination,
  Select,
  Table,
  Text,
} from '@gravity-ui/uikit';
import { useEffect } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api, runFileUrl } from '../api/endpoints';
import { useMe } from '../api/session';
import { useRunDownload } from '../api/useRunDownload';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageHeader';
import { formatDateTime, formatDuration } from '../lib/format';
```

- перед `const runs = useQuery(` (строка 39): `const download = useRunDownload();`
- колонка «Формат» (строка 93):

```tsx
    {
      id: 'format',
      name: 'Формат',
      // Старый запуск — его формат; запуск со снимком — уже собранные форматы.
      template: (r) =>
        (r.outputFormat ? [r.outputFormat] : r.readyFormats)
          .map((f) => f.toUpperCase())
          .join(', ') || '—',
      width: 110,
    },
```

- колонка файла (строки 116–130):

```tsx
    {
      id: 'file',
      name: '',
      width: 60,
      template: (r) => {
        if (!r.fileAvailable) {
          return r.status === 'ok' ? (
            <Text variant="caption-2" color="secondary">
              файл удалён
            </Text>
          ) : null;
        }
        // Старый запуск — одна ссылка, как раньше.
        if (r.outputFormat) {
          return (
            <Button
              view="flat"
              size="s"
              href={runFileUrl(r.id)}
              aria-label="Скачать"
              title="Скачать"
            >
              <Icon data={ArrowDownToLine} />
            </Button>
          );
        }
        // Запуск со снимком — меню со всеми форматами (§24.6).
        return (
          <DropdownMenu
            items={r.formats.map((f) => ({
              text: f.toUpperCase(),
              action: () => download.save({ runId: r.id, format: f }),
            }))}
            renderSwitcher={({ onClick, onKeyDown }) => (
              <Button
                view="flat"
                size="s"
                aria-label="Скачать"
                title="Скачать"
                loading={download.pending?.runId === r.id}
                onClick={onClick}
                extraProps={{ onKeyDown }}
              >
                <Icon data={ArrowDownToLine} />
              </Button>
            )}
          />
        );
      },
    },
```

- после `<ErrorAlert error={runs.error} />` (строка 172):

```tsx
      <ErrorAlert error={download.error} title="Не удалось скачать файл" />
```

- [ ] **Step 5: Запуск — должно пройти; гейты; коммит**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/web exec vitest run src/lib/download.test.ts src/pages/ReportRunPage.test.tsx src/pages/HistoryPage.test.tsx src/pages/admin/template-editor/PreviewTab.test.tsx
```
Ожидание: все зелёные. Прежние тесты страницы запуска (ошибки параметров, Community, перезапрос шаблона, неактивная «Сформировать») и `PreviewTab` не тронуты.

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/web/src/lib/download.ts apps/web/src/lib/download.test.ts apps/web/src/api/client.ts apps/web/src/api/useRunDownload.ts apps/web/src/pages/ReportRunPage.tsx apps/web/src/pages/ReportRunPage.test.tsx apps/web/src/pages/HistoryPage.tsx apps/web/src/pages/HistoryPage.test.tsx apps/web/src/app/global.css
git commit -m "feat(web): PDF preview with «Сохранить как» buttons; format menu in history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: E2E, README, заметки и живой прогон (§24.7)

**Files:**
- Modify: `e2e/tests/user.spec.ts:47-66`
- Modify: `e2e/tests/sql-params.spec.ts:31-34`
- Modify: `e2e/tests/onlyoffice.spec.ts:51-55`
- Modify: `README.md:233` (новый раздел «Просмотр перед сохранением» перед «Доступ к отчётам»), после `:283` (срок сборки в «Конфигурации»)
- Modify: `docs/superpowers/notes/2026-10-02-backend-follow-ups.md` (раздел «Итоги Плана 13» в конце файла)

**Interfaces:**
- Consumes:
  - разметка Task 3: `iframe[title="Предпросмотр отчёта"]`, группа «Сохранить как», кнопка «Скачать» и `menuitem` в истории;
  - API Task 1: `?format=`;
  - фикстуры E2E `docxText`, `loginUi`, `loginAdminUi`, `adminApi`, `waitForStack` (`e2e/fixtures.ts`);
  - демо-шаблон «Счёт (демо)»: `.docx`, `defaultOutput: 'pdf'` (`scripts/demo-seed.ts:114`).
- Produces: E2E по §24.7 («Сформировать» → виден PDF → «Сохранить как DOCX» скачивает файл); проверка миграции `0006` на существующей демо-БД; итоги в заметках.

`grep -n "radio\|format" e2e/tests/*.ts` находит прежний переключатель формата только в `user.spec.ts:55` и `sql-params.spec.ts:31`, а `format: 'docx'` в теле рендера — в `onlyoffice.spec.ts:53`. `access.spec.ts` берёт PDF из `src` iframe и не меняется.

- [ ] **Step 1: E2E**

`e2e/tests/user.spec.ts`, строки 47–66 (от первого клика «Сформировать» до конца теста):

```ts
  await page.getByRole('button', { name: 'Сформировать' }).click();
  const frame = page.getByTitle('Предпросмотр отчёта');
  await expect(frame).toBeVisible();
  const pdfUrl = await frame.getAttribute('src');
  expect(pdfUrl).toMatch(/^\/api\/runs\/[0-9a-f-]{36}\/file\?format=pdf&inline=1$/);
  const pdf = await page.request.get(pdfUrl!);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  // Выбора формата на форме нет; под просмотром — «Сохранить как» с форматами Word-шаблона.
  await expect(page.getByRole('radio')).toHaveCount(0);
  const saveAs = page.getByRole('group', { name: 'Сохранить как' });
  await expect(saveAs.getByRole('button')).toHaveText(['PDF', 'DOCX', 'ODT']);
  const downloadPromise = page.waitForEvent('download');
  await saveAs.getByRole('button', { name: 'DOCX' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^Счёт \(демо\) \d{4}-\d{2}-\d{2}\.docx$/);
  const text = await docxText(await readFile((await download.path())!));
  for (const s of ['СЧ-001', 'ООО «Ромашка»', 'Бумага А4', 'Картридж', 'Ручки шариковые'])
    expect(text).toContain(s);
  expect(text).not.toContain('{d.');

  // История: запуск со снимком — собраны PDF и DOCX, меню «Скачать» со всеми форматами.
  await page.goto('/history');
  await expect(page.getByText('Счёт (демо)').first()).toBeVisible();
  await expect(page.getByText('PDF, DOCX').first()).toBeVisible();
  await page.getByRole('button', { name: 'Скачать' }).first().click();
  await expect(page.getByRole('menuitem')).toHaveText(['PDF', 'DOCX', 'ODT']);
});
```
Название теста (строка 25) — `'пользователь: создание админом, просмотр PDF, «Сохранить как» DOCX, история'`.

`e2e/tests/sql-params.spec.ts`, строки 31–34:

```ts
  await page.getByRole('button', { name: 'Сформировать' }).click();
  await expect(page.getByTitle('Предпросмотр отчёта')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('group', { name: 'Сохранить как' })
    .getByRole('button', { name: 'DOCX' })
    .click();
  const download = await downloadPromise;
```

`e2e/tests/onlyoffice.spec.ts`, строки 51–55:

```ts
  const { runId } = await api.post<{ runId: string }>(`/api/reports/${templateId}/render`, {
    params: { invoiceId: 1 },
  });
  const file = await api.ctx.get(`/api/runs/${runId}/file?format=docx`);
```

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/e2e typecheck && grep -n "radio" e2e/tests/*.ts
```
Ожидание: типы без ошибок. `grep` находит только `toHaveCount(0)` в `user.spec.ts`. Запуск E2E — в Step 2 на пересобранном стеке.

- [ ] **Step 2: Живой прогон на пересобранном стеке**

Нужны новые образы `api` (миграция `0006`, снимок, `?format=`) и `web` («Сохранить как», меню истории). Миграция `0006` проверяется на существующей демо-БД: до пересборки в ней уже есть запуски прежнего вида.

```bash
cd /Users/sam/carbone-reports
# Место: в прошлом прогоне оставалось 1,6 GiB. Сначала висячие образы проекта, затем проверка.
docker image ls --filter dangling=true --filter label=com.docker.compose.project=carbone-reports -q | xargs -r docker image rm
df -h /System/Volumes/Data | tail -1        # меньше 2 GiB свободно → BLOCKED, не собирать

# До пересборки: состояние истории в демо-БД (без секретов: psql внутри контейнера, локальный сокет).
docker compose exec -T postgres psql -U app -d app -Atc "select status, count(*) from report_runs group by 1 order by 1"
docker compose exec -T postgres psql -U app -d app -Atc "select id, output_format from report_runs where status = 'ok' and not file_deleted and file_path is not null order by created_at desc limit 1"
# Записать id и формат этого запуска (OLD_RUN, OLD_FMT); если строк нет — проверку старого запуска пропустить и указать это в итогах.

source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm stack:demo   # --build --wait + demo:seed
docker compose ps api web                   # api healthy, web running

# Миграция 0006 применена, старые строки целы.
docker compose exec -T postgres psql -U app -d app -Atc "select count(*) from drizzle.__drizzle_migrations"   # 7
docker compose exec -T postgres psql -U app -d app -Atc "select is_nullable from information_schema.columns where table_name = 'report_runs' and column_name = 'output_format'"   # YES
docker compose exec -T postgres psql -U app -d app -Atc "select to_regclass('public.report_run_files')"     # report_run_files
docker compose exec -T postgres psql -U app -d app -Atc "select snapshot, count(*) from report_runs group by 1 order by 1"   # false — столько же, сколько строк было до пересборки
```

Старый запуск после миграции: файл в своём формате скачивается, другой формат — 400. Пароль берётся из `.env` внутри процесса и не печатается:

```bash
cd /Users/sam/carbone-reports
OLD_RUN=<id> OLD_FMT=<формат> NODE_TLS_REJECT_UNAUTHORIZED=0 node --input-type=module - <<'EOF'
process.loadEnvFile('.env');
const base = `https://localhost:${process.env.WEB_HTTPS_PORT ?? 443}`;
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: process.env.ADMIN_LOGIN, password: process.env.ADMIN_PASSWORD }),
});
if (login.status !== 200) throw new Error(`вход: HTTP ${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
const get = (q) => fetch(`${base}/api/runs/${process.env.OLD_RUN}/file${q}`, { headers: { cookie } });
const def = await get('');
const other = await get(process.env.OLD_FMT === 'pdf' ? '?format=docx' : '?format=pdf');
console.log(`старый запуск: без format — ${def.status} ${def.headers.get('content-type')}; другой формат — ${other.status}`);
EOF
```
Ожидание: `200` с MIME формата `OLD_FMT`, другой формат — `400`.

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && BASE_URL=https://localhost:${WEB_HTTPS_PORT:-443} pnpm stack:smoke -- --insecure
pnpm e2e && pnpm e2e                         # дважды подряд, все зелёные
docker compose exec -T postgres psql -U app -d app -Atc "select r.snapshot, f.format, count(*) from report_run_files f join report_runs r on r.id = f.run_id group by 1, 2 order by 2"   # снимковые запуски E2E: pdf и docx
docker image ls --filter dangling=true --filter label=com.docker.compose.project=carbone-reports -q | xargs -r docker image rm
df -h /System/Volumes/Data | tail -1
```
Стек оставить запущенным, `down` не делать. Чужие висячие образы и кэш сборки не трогать. `--carbone-restart` не запускать: он пересоздаёт контейнер и удаляет том. Если `api` не стал healthy, смотреть `docker compose logs api` (без вывода `.env`). Падения E2E разбирать по `e2e/report`; таймауты не поднимать.

- [ ] **Step 3: README и заметки**

`README.md` — перед строкой 233 (`## Доступ к отчётам`):

```markdown
## Просмотр перед сохранением

На странице отчёта нет выбора формата. «Сформировать» собирает данные один раз и показывает отчёт в PDF; для Excel-шаблона это печатный вид по настройкам печати шаблона. Под просмотром — «Сохранить как» с кнопкой для каждого формата шаблона: Word — PDF, DOCX, ODT; Excel — PDF, XLSX, ODS; PowerPoint — PDF, PPTX. Основная кнопка — формат по умолчанию из настроек шаблона. Повторное «Сформировать» создаёт новый запуск.

- **Снимок запуска.** При формировании API сохраняет данные (`reports/<runId>/data.json`) и копию файла шаблона (`reports/<runId>/template.<ext>`) и собирает из них PDF (`out.pdf`). Другой формат собирается из того же снимка при первом запросе (`out.<формат>`), дальше отдаётся готовым. Поэтому файл совпадает с просмотром, даже если данные в источнике или шаблон уже изменились.
- **API.**
  - `POST /api/reports/:id/render` принимает `{ params }`; поле `format` игнорируется.
  - `GET /api/runs/:id/file?format=<формат>&inline=0|1` отдаёт файл нужного формата, без `format` — PDF. Формат, недоступный для шаблона, — `400 VALIDATION` «формат недоступен для этого отчёта». Удалённый снимок — `410` «файл удалён — сформируйте отчёт заново».
  - Одновременные запросы одного формата собирают файл один раз: advisory-блокировка Postgres, работает и с несколькими экземплярами API.
  - В `GET /api/runs` у запуска есть `formats` (можно скачать) и `readyFormats` (уже собраны).
- **История.** У запуска со снимком кнопка «Скачать» открывает меню со всеми форматами. Запуски, сделанные до обновления, скачиваются только в своём формате, как раньше.
- **Хранение.** Очистка по `REPORT_RETENTION_DAYS` и удаление пользователя удаляют каталог `reports/<runId>/` целиком.

```

`README.md`, «Конфигурация» — после строки 283 (`чем через \`QUERY_TIMEOUT_MS\` после срока.`):

```markdown
Тот же срок ограничивает сборку файла другого формата из снимка (`GET /api/runs/:id/file?format=…`).
Отсчёт идёт от начала запроса на скачивание; ожидание, пока тот же файл собирает другой запрос,
входит в срок.
```

`docs/superpowers/notes/2026-10-02-backend-follow-ups.md` — в конец файла. В угловых скобках — числа из Step 2:

```markdown

## Итоги Плана 13 (просмотр перед сохранением)

- **Процесс:**
  - на странице отчёта нет выбора формата: «Сформировать» → PDF-просмотр → «Сохранить как» (форматы из `outputFormatsFor(ext)`, основная кнопка — `defaultOutput`, спиннер у нажатой кнопки, ошибка сборки под кнопками);
  - в истории у новых запусков — меню «Скачать» со всеми форматами, у старых — прежняя ссылка;
  - в колонке «Формат» — собранные форматы.
- **Снимок:**
  - `reports/<runId>/{data.json, template.<ext>, out.<формат>}`;
  - `report_runs.file_path` нового запуска указывает на копию шаблона: из неё берётся расширение, и запуск скачивается даже после удаления шаблона;
  - все форматы, включая PDF при формировании, собираются одной функцией `renderFromSnapshot`;
  - кэш id шаблона Carbone ключуется `run:<runId>`; кэш в памяти ограничен 1000 записями.
- **Одна сборка:**
  - `pg_advisory_xact_lock(726100002, hashtext('<runId>:<формат>'))` в транзакции сборки, `lock_timeout` = остаток `REPORT_TIMEOUT_MS`;
  - строка запуска `FOR SHARE` упорядочивает сборку с очисткой и удалением пользователя;
  - выбрано вместо состояния «собирается» в таблице: блокировка снимается сама при сбое и работает для нескольких экземпляров API.
- **Модель:**
  - миграция `0006_run_files`: `output_format` nullable, `snapshot boolean default false`, таблица `report_run_files`;
  - заполнять ничего не понадобилось: старые строки — `snapshot = false` со своим форматом;
  - новые запуски с ошибкой — без формата и без снимка.
- **Живой прогон:**
  - висячие образы проекта удалены, свободно на диске <X> GiB до сборки и <Y> GiB после;
  - стек пересобран (`pnpm stack:demo`), миграция `0006` применена к демо-БД с <N> прежними запусками (все `snapshot = false`);
  - старый запуск <id/формат или «старых запусков не было»> скачивается в своём формате, другой формат — 400;
  - `stack:smoke --insecure` пройден;
  - E2E <M>/<M> дважды подряд, нарушений CSP 0;
  - стек оставлен запущенным.
```

- [ ] **Step 4: Гейты и коммит**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add e2e/tests/user.spec.ts e2e/tests/sql-params.spec.ts e2e/tests/onlyoffice.spec.ts README.md docs/superpowers/notes/2026-10-02-backend-follow-ups.md
git commit -m "test(e2e): preview then «Сохранить как» DOCX; README and Plan 13 notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Если живой прогон выявил ошибку в коде Task 1–3: исправить её отдельным коммитом с тестом, который её ловит, повторить гейты (с `pnpm test:int`, если менялся `apps/api`) и Step 2 и указать это в итогах.
