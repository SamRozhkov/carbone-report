# Справка по синтаксису шаблонов (План 12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать администратору справку по тегам Carbone, которые действительно работают в нашей бесплатной версии:
- страница «Справка по шаблонам» (`/admin/help`) с шестью разделами и примерами-карточками;
- ссылка на неё из редактора шаблона;
- правки API: `lang: 'ru'` для Carbone и понятная ошибка `CARBONE_COMMUNITY` вместо `502`;
- скрипт `pnpm help:check`, который сверяет каждый пример справки с живым Carbone.

**Architecture:**
- Факты для справки берутся только из матрицы `docs/superpowers/notes/2026-10-13-carbone-community-matrix.md` (✅-строки и точные выводы).
- **Содержание** живёт в типизированном модуле веба `apps/web/src/pages/admin/help/content.ts` (§23.3). Модуль без React и без браузерных API: только данные и типы (единственный импорт — `import type { QueryMode }` из `@carbone-reports/shared`). Поэтому `scripts/help-check.ts` импортирует его относительным путём `../apps/web/src/pages/admin/help/content` (tsx это умеет, `tsc -p scripts/tsconfig.json` проверяет импортированные файлы сам), и переносить содержание в `packages/shared` или JSON не нужно.
- **Нотация шаблона в примере.** `template` — многострочный текст: строка, начинающаяся с `|`, — строка таблицы Word (`| ячейка | ячейка |`, пустая ячейка — `| |`), любая другая — абзац. `result` записан в той же нотации: абзацы — строками (пустые абзацы не выводятся), строка таблицы — `| … |`, `<w:br/>` — перевод строки. Эту нотацию понимают и страница (показывает как есть), и скрипт (строит из неё DOCX, извлекает в неё текст результата).
- **Тип примера** — `{ id, title, template, data, result, note? }` из §23.3 плюс два необязательных поля: `sql?` (запрос, который даёт такие данные, — для раздела 5) и `unavailable?: true` (раздел 6: Carbone отвечает ошибкой, а `result` — сообщение API). Пункты раздела 6 без проверяемого тега (изображения, `autoOrient`, сортировка по убыванию, TXT) — отдельный список `limits: { id, title, instead }[]`.
- **API.** Сопоставление ошибки — чистая функция `communityErrorMessage()` в `apps/api/src/modules/carbone/community.ts`; её вызывает `CarboneClient.renderWith` до проверки «Template not found». `lang` для Carbone — константа `CARBONE_LANG = 'ru'` в `packages/shared`; её используют и `renderReport`, и `help-check`, поэтому скрипт рендерит с тем же языком, что API.
- **Как `help-check` достаёт Carbone.** Порт Carbone наружу не открыт, поэтому скрипт, как и пробы матрицы, запускает небольшой раннер внутри контейнера `api`: `docker compose exec -T api node -e <RUNNER>`, JSON с примерами — в stdin, JSON с результатами — из stdout. Раннер повторяет `CarboneClient`: `POST /template` и `POST /render/{id}?download=true` с `carbone-version: 5`, тело `{ data, convertTo: 'docx', lang, timezone }`. `lang` приходит из `CARBONE_LANG`, `timezone` — `process.env.TZ` контейнера `api` (тот же источник, что `config.tz`, с тем же умолчанием `Europe/Moscow`), адрес — `process.env.CARBONE_URL`. Сравнение: для обычного примера — текст `word/document.xml` в нотации выше; для `unavailable` — `communityErrorMessage(ошибка Carbone)` (тот же модуль API), то есть проверяется и ошибка Carbone, и текст, который увидит пользователь. Режим `--self-test` работает без Docker: собирает DOCX каждого примера и проверяет, что разбор возвращает исходный шаблон.
- **Веб.** Общий хук копирования `useCopy` (вынесен из `TagsPanel`), страница `HelpPage` (оглавление-якоря слева, разделы с карточками справа), ленивый маршрут `admin/help` внутри существующего `RequireAdmin`, пункт меню и ссылка в панели инструментов вкладки «Документ» рядом с кнопкой «Теги».

**Tech Stack:**
- API: Fastify 5, vitest + testcontainers;
- веб: React 19, Gravity UI 7 (`Link`, `Alert`, `Button`, `@gravity-ui/icons`), react-router 7 (`lazy`), vitest + testing-library;
- скрипт: tsx 4, jszip 3 (уже в корневых `devDependencies`), `docker compose exec`;
- E2E: Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §23.

## Global Constraints

- Node 22: каждую команду начинать с `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null &&`.
- Гейты: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test`; если менялся `apps/api` — ещё `pnpm test:int`.
- Сообщения коммитов заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `.env` и `certs/` не коммитятся; секреты (`ADMIN_PASSWORD`, `REDIS_PASSWORD` и др.) не печатаются в вывод. `docker compose exec` не печатает окружение; раннер выводит только результаты рендера.
- Перед `docker build` / `up --build`: `df -h /System/Volumes/Data`; если свободно меньше 2 GiB — BLOCKED. Новые образы не тянуть: стек и testcontainers используют уже скачанные образы.
- Не делать `prune` чужих docker-ресурсов. Можно удалять только висячие образы проекта `carbone-reports`. `down` — без `-v`.
- Весь текст интерфейса — на русском.
- Новых зависимостей нет (§23.3).
- Источник фактов — матрица `docs/superpowers/notes/2026-10-13-carbone-community-matrix.md`. Как работающее показывается только то, что в ней отмечено ✅; выводы примеров — точные выводы матрицы (для чисел и денег — колонка `lang:'ru'`). Пример с ⚠️ допустим только с заметкой «Внимание», объясняющей подвох.
- §23.1: маршрут `/admin/help`, заголовок «Справка по шаблонам». Доступна только админам; у пользователя без прав админа маршрут ведёт себя так же, как другие админские страницы (`RequireAdmin` → `/reports`). Пункт «Справка по шаблонам» стоит в меню администрирования.
- §23.1: в редакторе шаблона рядом с панелью «Теги» ссылка «Справка по синтаксису»; она открывает `/admin/help` в новой вкладке (`target="_blank"`, `rel="noopener"`), поэтому документ в OnlyOffice остаётся открытым.
- §23.1: слева оглавление по разделам (якоря), справа содержание. Карточка примера: заголовок, «Тег в шаблоне» (моноширинный текст и кнопка «Копировать»), «Данные» (JSON), «Результат» и, при необходимости, заметка «Внимание».
- §23.2: разделы — 1 «Основы», 2 «Таблицы», 3 «Форматирование», 4 «Условия», 5 «Итоги и группировка», 6 «Недоступно в бесплатной версии»; состав разделов — как в §23.2.
- §23.3: содержание — типизированный модуль веба: разделы → примеры `{ id, title, template, data, result, note? }`; модульный тест: `data` — корректный JSON, `id` уникальны, каждый раздел оглавления существует. `scripts/help-check.ts` (`pnpm help:check`) рендерит минимальный DOCX с тегом так же, как API (тот же `lang`, `timezone`), сравнивает текст с `result`, при расхождении — ненулевой код выхода. Для примеров раздела 6 проверяет ошибку «disabled in the Community Edition». Запускается в живом прогоне на демо-стеке, в CI его нет.
- §23.4: рендер передаёт Carbone `lang: 'ru'` вместо `'ru-ru'`. Ключа переводов `ru-ru` в коде нет (`translations` в Carbone не передаётся — проверено grep по `apps`, `scripts`, `e2e`, `packages`), менять нечего.
- §23.4: ошибка Carbone вида «Formatter "X" is disabled in the Community Edition» при генерации и предпросмотре → `AppError('CARBONE_COMMUNITY', 400, 'в шаблоне используется X — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»')`. Имя форматтера берётся из ответа; если его разобрать не удалось — «форматтер». Другие ошибки Carbone — по-прежнему (`CARBONE_ERROR 502 ошибка генерации: …`).
- Точный текст ошибки Carbone (из `results.txt`, `results2.txt`): HTTP 500, `{"success":false,"error":"Unable to generate the document. Error: Formatter \"aggSum\" is disabled in the Community Edition. Source: \"{d.cars[].qty:aggSum}\"","code":"w101",…}`. Для `:count()` в ответе стоит `cumCount`.

## Review Focus

1. **Неверное сопоставление ошибки Community.** Регулярка ловит чужие ошибки (`Formatter "fooBar" does not exist`, «has no corresponding [i+1]»), берёт имя из `Source: "…"` вместо фразы «Formatter "X" is disabled…» или пропускает в сообщение произвольный текст из кавычек. Ожидание: имя — только идентификатор из той же фразы, иначе «форматтер»; прочие ошибки остаются `CARBONE_ERROR 502`. Тест: Task 1, `community.test.ts` (все пять случаев) и `client.test.ts` «форматтер отключён в Community → CARBONE_COMMUNITY 400».
2. **`lang: 'ru'` не доходит до Carbone.** Константа поменялась, но рендер или предпросмотр передают другое значение, или `help-check` рендерит не так, как API, и «подтверждает» не то. Тест: Task 1, `reports.int.test.ts` — заглушка Carbone записывает `opts.lang`, проверки `lang: 'ru'` в генерации и в `preview mode=pdf`; Task 3 — раннер берёт `lang` из той же `CARBONE_LANG`.
3. **`400 CARBONE_COMMUNITY` теряется по дороге.** Ошибка с кодом 400 могла бы считаться ошибкой ввода и не попасть в историю, или веб показал бы общий текст вместо сообщения. Тест: Task 1, `reports.int.test.ts` «форматтер недоступен в Community → 400 …, запись со status=error» (настоящий `CarboneClient` против поддельного Carbone) и «preview: форматтер недоступен…»; `ReportRunPage.test.tsx` «ошибка Community показывается как есть».
4. **Справка расходится с Carbone.** Опечатка в `result`, «неканоничная» строка таблицы, которую скрипт собирает не так, как показано, или сообщение раздела 6 в справке не совпадает с текстом API. Тест: Task 2, `content.test.ts` (форма строк таблиц, `unavailable` только в разделе 6 и только с сообщением API); Task 3, `pnpm help:check -- --self-test` (сборка ↔ разбор) и живой `pnpm help:check` с 0 расхождений (сообщения раздела 6 сравниваются с `communityErrorMessage`).
5. **Ссылка и доступ.** Без `target="_blank"` ссылка уводит из редактора и закрывает документ OnlyOffice; без `RequireAdmin` справка доступна пользователю. Тест: Task 2, `DocumentTab.test.tsx` «ссылка «Справка по синтаксису»…», `HelpPage.test.tsx` «пользователь без прав админа…»; Task 3, `e2e/tests/help.spec.ts` (новая вкладка, редактор остаётся на месте).

---

## Task 1: API — `lang: 'ru'` и ошибка `CARBONE_COMMUNITY` (§23.4)

**Files:**
- Modify: `packages/shared/src/index.ts:29` (после `outputFormatsFor` — константа `CARBONE_LANG`)
- Modify: `apps/api/src/modules/reports/service.ts:1-6` (импорт), `:77` (`lang`)
- Create: `apps/api/src/modules/carbone/community.ts`
- Create: `apps/api/src/modules/carbone/community.test.ts`
- Modify: `apps/api/src/modules/carbone/client.ts:2` (импорт), `:126-129` (разбор ошибки рендера)
- Modify: `apps/api/src/modules/carbone/client.test.ts:39`, `:63` (`lang`), новый тест после `:178`
- Modify: `apps/api/test/reports.int.test.ts:5-14` (импорт), `:22-32` (заглушка Carbone), `:91-100` (ожидание `lang`), новые тесты после `:150`, `:388-398` (preview pdf)
- Modify: `apps/api/test/redis.int.test.ts:35` (`lang`)
- Modify: `apps/web/src/pages/ReportRunPage.test.tsx` (новый тест после `:115`)

**Interfaces:**
- Consumes: `RenderOptions.lang: string` (`apps/api/src/deps.ts:15-20`); `AppError(code, status, message)` (`apps/api/src/lib/errors.ts`); формат ответа Carbone при ошибке — JSON `{ success: false, error: string, code }` (`client.ts:126-127` уже читает `body.error`). Маршруты `/api/reports/:id/render` и `/api/templates/:id/preview` (`reports/routes.ts:47-99`, `:199-215`) пробрасывают `AppError` как есть; в историю не пишется только `VALIDATION` (`routes.ts:84`).
- Produces:
  - `CARBONE_LANG: 'ru'` из `@carbone-reports/shared`;
  - `communityErrorMessage(carboneError: string): string | null` из `apps/api/src/modules/carbone/community.ts` (её же импортирует `scripts/help-check.ts` в Task 3);
  - ответ API `400 { error: { code: 'CARBONE_COMMUNITY', message } }` при генерации и предпросмотре; запуск генерации с этой ошибкой пишется в историю со `status: 'error'` и тем же `message`.
- Веб правок не требует: `ReportRunPage` показывает `error.message` через `ErrorAlert` (`ReportRunPage.tsx:60`, `:104`), `PreviewTab` — через `GeneralError` (`PreviewTab.tsx:89-90`), `HistoryPage` — `r.error` (`HistoryPage.tsx:104`). Новый веб-тест это закрепляет.

- [ ] **Step 1: Падающие юнит-тесты сопоставления**

`apps/api/src/modules/carbone/community.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { communityErrorMessage } from './community';

const msg = (name: string) =>
  `в шаблоне используется ${name} — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»`;

describe('communityErrorMessage', () => {
  it('имя форматтера берётся из ответа Carbone', () => {
    expect(
      communityErrorMessage(
        'Unable to generate the document. Error: Formatter "aggSum" is disabled in the Community Edition. Source: "{d.cars[].qty:aggSum}"',
      ),
    ).toBe(msg('aggSum'));
  });

  it('count() Carbone называет cumCount — так и пишем', () => {
    expect(
      communityErrorMessage(
        'Unable to generate the document. Error: Formatter "cumCount" is disabled in the Community Edition. Source: "{d.cars[i].brand:cumCount}"',
      ),
    ).toBe(msg('cumCount'));
  });

  it('имя берётся из фразы «… is disabled …», а не из Source', () => {
    expect(
      communityErrorMessage(
        'Error: Formatter "html" is disabled in the Community Edition. Source: "{d.x:print(\'Formatter "y"\')}"',
      ),
    ).toBe(msg('html'));
  });

  it('имя не разобрать → «форматтер»', () => {
    expect(communityErrorMessage('Error: Formatter is disabled in the Community Edition')).toBe(
      msg('форматтер'),
    );
    expect(
      communityErrorMessage('Error: Formatter "a<b> c" is disabled in the Community Edition'),
    ).toBe(msg('форматтер'));
  });

  it('другие ошибки Carbone — не Community', () => {
    for (const e of [
      'Unable to generate the document. Error: Formatter "fooBar" does not exist. Do you mean "mod"?',
      'Unable to generate the document. Error: The marker {d.cars[i].brand} has no corresponding [i+1] for array "cars".',
      'Template not found',
      'HTTP 500',
    ]) {
      expect(communityErrorMessage(e)).toBeNull();
    }
  });
});
```

В `apps/api/src/modules/carbone/client.test.ts` после теста «ошибка рендера → AppError CARBONE_ERROR 502 с текстом Carbone» (строка 178) добавить:

```ts
  it('форматтер отключён в Community → CARBONE_COMMUNITY 400 с именем из ответа', async () => {
    const { fn } = fakeFetch((c) =>
      c.url.endsWith('/template')
        ? json(200, { success: true, data: { templateId: 'x' } })
        : json(500, {
            success: false,
            error:
              'Unable to generate the document. Error: Formatter "aggSum" is disabled in the Community Edition. Source: "{d.cars[].qty:aggSum}"',
            code: 'w101',
            data: { renderId: '' },
          }),
    );
    const e = await new CarboneClient({ baseUrl: 'http://c', fetch: fn })
      .render(tpl(), {}, opts)
      .catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect([e.code, e.status]).toEqual(['CARBONE_COMMUNITY', 400]);
    expect(e.message).toBe(
      'в шаблоне используется aggSum — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»',
    );
  });
```
Там же строки 39 и 63: `lang: 'ru-ru'` → `lang: 'ru'` (значение, которое теперь реально уходит; тест проверяет только сквозную передачу). `apps/api/test/redis.int.test.ts:35` — так же.

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api exec vitest run src/modules/carbone
```
Ожидание: FAIL — `community.test.ts` не находит модуль `./community`, новый тест клиента получает `CARBONE_ERROR 502`.

- [ ] **Step 2: Падающие интеграционные тесты**

`apps/api/test/reports.int.test.ts`. В импорты (строки 5–14) добавить:

```ts
import { CarboneClient } from '../src/modules/carbone/client';
```

Строки 22–32 (флаг и заглушка Carbone) заменить:

```ts
let carboneFails = false;
let carboneCommunity = false;

const COMMUNITY_MESSAGE =
  'в шаблоне используется aggSum — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»';

/** Настоящий клиент против поддельного Carbone, который отвечает ошибкой Community (как в матрице). */
const communityCarbone = new CarboneClient({
  baseUrl: 'http://carbone',
  fetch: (async (input: RequestInfo | URL) =>
    String(input).endsWith('/template')
      ? Response.json({ success: true, data: { templateId: 'community' } })
      : Response.json(
          {
            success: false,
            error:
              'Unable to generate the document. Error: Formatter "aggSum" is disabled in the Community Edition. Source: "{d.orders[].total:aggSum}"',
            code: 'w101',
          },
          { status: 500 },
        )) as typeof fetch,
});

// Поддельный Carbone возвращает JSON того, что ему передали.
const carbone: CarboneRenderer = {
  async render(tpl, data, opts) {
    if (carboneFails) throw new AppError('CARBONE_ERROR', 502, 'ошибка генерации: boom');
    if (carboneCommunity) return communityCarbone.render(tpl, data, opts);
    return Buffer.from(
      JSON.stringify({
        version: tpl.version,
        data,
        convertTo: opts.convertTo,
        lang: opts.lang,
        tz: opts.timezone,
      }),
    );
  },
};
```

В тесте «user генерирует отчёт…» ожидание (строки 91–100) дополнить полем `lang`:

```ts
    expect(JSON.parse(file.body)).toEqual({
      version: 1,
      data: {
        orders: [{ id: 2, total: 250.5 }],
        company: { name: 'ООО Ромашка' },
        params: { from: '2026-02-01' },
      },
      convertTo: 'pdf',
      lang: 'ru',
      tz: 'Europe/Moscow',
    });
```

После теста «ошибка Carbone → 502 и запись со status=error» (строка 150) добавить:

```ts
  it('форматтер недоступен в Community → 400 CARBONE_COMMUNITY и запись со status=error', async () => {
    carboneCommunity = true;
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'pdf' }).finally(
      () => {
        carboneCommunity = false;
      },
    );
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: 'CARBONE_COMMUNITY', message: COMMUNITY_MESSAGE });
    const runs = await t.app.inject({
      method: 'GET',
      url: '/api/runs?status=error',
      headers: { cookie: userA },
    });
    expect(runs.json().items[0]).toMatchObject({
      status: 'error',
      error: COMMUNITY_MESSAGE,
      fileAvailable: false,
    });
  });
```

Тест «preview mode=pdf отдаёт application/pdf inline» (строки 388–398) дополнить проверкой тела (заглушка отдаёт JSON переданных опций):

```ts
    expect(JSON.parse(r.body)).toMatchObject({ convertTo: 'pdf', lang: 'ru' });
```
и после него добавить:

```ts
  it('preview: форматтер недоступен в Community → 400 CARBONE_COMMUNITY', async () => {
    carboneCommunity = true;
    const r = await t.app
      .inject({
        method: 'POST',
        url: `/api/templates/${tplId}/preview`,
        headers: { cookie: admin },
        payload: { params: { from: '2026-01-01' }, mode: 'pdf' },
      })
      .finally(() => {
        carboneCommunity = false;
      });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: 'CARBONE_COMMUNITY', message: COMMUNITY_MESSAGE });
  });
```

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/reports.int.test.ts
```
Ожидание: FAIL — `lang` равен `'ru-ru'`, Community даёт `502 CARBONE_ERROR`.

- [ ] **Step 3: Реализация**

`packages/shared/src/index.ts` — после `outputFormatsFor` (строка 29):

```ts

/** Язык Carbone: `ru` даёт русские разделители чисел и рубли в formatC; `ru-ru` — нет (матрица Community, §23.4). */
export const CARBONE_LANG = 'ru';
```

`apps/api/src/modules/reports/service.ts`, импорт (строки 1–6):

```ts
import {
  CARBONE_LANG,
  outputFormatsFor,
  type OutputFormat,
  type ParamValue,
  type ParamsInput,
} from '@carbone-reports/shared';
```
строка 77: `lang: 'ru-ru',` → `lang: CARBONE_LANG,`.

`apps/api/src/modules/carbone/community.ts`:

```ts
const DISABLED = /is disabled in the Community Edition/;
/** Имя — только идентификатор из той же фразы; Source с кавычками сюда не попадает. */
const NAME = /Formatter "([A-Za-z_][A-Za-z0-9_]*)" is disabled in the Community Edition/;

/**
 * Ошибка Carbone «Formatter "X" is disabled in the Community Edition» → сообщение для пользователя.
 * Другие ошибки — null. Имя не разобрать — «форматтер».
 */
export function communityErrorMessage(carboneError: string): string | null {
  if (!DISABLED.test(carboneError)) return null;
  const name = NAME.exec(carboneError)?.[1] ?? 'форматтер';
  return `в шаблоне используется ${name} — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»`;
}
```

`apps/api/src/modules/carbone/client.ts`: после строки 2 добавить `import { communityErrorMessage } from './community';`. Строки 126–129 заменить:

```ts
    const body = (isJson ? await res.json().catch(() => null) : null) as { error?: string } | null;
    const error = body?.error ?? `HTTP ${res.status}`;
    // Отключённый в Community форматтер — ошибка шаблона, а не сбой сервиса (§23.4).
    const community = communityErrorMessage(error);
    if (community) throw new AppError('CARBONE_COMMUNITY', 400, community);
    if (res.status === 404 || /template not found/i.test(error)) throw new TemplateMissing(error);
    throw new AppError('CARBONE_ERROR', 502, `ошибка генерации: ${error}`);
```
Внешний `catch` в `render` (строки 52–58) пробрасывает `AppError` как есть — менять не нужно.

`apps/web/src/pages/ReportRunPage.test.tsx` — после теста «несуществующий шаблон → сообщение об ошибке» (строка 115):

```ts
  it('ошибка Community показывается как есть', async () => {
    const message =
      'в шаблоне используется aggSum — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»';
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      {
        method: 'POST',
        path: '/api/reports/t1/render',
        status: 400,
        body: { error: { code: 'CARBONE_COMMUNITY', message } },
      },
    ]);
    renderRoute('/reports/t1');
    await userEvent.click(await screen.findByRole('button', { name: 'Сформировать' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
```
Этот тест проходит и без правок веба: он закрепляет, что сообщение API доходит до пользователя без замены.

- [ ] **Step 4: Запуск — должно пройти**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api exec vitest run src/modules/carbone && pnpm --filter @carbone-reports/web exec vitest run src/pages/ReportRunPage.test.tsx
```
Ожидание: все зелёные, включая прежний тест `CARBONE_ERROR 502`.

```bash
grep -rn "ru-ru" apps scripts e2e packages demo --include='*.ts' --include='*.tsx' | grep -v node_modules
```
Ожидание: пусто.

- [ ] **Step 5: Гейты и коммит**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm test:int
git add packages/shared/src/index.ts apps/api/src/modules/reports/service.ts apps/api/src/modules/carbone/community.ts apps/api/src/modules/carbone/community.test.ts apps/api/src/modules/carbone/client.ts apps/api/src/modules/carbone/client.test.ts apps/api/test/reports.int.test.ts apps/api/test/redis.int.test.ts apps/web/src/pages/ReportRunPage.test.tsx
git commit -m "feat(api): lang 'ru' for Carbone; CARBONE_COMMUNITY 400 for disabled formatters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Содержание справки, страница, маршрут, меню и ссылка (§23.1–23.3)

**Files:**
- Create: `apps/web/src/components/useCopy.ts`
- Modify: `apps/web/src/pages/admin/template-editor/TagsPanel.tsx:1-19` (копирование через `useCopy`), `:33` (`onClick`)
- Create: `apps/web/src/pages/admin/help/content.ts`
- Create: `apps/web/src/pages/admin/help/content.test.ts`
- Create: `apps/web/src/pages/admin/help/HelpPage.tsx`
- Create: `apps/web/src/pages/admin/help/HelpPage.test.tsx`
- Modify: `apps/web/src/app/routes.tsx:46` (маршрут `help` после `categories`)
- Modify: `apps/web/src/app/Layout.tsx:4` (иконка), `:72` (пункт меню)
- Modify: `apps/web/src/pages/admin/template-editor/DocumentTab.tsx:2` (импорт `Link`), `:198` (ссылка после кнопки «Теги»)
- Modify: `apps/web/src/pages/admin/template-editor/DocumentTab.test.tsx` (новый тест после `:47`)
- Modify: `apps/web/src/app/auth.test.tsx:97` (пункт меню)
- Modify: `apps/web/src/app/global.css:112` (стили справки в конце файла)

**Interfaces:**
- Consumes: `RequireAdmin` (`guards.tsx:31-35`: не-админ → `<Navigate to="/reports" replace />`); ленивые маршруты как у редактора (`routes.tsx:35-42`); `item()` меню (`Layout.tsx:45-56`); `PageHeader` (`components/PageHeader.tsx`, `<h1>`); копирование из `TagsPanel.tsx:6-19`; `Link` из `@gravity-ui/uikit` (при `target="_blank"` без `rel` ставит `noopener noreferrer`, поэтому `rel="noopener"` задаём явно); `CircleQuestion` из `@gravity-ui/icons` (есть в установленной версии); `QueryMode` из `@carbone-reports/shared`.
- Produces:
  - `useCopy(): (text: string, label?: string) => Promise<void>` — уведомления «Скопировано: <label>» / «Не удалось скопировать — выделите тег вручную», уникальное имя на каждое событие;
  - `HelpExample`, `HelpLimit`, `HelpSection`, `HELP_INTRO: string[]`, `HELP_SECTIONS: HelpSection[]` из `content.ts` (импортирует `scripts/help-check.ts` в Task 3);
  - `HelpPage` (`/admin/help`): `<h1>` «Справка по шаблонам», `<nav aria-label="Оглавление">` с `<a href="#<id раздела>">`, `<section id aria-label="<название>">` на раздел, `<article id aria-label="<заголовок примера>">` на пример, кнопка `aria-label="Копировать тег: <заголовок>"`.

- [ ] **Step 1: Падающие тесты**

`apps/web/src/pages/admin/help/content.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HELP_SECTIONS } from './content';

const examples = HELP_SECTIONS.flatMap((s) => s.examples);
const COMMUNITY =
  /^в шаблоне используется [A-Za-z_][A-Za-z0-9_]* — недоступно в бесплатной версии Carbone, см\. «Справка по шаблонам»$/;
/** Каноничная строка таблицы: «| a | b |», пустая ячейка — «| |» (так её выводит help-check). */
const canonicalRow = (line: string) => {
  const cells = line
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
  return `| ${cells.join(' | ')} |`.replace(/\| {2}(?=\|)/g, '| ');
};

describe('содержание справки', () => {
  it('шесть разделов в порядке §23.2', () => {
    expect(HELP_SECTIONS.map((s) => [s.id, s.title])).toEqual([
      ['basics', 'Основы'],
      ['tables', 'Таблицы'],
      ['formatting', 'Форматирование'],
      ['conditions', 'Условия'],
      ['totals', 'Итоги и группировка'],
      ['unavailable', 'Недоступно в бесплатной версии'],
    ]);
    for (const s of HELP_SECTIONS) expect(s.examples.length, s.id).toBeGreaterThan(0);
  });

  it('data каждого примера — корректный JSON-объект', () => {
    for (const e of examples) {
      const parsed: unknown = JSON.parse(e.data);
      expect(typeof parsed === 'object' && parsed !== null, e.id).toBe(true);
    }
  });

  it('id разделов, примеров и пунктов уникальны и годятся для якоря', () => {
    const ids = [
      ...HELP_SECTIONS.map((s) => s.id),
      ...examples.map((e) => e.id),
      ...HELP_SECTIONS.flatMap((s) => (s.limits ?? []).map((l) => l.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('у примеров непустые заголовок, тег и результат; строки таблиц каноничны', () => {
    for (const e of examples) {
      expect(e.title.trim(), e.id).not.toBe('');
      expect(e.template.trim(), e.id).not.toBe('');
      expect(e.result, e.id).not.toBe('');
      for (const line of e.template.split('\n').filter((l) => l.startsWith('|'))) {
        expect(line, e.id).toBe(canonicalRow(line));
      }
      for (const line of e.result.split('\n').filter((l) => l.startsWith('|'))) {
        expect(line, e.id).toBe(canonicalRow(line));
      }
    }
  });

  it('недоступное — только в разделе 6, и результат — сообщение API', () => {
    for (const s of HELP_SECTIONS) {
      for (const e of s.examples) {
        expect(e.unavailable === true, e.id).toBe(s.id === 'unavailable');
        if (e.unavailable) expect(e.result, e.id).toMatch(COMMUNITY);
      }
    }
    const limits = HELP_SECTIONS.find((s) => s.id === 'unavailable')!.limits ?? [];
    expect(limits.map((l) => l.id)).toEqual(['na-images', 'na-autoorient', 'na-sort-desc', 'na-txt']);
  });
});
```

`apps/web/src/pages/admin/help/HelpPage.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { adminMe, mockApi, renderRoute, renderWithProviders, userMe } from '../../../test/utils';
import { HELP_SECTIONS } from './content';
import { HelpPage } from './HelpPage';

describe('HelpPage', () => {
  it('оглавление: каждая ссылка ведёт на существующий раздел', async () => {
    renderWithProviders(<HelpPage />, { route: '/admin/help' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Справка по шаблонам' }),
    ).toBeInTheDocument();
    const links = within(screen.getByRole('navigation', { name: 'Оглавление' })).getAllByRole(
      'link',
    );
    expect(links.map((l) => l.textContent)).toEqual(HELP_SECTIONS.map((s) => s.title));
    HELP_SECTIONS.forEach((s, i) => {
      expect(links[i]).toHaveAttribute('href', `#${s.id}`);
      const target = document.getElementById(s.id);
      expect(target, s.id).not.toBeNull();
      expect(screen.getByRole('region', { name: s.title })).toBe(target);
    });
  });

  it('все примеры и пункты раздела 6 на странице', async () => {
    renderWithProviders(<HelpPage />);
    const examples = HELP_SECTIONS.flatMap((s) => s.examples);
    expect(await screen.findAllByRole('article')).toHaveLength(examples.length);
    for (const e of examples) {
      expect(document.getElementById(e.id)).toBe(screen.getByRole('article', { name: e.title }));
    }
    for (const l of HELP_SECTIONS.flatMap((s) => s.limits ?? [])) {
      expect(document.getElementById(l.id)).toHaveTextContent(l.title);
    }
  });

  it('карточка: тег, данные, результат, «Внимание»; «Копировать» копирует тег', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<HelpPage />);
    const e = HELP_SECTIONS[0]!.examples[0]!;
    const card = await screen.findByRole('article', { name: e.title });
    for (const label of ['Тег в шаблоне', 'Данные', 'Результат', 'Внимание']) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
    expect(within(card).getByText(e.template)).toBeInTheDocument();
    expect(within(card).getByText(e.result)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: `Копировать тег: ${e.title}` }));
    expect(writeText).toHaveBeenCalledWith(e.template);
    expect(await screen.findByText(`Скопировано: ${e.title}`)).toBeInTheDocument();
  });

  it('админ: маршрут /admin/help и пункт меню', async () => {
    mockApi([adminMe]);
    renderRoute('/admin/help');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Справка по шаблонам' }),
    ).toBeInTheDocument();
    // Заголовок страницы и пункт меню.
    expect(screen.getAllByText('Справка по шаблонам')).toHaveLength(2);
  });

  it('пользователь без прав админа на /admin/help попадает в /reports', async () => {
    mockApi([userMe, { path: '/api/templates', body: [] }]);
    const { router } = renderRoute('/admin/help');
    await waitFor(() => expect(router.state.location.pathname).toBe('/reports'));
    expect(screen.queryByText('Справка по шаблонам')).not.toBeInTheDocument();
  });
});
```
Первый пример раздела «Основы» (`basics-field`) — однострочный и с заметкой; на это опирается третий тест.

`apps/web/src/pages/admin/template-editor/DocumentTab.test.tsx` — после первого теста (строка 47):

```tsx
  it('ссылка «Справка по синтаксису» открывает /admin/help в новой вкладке', async () => {
    mockApi([{ path: '/api/templates/t1/editor-config', body: config }]);
    renderWithProviders(<DocumentTab {...base} />);
    const link = await screen.findByRole('link', { name: 'Справка по синтаксису' });
    expect(link).toHaveAttribute('href', '/admin/help');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
  });
```

`apps/web/src/app/auth.test.tsx:97` — после `expect(screen.getByText('Шаблоны')).toBeInTheDocument();`:

```tsx
    expect(screen.getByText('Справка по шаблонам')).toBeInTheDocument();
```

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/web exec vitest run src/pages/admin/help src/pages/admin/template-editor/DocumentTab.test.tsx src/app/auth.test.tsx
```
Ожидание: FAIL — нет `./content` и `./HelpPage`, нет ссылки, нет пункта меню.

- [ ] **Step 2: `useCopy` и `TagsPanel`**

`apps/web/src/components/useCopy.ts`:

```ts
import { useToaster } from '@gravity-ui/uikit';

let toastSeq = 0;

/** Копирование в буфер обмена с уведомлением. `label` — что показать в «Скопировано: …». */
export function useCopy() {
  const { add } = useToaster();
  return async (text: string, label: string = text) => {
    // Имя уникально для каждого события, иначе Toaster склеит повторные уведомления.
    const name = `copy-${++toastSeq}`;
    try {
      await navigator.clipboard.writeText(text);
      add({ name, title: `Скопировано: ${label}`, theme: 'success', autoHiding: 2000 });
    } catch {
      add({ name, title: 'Не удалось скопировать — выделите тег вручную', theme: 'warning' });
    }
  };
}
```

`TagsPanel.tsx`, строки 1–19 заменить:

```tsx
import { ArrowsRotateRight, Copy } from '@gravity-ui/icons';
import { Button, Icon, Text } from '@gravity-ui/uikit';
import { useCopy } from '../../../components/useCopy';
import type { TagNode } from '../../../lib/tagTree';
import { buildTagTree } from '../../../lib/tagTree';

function TagRow({ tag, hint }: { tag: string; hint?: string }) {
  const copy = useCopy();
```
и в кнопке (строка 33 исходного файла) `onClick={copy}` → `onClick={() => void copy(tag)}`. Тексты уведомлений не меняются, тесты `TagsPanel.test.tsx` остаются зелёными.

- [ ] **Step 3: Модуль содержания**

`apps/web/src/pages/admin/help/content.ts` — целиком. Все выводы взяты из матрицы; для чисел и денег — колонка `lang:'ru'`. `CARS` и `GROUPS` — данные проб матрицы (без неиспользуемого поля `price`).

```ts
import type { QueryMode } from '@carbone-reports/shared';

/**
 * Пример тега. В `template` и `result` строка, начинающаяся с «|», — строка таблицы Word
 * («| ячейка | ячейка |», пустая ячейка — «| |»), остальные строки — абзацы. Пустые абзацы
 * в `result` не пишутся. Формат проверяют content.test.ts и `pnpm help:check`.
 */
export interface HelpExample {
  id: string;
  title: string;
  template: string;
  /** JSON данных отчёта (объект `d`). */
  data: string;
  /** Текст результата; для `unavailable` — сообщение API. */
  result: string;
  /** Заметка «Внимание»; `код` — в обратных кавычках. */
  note?: string;
  /** SQL-запрос шаблона, который даёт такие данные (раздел «Итоги и группировка»). */
  sql?: { key: string; mode: QueryMode; text: string };
  /** Отключено в бесплатной версии: Carbone отвечает ошибкой. */
  unavailable?: true;
}

/** Недоступное без проверяемого тега: что происходит и что делать вместо. */
export interface HelpLimit {
  id: string;
  title: string;
  instead: string;
}

export interface HelpSection {
  id: string;
  title: string;
  intro: string[];
  examples: HelpExample[];
  limits?: HelpLimit[];
}

const j = (v: unknown) => JSON.stringify(v, null, 2);
const L = (...lines: string[]) => lines.join('\n');
/** Сообщение API для отключённого форматтера (apps/api/src/modules/carbone/community.ts). */
const community = (name: string) =>
  `в шаблоне используется ${name} — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»`;

const CARS = [
  { brand: 'Лада', qty: 3, ok: true },
  { brand: 'Тесла', qty: 1, ok: false },
  { brand: 'Лада', qty: 2, ok: true },
  { brand: 'БМВ', qty: 5, ok: true },
];
const GROUPS = [
  { name: 'Г1', items: [{ x: 'a' }, { x: 'b' }] },
  { name: 'Г2', items: [{ x: 'c' }] },
  { name: 'Г3', items: [] },
];

export const HELP_INTRO: string[] = [
  'Здесь только то, что проверено на нашем Carbone — бесплатной версии (Community Edition). Всё, чего в ней нет, собрано в последнем разделе вместе с заменами.',
  'Данные отчёта — объект `d`. Результат каждого SQL-запроса шаблона лежит под его ключом: в режиме «Список строк» — массив, в режиме «Одна строка» — объект (или пусто). Параметры отчёта — в `d.params`.',
  'В примерах строка, которая начинается с «|», — строка таблицы Word, ячейки разделены «|». Остальные строки — отдельные абзацы.',
];

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'basics',
    title: 'Основы',
    intro: [
      'Тег `{d.поле}` подставляет значение из данных. Путь через точку ведёт во вложенные объекты, `[номер]` — к элементу массива (с нуля), `[поле=значение]` — к элементу по условию.',
    ],
    examples: [
      {
        id: 'basics-field',
        title: 'Значение поля',
        template: 'Покупатель: {d.name}',
        data: j({ name: 'Иван' }),
        result: 'Покупатель: Иван',
        note: 'Если поля нет в данных, подставляется пустая строка, ошибки не будет.',
      },
      {
        id: 'basics-nested',
        title: 'Вложенный объект',
        template: '{d.client.address.city}',
        data: j({ client: { address: { city: 'Москва' } } }),
        result: 'Москва',
      },
      {
        id: 'basics-search',
        title: 'Элемент массива по условию',
        template: '{d.items[id=2].name}',
        data: j({
          items: [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
          ],
        }),
        result: 'b',
        note: "Строковое значение — в кавычках: `{d.items[code='X'].name}`. Элемент по номеру — `{d.items[0].name}` (нумерация с нуля).",
      },
      {
        id: 'basics-params',
        title: 'Параметр отчёта',
        template: "Период с {d.params.from:formatD('DD.MM.YYYY')}",
        data: j({ params: { from: '2026-03-01' } }),
        result: 'Период с 01.03.2026',
        note: "Параметры отчёта лежат в `d.params` под своими именами. Теги `{c.…}` в нашей системе не заполняются, кроме `{c.now}` — момента формирования: `{c.now:formatD('DD.MM.YYYY')}`.",
      },
      {
        id: 'basics-ifempty',
        title: 'Значение по умолчанию',
        template: "Оплачен: {d.paid_on:formatD('DD.MM.YYYY'):ifEmpty('—')}",
        data: j({ paid_on: null }),
        result: 'Оплачен: —',
        note: "`ifEmpty` ставится последним в цепочке: `{d.paid_on:ifEmpty('—'):formatD('DD.MM.YYYY')}` напечатает «Invalid Date». Пустыми считаются null, пустая строка, пустой массив и отсутствующее поле; 0 остаётся 0.",
      },
      {
        id: 'basics-alias',
        title: 'Алиас',
        template: '{#cl = d.client}{$cl.name}',
        data: j({ client: { name: 'Пётр' } }),
        result: 'Пётр',
        note: 'Алиас объявляется тегом `{#имя = путь}`, сам этот тег ничего не печатает. Дальше вместо пути пишется `{$имя…}`.',
      },
    ],
  },
  {
    id: 'tables',
    title: 'Таблицы',
    intro: [
      'Строка таблицы повторяется для каждого элемента массива: в ней теги с `[i]`, а в следующей строке — хотя бы один тег с `[i+1]`. Строка с `[i+1]` в результат не попадает. Без `[i+1]` Carbone отвечает ошибкой «has no corresponding [i+1]».',
      'Так же повторяются абзацы: абзац с `[i]`, за ним абзац с `[i+1]`.',
    ],
    examples: [
      {
        id: 'tables-rows',
        title: 'Строки таблицы из массива',
        template: L(
          '| Марка | Кол-во |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Марка | Кол-во |', '| Лада | 3 |', '| Тесла | 1 |', '| Лада | 2 |', '| БМВ | 5 |'),
      },
      {
        id: 'tables-nested',
        title: 'Вложенный цикл',
        template: L(
          '{d.groups[i].name}:',
          '- {d.groups[i].items[i].x}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
        ),
        data: j({ groups: GROUPS }),
        result: L('Г1:', '- a', '- b', 'Г2:', '- c', 'Г3:'),
        note: 'Пустой вложенный массив не даёт строк — у «Г3» их нет, ошибки тоже нет.',
      },
      {
        id: 'tables-nested-rows',
        title: 'Вложенный цикл в строках таблицы',
        template: L(
          '| {d.groups[i].name} | |',
          '| | {d.groups[i].items[i].x} |',
          '| | {d.groups[i].items[i+1].x} |',
          '| {d.groups[i+1].name} | |',
        ),
        data: j({ groups: GROUPS }),
        result: L('| Г1 | |', '| | a |', '| | b |', '| Г2 | |', '| | c |', '| Г3 | |'),
      },
      {
        id: 'tables-empty',
        title: 'Пустой массив',
        template: L(
          'до',
          '| Марка |',
          '| {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} |',
          'после',
          "{d.cars:ifEM():show('Нет данных'):elseShow('')}",
        ),
        data: j({ cars: [] }),
        result: L('до', '| Марка |', 'после', 'Нет данных'),
        note: "Строки цикла исчезают, остаётся шапка; ключа может не быть совсем — результат тот же. Без `elseShow('')` при непустом массиве `ifEM` напечатает само значение.",
      },
      {
        id: 'tables-numbering',
        title: 'Номер строки',
        template: L(
          '| № | Марка |',
          '| {d.cars[i].brand:print(.i):add(1)} | {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| № | Марка |', '| 1 | Лада |', '| 2 | Тесла |', '| 3 | Лада |', '| 4 | БМВ |'),
        note: 'Тег `{d.cars[i].i}` ничего не печатает, а `:count()` в бесплатной версии недоступен. Внутри цикла с фильтром номера идут с пропусками: `.i` — номер в исходном массиве (например, 1, 3, 4). Надёжнее нумеровать в SQL — раздел «Итоги и группировка».',
      },
      {
        id: 'tables-filter',
        title: 'Отбор строк',
        template: L('| {d.cars[i, ok=true].brand} |', '| {d.cars[i+1, ok=true].brand} |'),
        data: j({ cars: CARS }),
        result: L('| Лада |', '| Лада |', '| БМВ |'),
        note: "Так же работают сравнения `[i, qty > 1]`, строки `[i, brand='Лада']` и несколько условий через запятую — они соединяются через И; ИЛИ нет, заведите флаг в SQL. Скрыть строку таблицы можно только так: `hideBegin`/`hideEnd` в таблице оставляют пустую строку (раздел «Условия»).",
      },
      {
        id: 'tables-sort',
        title: 'Сортировка',
        template: L('{d.cars[qty, i].brand}', '{d.cars[qty+1, i+1].brand}'),
        data: j({ cars: CARS }),
        result: L('Тесла', 'Лада', 'Лада', 'БМВ'),
        note: 'Только по возрастанию. `[-qty, i]` молча оставляет исходный порядок — по убыванию сортируйте в SQL (`order by … desc`).',
      },
    ],
  },
  {
    id: 'formatting',
    title: 'Форматирование',
    intro: [
      "Форматтер пишется после двоеточия: `{d.поле:formatD('DD.MM.YYYY')}`. Форматтеры соединяются в цепочку и применяются слева направо.",
    ],
    examples: [
      {
        id: 'fmt-date-long',
        title: 'Дата прописью',
        template: "{d.date:formatD('DD MMMM YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '08 марта 2026',
        note: "`formatD('D MMMM YYYY г.')` даёт «8 марта 2026 г.», `formatD('MMMM YYYY')` — «март 2026».",
      },
      {
        id: 'fmt-date-short',
        title: 'Дата цифрами',
        template: "{d.date:formatD('DD.MM.YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '08.03.2026',
      },
      {
        id: 'fmt-date-time',
        title: 'Дата и время',
        template: "{d.at:formatD('DD.MM.YYYY HH:mm')}",
        data: j({ at: '2026-03-08T23:30:00+03:00' }),
        result: '08.03.2026 23:30',
        note: 'Время выводится в часовом поясе сервера (`TZ`, по умолчанию Europe/Moscow). Передавайте время со смещением (`+03:00`) или в UTC (`Z`).',
      },
      {
        id: 'fmt-date-naive',
        title: 'Время без смещения',
        template: "{d.at:formatD('DD.MM.YYYY HH:mm')}",
        data: j({ at: '2026-03-08 23:30:00' }),
        result: '09.03.2026 02:30',
        note: 'Время без смещения считается временем UTC и сдвигается на 3 часа. Передавайте время со смещением или дату без времени.',
      },
      {
        id: 'fmt-number',
        title: 'Число',
        template: '{d.n:formatN(2)}',
        data: j({ n: 1234567.891 }),
        result: '1 234 567,89',
        note: 'Разделитель разрядов — обычный пробел, длинное число может перенестись на другую строку. `formatN(0)` округляет до целого: 1234567.5 → «1 234 568».',
      },
      {
        id: 'fmt-money',
        title: 'Сумма в рублях',
        template: '{d.sum:formatC()}',
        data: j({ sum: 1234567.891 }),
        result: '1 234 567,89 ₽',
        note: "`formatC(0)` — без копеек: 1234.5 → «1 235 ₽». Не используйте `formatC('M')` и `formatC('LL')`: название валюты выводится по-английски (roubles).",
      },
      {
        id: 'fmt-convcurr',
        title: 'Пересчёт в другую валюту',
        template: "{d.sum:convCurr('USD')}",
        data: j({ sum: 1000 }),
        result: '14.679643146796433',
        note: "Carbone пересчитывает рубли по встроенным курсам: они не обновляются, а свои курсы наша система не передаёт. Так же молча пересчитывает `formatC(2, 'USD')`: 1000 → «14,68 $». Суммы в другой валюте считайте в SQL.",
      },
      {
        id: 'fmt-case',
        title: 'Регистр букв',
        template: '{d.name:ucWords()}',
        data: j({ name: 'иванов иван' }),
        result: 'Иванов Иван',
        note: 'Ещё `ucFirst()` → «Иванов иван», `upperCase()`, `lowerCase()`. Кириллица и «ё» обрабатываются верно.',
      },
      {
        id: 'fmt-ellipsis',
        title: 'Обрезка строки',
        template: '{d.title:ellipsis(7)}',
        data: j({ title: 'Длинная строка' }),
        result: 'Длинная...',
        note: "Ещё `substr(0, 5)` → «Длинн», `padl(6, '0')` для «42» → «000042», `prepend('№ ')`, `append(' руб.')`, `replace('-', '/')`.",
      },
      {
        id: 'fmt-math',
        title: 'Арифметика',
        template: '{d.v:add(.b * 2 - 1)}',
        data: j({ v: 10, b: 3 }),
        result: '15',
        note: '`add`, `sub`, `mul`, `div` принимают число или соседнее поле (`.b`); выражения — без скобок. Результат печатается без форматирования — для вывода добавьте `formatN`. Деление на ноль молча возвращает исходное число.',
      },
      {
        id: 'fmt-array-join',
        title: 'Список через запятую',
        template: '{d.tags:arrayJoin()}',
        data: j({ tags: ['a', 'b', 'c'] }),
        result: 'a, b, c',
        note: "Для массива объектов — `{d.items:arrayMap(', ', ':', 'name')}`: значения поля name через запятую.",
      },
      {
        id: 'fmt-multiline',
        title: 'Многострочный текст',
        template: '{d.text:convCRLF}',
        data: j({ text: 'строка1\nстрока2' }),
        result: L('строка1', 'строка2'),
        note: 'Без `convCRLF` перенос строки из данных в Word не виден.',
      },
    ],
  },
  {
    id: 'conditions',
    title: 'Условия',
    intro: [
      'Условие проверяет значение (`ifEQ`, `ifNE`, `ifGT`, `ifGTE`, `ifLT`, `ifLTE`, `ifIN`, `ifNIN`, `ifEM`, `ifNEM`) и печатает `show(…)` или `elseShow(…)`. Условия соединяются через `and(.поле)` и `or(.поле)`.',
      'Абзацы и части текста скрывают `showBegin`/`showEnd` и `hideBegin`/`hideEnd`. Строку таблицы скрывают только фильтром цикла — раздел «Таблицы».',
    ],
    examples: [
      {
        id: 'cond-if',
        title: 'Текст по условию',
        template: "{d.status:ifEQ('paid'):show('Оплачен'):elseShow('Не оплачен')}",
        data: j({ status: 'new' }),
        result: 'Не оплачен',
        note: "Без `elseShow` при ложном условии печатается само значение: `{d.v:ifEQ(1):show('один')}` для 2 даёт «2». Добавляйте `elseShow('')`.",
      },
      {
        id: 'cond-and',
        title: 'Два условия',
        template: "{d.qty:ifGT(0):and(.paid):ifEQ(true):show('к отгрузке'):elseShow('ждём')}",
        data: j({ qty: 2, paid: true }),
        result: 'к отгрузке',
        note: 'Вместо `and` можно `or`: `…:or(.paid):ifEQ(true)…`.',
      },
      {
        id: 'cond-inline',
        title: 'Часть текста по условию',
        template: 'Итого{d.vat:ifEQ(true):showBegin}, включая НДС{d.vat:showEnd}.',
        data: j({ vat: false }),
        result: 'Итого.',
      },
      {
        id: 'cond-paragraphs',
        title: 'Скрыть абзацы',
        template: L(
          'Счёт',
          '{d.paid:ifEQ(true):hideBegin}',
          'Просим оплатить в течение 5 дней.',
          '{d.paid:hideEnd}',
          'Спасибо!',
        ),
        data: j({ paid: true }),
        result: L('Счёт', 'Спасибо!'),
        note: 'Абзацы с тегами `hideBegin`/`hideEnd` тоже исчезают.',
      },
      {
        id: 'cond-table-row',
        title: 'hideBegin в строке таблицы (так нельзя)',
        template: L(
          '| Марка | Кол-во |',
          '| {d.cars[i].ok:ifEQ(false):hideBegin}{d.cars[i].brand} | {d.cars[i].qty}{d.cars[i].ok:hideEnd} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Марка | Кол-во |', '| Лада | 3 |', '| |', '| Лада | 2 |', '| БМВ | 5 |'),
        note: 'Вместо строки «Тесла» остаётся пустая строка из одной ячейки, оформление таблицы ломается. Скрывайте строки фильтром цикла: `{d.cars[i, ok=true].brand}`.',
      },
    ],
  },
  {
    id: 'totals',
    title: 'Итоги и группировка',
    intro: [
      'Агрегаторы Carbone (`aggSum`, `aggCount`, `cumSum`, `:count()` и другие) в бесплатной версии отключены: шаблон с ними не формируется. Итоги, подытоги, нумерацию и группировку считайте в SQL.',
      'Числа из PostgreSQL (`numeric`, `bigint`) приходят в данные числами, `date` — строкой ГГГГ-ММ-ДД, `json` — объектами и массивами.',
    ],
    examples: [
      {
        id: 'totals-sum',
        title: 'Итог отдельным запросом',
        sql: {
          key: 'totals',
          mode: 'single',
          text: L(
            'select count(*) as positions, sum(qty * price) as amount',
            'from invoice_items',
            'where invoice_id = :invoiceId',
          ),
        },
        template: 'Позиций: {d.totals.positions}, на сумму {d.totals.amount:formatC()}',
        data: j({ totals: { positions: 3, amount: 13775 } }),
        result: 'Позиций: 3, на сумму 13 775,00 ₽',
        note: 'Число элементов массива можно взять и в шаблоне: `{d.items:len()}`.',
      },
      {
        id: 'totals-rownum',
        title: 'Номер строки из SQL',
        sql: {
          key: 'items',
          mode: 'list',
          text: L(
            'select row_number() over (order by id) as n, name, qty',
            'from invoice_items',
            'where invoice_id = :invoiceId',
            'order by id',
          ),
        },
        template: L(
          '| № | Наименование | Кол-во |',
          '| {d.items[i].n} | {d.items[i].name} | {d.items[i].qty} |',
          '| {d.items[i+1].n} | | |',
        ),
        data: j({
          items: [
            { n: 1, name: 'Бумага А4', qty: 10 },
            { n: 2, name: 'Картридж', qty: 2 },
            { n: 3, name: 'Ручки шариковые', qty: 50 },
          ],
        }),
        result: L(
          '| № | Наименование | Кол-во |',
          '| 1 | Бумага А4 | 10 |',
          '| 2 | Картридж | 2 |',
          '| 3 | Ручки шариковые | 50 |',
        ),
        note: 'Отбирайте строки в `where`, а не фильтром шаблона — тогда номера идут без пропусков.',
      },
      {
        id: 'totals-groups',
        title: 'Группы с подытогами (json_agg)',
        sql: {
          key: 'groups',
          mode: 'list',
          text: L(
            'select c.name as company,',
            '       sum(it.qty * it.price) as subtotal,',
            "       json_agg(json_build_object('name', it.name, 'qty', it.qty) order by it.id) as items",
            'from invoice_items it',
            'join invoices i on i.id = it.invoice_id',
            'join company c on c.id = i.company_id',
            'group by c.id, c.name',
            'order by c.id',
          ),
        },
        template: L(
          '{d.groups[i].company} — {d.groups[i].subtotal:formatC()}',
          '- {d.groups[i].items[i].name}: {d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].name}',
          '{d.groups[i+1].company}',
        ),
        data: j({
          groups: [
            {
              company: 'ООО «Ромашка»',
              subtotal: 13775,
              items: [
                { name: 'Бумага А4', qty: 10 },
                { name: 'Картридж', qty: 2 },
                { name: 'Ручки шариковые', qty: 50 },
              ],
            },
            {
              company: 'АО «Лютик»',
              subtotal: 34300,
              items: [
                { name: 'Стол офисный', qty: 1 },
                { name: 'Кресло', qty: 2 },
                { name: 'Лампа настольная', qty: 3 },
              ],
            },
          ],
        }),
        result: L(
          'ООО «Ромашка» — 13 775,00 ₽',
          '- Бумага А4: 10',
          '- Картридж: 2',
          '- Ручки шариковые: 50',
          'АО «Лютик» — 34 300,00 ₽',
          '- Стол офисный: 1',
          '- Кресло: 2',
          '- Лампа настольная: 3',
        ),
        note: 'Подытог группы считает `sum(…)`, состав группы собирает `json_agg`. Общий итог — отдельный запрос в режиме «Одна строка».',
      },
      {
        id: 'totals-set-group',
        title: 'Группировка в шаблоне (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}',
          '- {c.g[i].rows[i].brand} {c.g[i].rows[i].qty}',
          '- {c.g[i].rows[i+1].qty}',
          '{c.g[i+1].id}',
        ),
        data: j({ cars: CARS }),
        result: L('Лада', '- Лада 3', '- Лада 2', 'Тесла', '- Тесла 1', 'БМВ', '- БМВ 5'),
        note: 'Группы идут в порядке первого появления, тег с `:set` ничего не печатает. Сохраняйте объект целиком (`d.cars[]:set(…rows[])`), а не отдельные поля. Подытоги так не посчитать — для них группируйте в SQL.',
      },
      {
        id: 'totals-set-sum',
        title: 'Сумма через :set (неверно)',
        template: '{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}Итого: {c.total}',
        data: j({ zero: 0, cars: CARS }),
        result: 'Итого: 14',
        note: 'Правильный итог — 11: первый элемент учитывается дважды. Суммы считайте в SQL.',
      },
    ],
  },
  {
    id: 'unavailable',
    title: 'Недоступно в бесплатной версии',
    intro: [
      'Эти теги в бесплатной версии Carbone отключены. Если такой тег есть в шаблоне, отчёт и предпросмотр не формируются, а показывается ошибка из примера.',
    ],
    examples: [
      {
        id: 'na-aggregators',
        title: 'Агрегаторы',
        template: 'Итого: {d.cars[].qty:aggSum}',
        data: j({ cars: CARS }),
        result: community('aggSum'),
        unavailable: true,
        note: 'Так же отключены `aggAvg`, `aggMin`, `aggMax`, `aggCount`, `aggCountD`, `aggStr`, `aggStrD`, `cumSum`, `cumCount`, `cumCountD`. Вместо них — итоги в SQL (раздел «Итоги и группировка»); число элементов массива — `{d.cars:len()}`.',
      },
      {
        id: 'na-count',
        title: 'count()',
        template: L('{d.cars[i].brand:count()} {d.cars[i].brand}', '{d.cars[i+1].brand}'),
        data: j({ cars: CARS }),
        result: community('cumCount'),
        unavailable: true,
        note: 'Ошибка называет `cumCount`: Carbone заменяет на него `count()`. Вместо — `print(.i):add(1)` или `row_number()` в SQL.',
      },
      {
        id: 'na-drop',
        title: 'drop() и keep()',
        template: L('до', '{d.f:ifEQ(true):drop(p)}удалить абзац', 'после'),
        data: j({ f: true }),
        result: community('drop'),
        unavailable: true,
        note: '`keep()` отключён так же. Абзацы скрывайте через `hideBegin`/`hideEnd`, строки таблицы — фильтром цикла.',
      },
      {
        id: 'na-html',
        title: 'HTML',
        template: '{d.h:html}',
        data: j({ h: '<b>жирный</b> текст' }),
        result: community('html'),
        unavailable: true,
        note: 'Передавайте обычный текст; переносы строк — через `convCRLF`.',
      },
      {
        id: 'na-color',
        title: 'Цвет из данных',
        template: '{d.c:color(p)}цветной',
        data: j({ c: '#FF0000' }),
        result: community('color'),
        unavailable: true,
        note: 'Старый `bindColor` ошибки не даёт, но и цвет не меняет. Цвет задайте в самом шаблоне.',
      },
      {
        id: 'na-barcode',
        title: 'Штрихкоды и QR-коды',
        template: '{d.v:barcode(qrcode)}',
        data: j({ v: '123' }),
        result: community('barcode'),
        unavailable: true,
        note: 'Отключены все виды кодов, в том числе `ean13`. Печатайте значение текстом.',
      },
      {
        id: 'na-chart',
        title: 'Диаграммы',
        template: '{d.v:chart}',
        data: j({ v: 1 }),
        result: community('chart'),
        unavailable: true,
        note: 'Показывайте данные таблицей.',
      },
      {
        id: 'na-format-region',
        title: 'Названия регионов (formatR)',
        template: '{d.v:formatR()}',
        data: j({ v: 'RU' }),
        result: community('formatR'),
        unavailable: true,
        note: 'Название берите из справочника в SQL.',
      },
      {
        id: 'na-default-url',
        title: 'Ссылка по умолчанию (defaultURL)',
        template: "{d.u:defaultURL('https://example.com')}",
        data: j({ u: 'not a url' }),
        result: community('defaultURL'),
        unavailable: true,
        note: 'Запасную ссылку подставляйте в SQL (`coalesce`). Адрес гиперссылки из данных работает: укажите тег `{d.url}` адресом ссылки в Word.',
      },
    ],
    limits: [
      {
        id: 'na-images',
        title: 'Изображения из данных',
        instead:
          'Тег в замещающем тексте картинки не работает: остаётся картинка-заглушка, ошибки нет. Вставляйте изображения в шаблон заранее.',
      },
      {
        id: 'na-autoorient',
        title: 'autoOrient',
        instead: 'Отключён, шаблон с ним не формируется. Поворачивайте изображение в самом шаблоне.',
      },
      {
        id: 'na-sort-desc',
        title: 'Сортировка по убыванию',
        instead: '`[-qty, i]` молча оставляет исходный порядок. Сортируйте в SQL: `order by qty desc`.',
      },
      {
        id: 'na-txt',
        title: 'Вывод в TXT',
        instead:
          'Кириллица превращается в «??????». В нашей системе формата TXT нет — используйте PDF или DOCX.',
      },
    ],
  },
];
```
Итого 44 примера (6 + 7 + 12 + 5 + 5 + 9) и 4 пункта без примера. Точные выводы, взятые из матрицы с `lang: 'ru'`, — `fmt-number`, `fmt-money`, `fmt-convcurr`; даты одинаковы для `ru` и `ru-ru` (матрица, находка 2). Выводы `basics-field`, `basics-params`, `tables-empty`, `cond-and`, `cond-inline`, `cond-paragraphs`, `totals-sum`, `totals-groups` и разбор `<w:br/>` в `fmt-multiline` — сочетания ✅-строк матрицы в другом тексте; их сверяет живой `pnpm help:check` в Task 3.

- [ ] **Step 4: Страница**

`apps/web/src/pages/admin/help/HelpPage.tsx`:

```tsx
import { Copy } from '@gravity-ui/icons';
import { Alert, Button, Icon, Link, Text } from '@gravity-ui/uikit';
import { Fragment, type ReactNode } from 'react';
import { PageHeader } from '../../../components/PageHeader';
import { useCopy } from '../../../components/useCopy';
import { HELP_INTRO, HELP_SECTIONS, type HelpExample, type HelpSection } from './content';

const MODE_LABEL = { list: 'Список строк', single: 'Одна строка' } as const;

/** Текст, где `код` в обратных кавычках показывается моноширинным. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="cr-help-inline">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Block({ label, action, text }: { label: string; action?: ReactNode; text: string }) {
  return (
    <div>
      <div className="cr-help-label">
        <Text variant="caption-2" color="secondary">
          {label}
        </Text>
        {action}
      </div>
      <pre className="cr-help-code">{text}</pre>
    </div>
  );
}

function ExampleCard({ example }: { example: HelpExample }) {
  const copy = useCopy();
  return (
    <article id={example.id} className="cr-help-card" aria-label={example.title}>
      <Text variant="subheader-2" as="h3">
        {example.title}
      </Text>
      {example.sql && (
        <Block
          label={`SQL-запрос «${example.sql.key}» (${MODE_LABEL[example.sql.mode]})`}
          text={example.sql.text}
        />
      )}
      <Block
        label="Тег в шаблоне"
        text={example.template}
        action={
          <Button
            view="flat"
            size="xs"
            aria-label={`Копировать тег: ${example.title}`}
            onClick={() => void copy(example.template, example.title)}
          >
            <Icon data={Copy} size={12} />
            Копировать
          </Button>
        }
      />
      <Block label="Данные" text={example.data} />
      <Block label="Результат" text={example.result} />
      {example.note && (
        <Alert
          theme={example.unavailable ? 'info' : 'warning'}
          title="Внимание"
          message={<Rich text={example.note} />}
        />
      )}
    </article>
  );
}

function Section({ section }: { section: HelpSection }) {
  return (
    <section id={section.id} className="cr-help-section" aria-label={section.title}>
      <Text variant="header-2" as="h2">
        {section.title}
      </Text>
      {section.intro.map((p, i) => (
        <Text key={i} as="p">
          <Rich text={p} />
        </Text>
      ))}
      {section.examples.map((e) => (
        <ExampleCard key={e.id} example={e} />
      ))}
      {section.limits && (
        <ul className="cr-help-limits">
          {section.limits.map((l) => (
            <li key={l.id} id={l.id}>
              <Text variant="subheader-1">{l.title}</Text> — <Rich text={l.instead} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HelpPage() {
  return (
    <>
      <PageHeader title="Справка по шаблонам" />
      <div className="cr-help">
        <nav className="cr-help-toc" aria-label="Оглавление">
          {HELP_SECTIONS.map((s) => (
            <Link key={s.id} href={`#${s.id}`}>
              {s.title}
            </Link>
          ))}
        </nav>
        <div className="cr-help-content">
          {HELP_INTRO.map((p, i) => (
            <Text key={i} as="p">
              <Rich text={p} />
            </Text>
          ))}
          {HELP_SECTIONS.map((s) => (
            <Section key={s.id} section={s} />
          ))}
        </div>
      </div>
    </>
  );
}
```
Оглавление — обычные `<a href="#id">`: переход по якорю делает браузер, react-router их не перехватывает.

`apps/web/src/app/global.css` — в конец файла (после строки 112):

```css

.cr-help {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 32px;
  align-items: start;
}

.cr-help-toc {
  position: sticky;
  top: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cr-help-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 960px;
}

.cr-help-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
  scroll-margin-top: 24px;
}

.cr-help-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--g-color-line-generic);
  border-radius: 8px;
}

.cr-help-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cr-help-code {
  margin: 4px 0 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--g-color-base-generic);
  font-family: var(--g-font-family-monospace);
  font-size: 13px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cr-help-inline {
  font-family: var(--g-font-family-monospace);
  font-size: 0.92em;
}

.cr-help-limits {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding-left: 20px;
}
```

- [ ] **Step 5: Маршрут, меню, ссылка в редакторе**

`apps/web/src/app/routes.tsx` — после строки 46 (`{ path: 'categories', … }`):

```tsx
              {
                path: 'help',
                // Справка — отдельный чанк: в основном бандле она не нужна.
                lazy: async () => ({
                  Component: (await import('../pages/admin/help/HelpPage')).HelpPage,
                }),
              },
```
Маршрут лежит внутри `admin` → `RequireAdmin`, отдельной проверки не нужно.

`apps/web/src/app/Layout.tsx`: в импорт иконок (перед строкой 4 `ClockArrowRotateLeft,`) добавить `CircleQuestion,`; после строки 72 (`item('categories', …)`):

```tsx
      item('help', 'Справка по шаблонам', CircleQuestion, '/admin/help'),
```

`apps/web/src/pages/admin/template-editor/DocumentTab.tsx`: строка 2 → `import { Alert, Button, Icon, Link, Loader, Text, useToaster } from '@gravity-ui/uikit';`. После кнопки «Теги» (строка 198 `</Button>`) вставить:

```tsx
        {/* Новая вкладка: документ OnlyOffice в этой вкладке остаётся открытым (§23.1). */}
        <Link href="/admin/help" target="_blank" rel="noopener">
          Справка по синтаксису
        </Link>
```
Ссылка стоит в панели инструментов рядом с кнопкой «Теги» и видна, даже когда панель тегов скрыта.

- [ ] **Step 6: Запуск — должно пройти; гейты; коммит**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write apps/web/src/pages/admin/help apps/web/src/components/useCopy.ts && pnpm --filter @carbone-reports/web typecheck && pnpm --filter @carbone-reports/web test
```
Ожидание: `content.test.ts` (5), `HelpPage.test.tsx` (5), новые тесты `DocumentTab.test.tsx` и `auth.test.tsx` и все прежние тесты (включая `TagsPanel.test.tsx`) зелёные.

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/web/src/components/useCopy.ts apps/web/src/pages/admin/template-editor/TagsPanel.tsx apps/web/src/pages/admin/help apps/web/src/app/routes.tsx apps/web/src/app/Layout.tsx apps/web/src/pages/admin/template-editor/DocumentTab.tsx apps/web/src/pages/admin/template-editor/DocumentTab.test.tsx apps/web/src/app/auth.test.tsx apps/web/src/app/global.css
git commit -m "feat(web): template syntax help page for admins

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: `pnpm help:check`, E2E, живой прогон, документация (§23.3, §23.5)

**Files:**
- Modify: `package.json:21` (скрипт `help:check` после `stack:smoke`)
- Create: `scripts/help-check.ts`
- Create: `e2e/tests/help.spec.ts`
- Modify: `README.md:250` (новый раздел «Справка по шаблонам» перед «Безопасность источников данных»)
- Modify: `docs/superpowers/notes/2026-10-02-backend-follow-ups.md` (раздел «Итоги Плана 12» в конце файла)

**Interfaces:**
- Consumes: `HELP_SECTIONS`, `HelpExample` (Task 2); `communityErrorMessage` (Task 1); `CARBONE_LANG` (Task 1); `jszip` и `tsx` из корневых `devDependencies`; сервис `api` в `docker-compose.yml` с `CARBONE_URL: http://carbone:4000` и `TZ: ${TZ:-Europe/Moscow}` (строки 43, 47); в образе `api` есть `node` 22 с глобальными `fetch`, `FormData`, `Blob` (так работали пробы матрицы); фикстуры E2E `adminApi`, `demoTemplateId`, `loginAdminUi`, `waitForStack` (`e2e/fixtures.ts`).
- Produces: `pnpm help:check` — код 0 и «Carbone: примеров 44, расхождений 0», иначе код 1 и список расхождений; `pnpm help:check -- --self-test` — то же без Docker (сборка DOCX ↔ разбор текста).

- [ ] **Step 1: Скрипт в `package.json` и падающая самопроверка**

`package.json`, после строки 21 (`"stack:smoke": …`):

```json
    "help:check": "tsx scripts/help-check.ts",
```

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm help:check -- --self-test
```
Ожидание: ошибка `Cannot find module …/scripts/help-check.ts`, код выхода не 0.

- [ ] **Step 2: `scripts/help-check.ts`**

```ts
// Сверка примеров «Справки по шаблонам» с Carbone поднятого стека (§23.3).
// Запуск: pnpm help:check               — рендер каждого примера через контейнер api (docker compose exec);
//         pnpm help:check -- --self-test — без Docker: сборка DOCX и разбор текста обратимы.
// Carbone наружу не открыт, поэтому раннер выполняется внутри api, как и пробы матрицы Community.
import { execFileSync } from 'node:child_process';
import { CARBONE_LANG } from '@carbone-reports/shared';
import JSZip from 'jszip';
import { communityErrorMessage } from '../apps/api/src/modules/carbone/community';
import { HELP_SECTIONS, type HelpExample } from '../apps/web/src/pages/admin/help/content';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

// ---- шаблон → DOCX (весь текст абзаца — один run, как в пробах матрицы) ----

const para = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const isRow = (line: string) => line.startsWith('|');
const cellsOf = (line: string) =>
  line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
/** Строка таблицы в нотации справки: «| a | b |», пустая ячейка — «| |». */
const rowLine = (cells: string[]) => `| ${cells.join(' | ')} |`.replace(/\| {2}(?=\|)/g, '| ');

function table(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const cell = (c: string) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(c)}</w:tc>`;
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
    `<w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(cols)}</w:tblGrid>` +
    rows.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('') +
    '</w:tbl>'
  );
}

function templateBody(template: string): string {
  const out: string[] = [];
  let rows: string[][] = [];
  const flush = () => {
    if (rows.length > 0) out.push(table(rows));
    rows = [];
  };
  for (const line of template.split('\n')) {
    if (isRow(line)) rows.push(cellsOf(line));
    else {
      flush();
      out.push(para(line));
    }
  }
  flush();
  return out.join('');
}

export async function buildDocx(template: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file('word/_rels/document.xml.rels', `${XML}<Relationships xmlns="${RELS}"></Relationships>`);
  zip.file(
    'word/document.xml',
    `${XML}<w:document xmlns:w="${W}"><w:body>${templateBody(template)}<w:p/><w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---- DOCX → текст в нотации справки ----

const TEXT_RE = /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>/g;
const BLOCK_RE =
  /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const PARA_RE = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const ROW_RE = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
const CELL_RE = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;

function paraText(p: string): string {
  let s = '';
  for (const m of p.matchAll(TEXT_RE)) {
    if (m[0].startsWith('<w:br')) s += '\n';
    else if (m[1] !== undefined) s += unesc(m[1]);
  }
  return s;
}

export function docxText(documentXml: string): string {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? '';
  const lines: string[] = [];
  for (const [block] of body.matchAll(BLOCK_RE)) {
    if (block.startsWith('<w:tbl>')) {
      for (const [row] of block.matchAll(ROW_RE)) {
        const cells = [...row.matchAll(CELL_RE)].map(([c]) =>
          [...c.matchAll(PARA_RE)].map(([p]) => paraText(p)).join(' / '),
        );
        lines.push(rowLine(cells));
      }
    } else {
      const text = paraText(block);
      if (text !== '') lines.push(text);
    }
  }
  return lines.join('\n');
}

async function documentXml(docx: Buffer): Promise<string> {
  const file = (await JSZip.loadAsync(docx)).file('word/document.xml');
  if (!file) throw new Error('в DOCX нет word/document.xml');
  return file.async('string');
}

// ---- проверки ----

function mismatch(e: HelpExample, want: string, got: string): void {
  console.log(`✗ ${e.id} «${e.title}»`);
  console.log(`  ожидалось: ${JSON.stringify(want)}`);
  console.log(`  получено:  ${JSON.stringify(got)}`);
}

/** Без Docker: шаблон, собранный в DOCX, читается обратно в тот же текст (без пустых строк). */
async function selfTest(examples: HelpExample[]): Promise<number> {
  let bad = 0;
  for (const e of examples) {
    const got = docxText(await documentXml(await buildDocx(e.template)));
    const want = e.template
      .split('\n')
      .filter((l) => l !== '')
      .join('\n');
    if (got === want) console.log(`✓ ${e.id}`);
    else {
      bad++;
      mismatch(e, want, got);
    }
  }
  return bad;
}

/** Выполняется внутри контейнера api: как CarboneClient (carbone-version 5, download=true). */
const RUNNER = String.raw`
const base = process.env.CARBONE_URL.replace(/\/$/, '');
const H = { 'carbone-version': '5' };
let buf = '';
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', async () => {
  const { lang, convertTo, cases } = JSON.parse(buf);
  const out = [];
  for (const c of cases) {
    const r = { id: c.id };
    try {
      const form = new FormData();
      form.append('template', new Blob([Buffer.from(c.tpl, 'base64')]), 'template.docx');
      const up = await fetch(base + '/template', { method: 'POST', headers: H, body: form });
      const ub = await up.json().catch(() => null);
      const id = ub && ub.data && ub.data.templateId;
      if (!id) {
        r.error = 'загрузка шаблона: HTTP ' + up.status + ' ' + ((ub && ub.error) || '');
        out.push(r);
        continue;
      }
      const res = await fetch(base + '/render/' + encodeURIComponent(id) + '?download=true', {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({
          data: c.data,
          convertTo,
          lang,
          timezone: process.env.TZ || 'Europe/Moscow',
        }),
      });
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      if (res.ok && !isJson) r.out = Buffer.from(await res.arrayBuffer()).toString('base64');
      else {
        const b = isJson ? await res.json().catch(() => null) : null;
        r.error = (b && b.error) || 'HTTP ' + res.status;
      }
    } catch (e) {
      r.error = 'исключение: ' + e.message;
    }
    out.push(r);
  }
  process.stdout.write(JSON.stringify(out));
});
`;

interface RunnerResult {
  id: string;
  out?: string;
  error?: string;
}

async function liveCheck(examples: HelpExample[]): Promise<number> {
  const cases = await Promise.all(
    examples.map(async (e) => ({
      id: e.id,
      tpl: (await buildDocx(e.template)).toString('base64'),
      data: JSON.parse(e.data) as unknown,
    })),
  );
  const raw = execFileSync('docker', ['compose', 'exec', '-T', 'api', 'node', '-e', RUNNER], {
    input: JSON.stringify({ lang: CARBONE_LANG, convertTo: 'docx', cases }),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const results = JSON.parse(raw.toString('utf8')) as RunnerResult[];
  let bad = 0;
  for (const e of examples) {
    const r = results.find((x) => x.id === e.id);
    let got: string;
    if (!r) got = '(нет ответа раннера)';
    else if (e.unavailable) {
      got = r.error
        ? (communityErrorMessage(r.error) ?? `другая ошибка: ${r.error}`)
        : 'отчёт сформирован, а ожидалась ошибка «disabled in the Community Edition»';
    } else if (r.error || !r.out) got = `ошибка: ${r.error ?? 'пустой ответ'}`;
    else got = docxText(await documentXml(Buffer.from(r.out, 'base64')));
    if (got === e.result) console.log(`✓ ${e.id}`);
    else {
      bad++;
      mismatch(e, e.result, got);
    }
  }
  return bad;
}

async function main(): Promise<void> {
  const examples = HELP_SECTIONS.flatMap((s) => s.examples);
  const self = process.argv.includes('--self-test');
  const bad = self ? await selfTest(examples) : await liveCheck(examples);
  console.log(
    `${self ? 'самопроверка' : 'Carbone'}: примеров ${examples.length}, расхождений ${bad}`,
  );
  if (bad > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
```
`scripts/tsconfig.json` не меняется: `tsc` проверяет импортированные `content.ts` и `community.ts` вместе со скриптом.

- [ ] **Step 3: Самопроверка и типы — должно пройти**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write scripts/help-check.ts && pnpm help:check -- --self-test && pnpm typecheck:scripts && pnpm lint
```
Ожидание: 44 строки `✓`, «самопроверка: примеров 44, расхождений 0», код 0; `tsc` и `eslint` без ошибок.

Проверка, что самопроверка ловит ошибку: временно поменять в `content.ts` у `tables-rows` строку `'| {d.cars[i+1].brand} | |'` на `'| {d.cars[i+1].brand} ||'`, запустить `pnpm help:check -- --self-test` — ожидание `✗ tables-rows` и код 1 (и красный `content.test.ts`). Вернуть строку.

- [ ] **Step 4: E2E — справка из редактора**

`e2e/tests/help.spec.ts`:

```ts
import { adminApi, demoTemplateId, expect, loginAdminUi, test, waitForStack } from '../fixtures';

const SECTIONS = [
  'Основы',
  'Таблицы',
  'Форматирование',
  'Условия',
  'Итоги и группировка',
  'Недоступно в бесплатной версии',
];

test.beforeAll(waitForStack);

test('админ открывает справку по ссылке из редактора в новой вкладке', async ({ page }) => {
  const id = await demoTemplateId(await adminApi());
  await loginAdminUi(page);
  await page.goto(`/admin/templates/${id}?tab=document`);

  const link = page.getByRole('link', { name: 'Справка по синтаксису' });
  await expect(link).toHaveAttribute('href', '/admin/help');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');

  // rel="noopener": у новой вкладки нет opener, поэтому ждём новую страницу контекста.
  const [help] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  await help.waitForLoadState();
  await expect(help).toHaveURL(/\/admin\/help$/);
  await expect(help.getByRole('heading', { level: 1, name: 'Справка по шаблонам' })).toBeVisible();

  const toc = help.getByRole('navigation', { name: 'Оглавление' });
  for (const name of SECTIONS) {
    await expect(toc.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(help.getByRole('region', { name, exact: true })).toBeAttached();
  }
  await toc.getByRole('link', { name: 'Итоги и группировка', exact: true }).click();
  await expect(help).toHaveURL(/\/admin\/help#totals$/);
  await expect(
    help.getByRole('region', { name: 'Итоги и группировка', exact: true }).getByRole('heading', {
      level: 2,
    }),
  ).toBeInViewport();

  // Вкладка редактора осталась на месте — документ OnlyOffice не закрыт.
  await expect(page).toHaveURL(new RegExp(`/admin/templates/${id}\\?tab=document$`));
  await help.close();
});
```
Фикстура CSP следит только за исходной вкладкой `page`; справка — та же сборка и те же заголовки nginx, что у остальных страниц.

- [ ] **Step 5: Живой прогон на пересобранном стеке**

Нужны новые образы: `api` (`lang: 'ru'`, `CARBONE_COMMUNITY`) и `web` (справка, ссылка, меню).

```bash
cd /Users/sam/carbone-reports
df -h /System/Volumes/Data | tail -1        # меньше 2 GiB свободно → BLOCKED, не собирать
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm stack:demo   # --build --wait + demo:seed
docker compose ps api web                   # api healthy, web running
BASE_URL=https://localhost:${WEB_HTTPS_PORT:-443} pnpm stack:smoke -- --insecure
pnpm help:check                             # 44 × ✓, «Carbone: примеров 44, расхождений 0», код 0
pnpm e2e && pnpm e2e                         # дважды подряд, все зелёные (включая help.spec.ts)
docker image ls --filter dangling=true --filter label=com.docker.compose.project=carbone-reports -q | xargs -r docker image rm
df -h /System/Volumes/Data | tail -1
```
Стек оставить запущенным, `down` не делать. Чужие висячие образы и кэш сборки не трогать.

Если `pnpm help:check` показывает расхождение:
- не подгонять `result` под вывод вслепую;
- если вывод согласуется с матрицей и отличается только записью (например, иной пробел), исправить `result` и указать пример в итогах;
- если вывод показывает, что приём не работает, убрать пример из справки (или перенести в раздел 6 с заменой) и указать это в итогах;
- после правки — снова `pnpm --filter @carbone-reports/web test`, `pnpm help:check -- --self-test` и `pnpm help:check`; отчёт — DONE_WITH_CONCERNS со списком изменённых примеров.

Если `api` не стал healthy, смотреть `docker compose logs api` (без вывода `.env`). Падения E2E разбирать по `e2e/report`; таймауты не поднимать.

- [ ] **Step 6: README и заметки**

`README.md` — перед строкой 250 (`## Безопасность источников данных`):

```markdown
## Справка по шаблонам

Раздел администрирования «Справка по шаблонам» (`/admin/help`) — примеры тегов Carbone, проверенные на нашей бесплатной версии (Community Edition): основы, таблицы, форматирование, условия, итоги и группировка через SQL. Последний раздел — что в бесплатной версии недоступно и чем это заменить. В редакторе шаблона ссылка «Справка по синтаксису» открывает справку в новой вкладке, документ в OnlyOffice остаётся открытым.

- API передаёт Carbone `lang: 'ru'`: `formatN(2)` даёт `1 234 567,89`, `formatC()` — `1 234 567,89 ₽`.
- Если в шаблоне есть форматтер, отключённый в бесплатной версии (например, `aggSum`), формирование и предпросмотр отвечают `400` с кодом `CARBONE_COMMUNITY`: «в шаблоне используется aggSum — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»». Запуск попадает в историю с этим текстом.
- `pnpm help:check` рендерит каждый пример справки через Carbone поднятого стека (`docker compose exec` в контейнер `api`, те же `lang` и `TZ`, что у API) и сравнивает текст результата с ожидаемым; при расхождении — код выхода 1. `pnpm help:check -- --self-test` проверяет только сборку DOCX, без Docker. В CI проверка не запускается.

```

`docs/superpowers/notes/2026-10-02-backend-follow-ups.md` — в конец файла. В угловых скобках — числа из Step 5:

```markdown

## Итоги Плана 12 (справка по шаблонам)

- **Справка:** `/admin/help` «Справка по шаблонам» (только админы, пункт меню администрирования), ссылка «Справка по синтаксису» во вкладке «Документ» (`target="_blank"`, `rel="noopener"`). Содержание — `apps/web/src/pages/admin/help/content.ts`: 6 разделов, 44 примера, 4 пункта без примера в разделе «Недоступно в бесплатной версии». Источник фактов — матрица `2026-10-13-carbone-community-matrix.md`.
- **API:** `lang: 'ru'` (`CARBONE_LANG` в `packages/shared`) вместо `ru-ru` — числа и рубли форматируются по-русски, даты не изменились; ключа переводов `ru-ru` в коде не было. Ошибка Carbone «Formatter "X" is disabled in the Community Edition» → `400 CARBONE_COMMUNITY` «в шаблоне используется X — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»» (имя не разобрать — «форматтер»); остальные ошибки — прежние `502 CARBONE_ERROR`.
- **Проверка справки:** `pnpm help:check` — раннер внутри контейнера `api` (`docker compose exec`), тот же `lang`, `TZ` контейнера; раздел 6 сверяется через `communityErrorMessage`. Самопроверка без Docker — `--self-test`. В CI не запускается.
- **Живой прогон:** стек пересобран (`pnpm stack:demo`), `stack:smoke --insecure` пройден, `pnpm help:check` — 44 примера, 0 расхождений <или: какие примеры изменены и почему>; E2E <N>/<N> дважды подряд (включая `help.spec.ts`), нарушений CSP 0; висячие образы проекта удалены, свободно на диске <X> GiB; стек оставлен запущенным.
```

- [ ] **Step 7: Гейты и коммит**

```bash
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add package.json scripts/help-check.ts e2e/tests/help.spec.ts README.md docs/superpowers/notes/2026-10-02-backend-follow-ups.md
git commit -m "feat(scripts): help:check verifies template help against live Carbone; Plan 12 notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Если в Step 5 менялся `content.ts`, добавить в этот коммит и его, и `content.test.ts` (если менялся список пунктов).
