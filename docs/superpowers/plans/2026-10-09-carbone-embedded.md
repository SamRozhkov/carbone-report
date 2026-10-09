# Своя сборка Carbone внутри API (План 17, версия 2.0.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Отказаться от образа `carbone/carbone-ee` и LibreOffice: отчёты собирает своя сборка Carbone 3.8.2 (пакет `packages/carbone`) в пуле `worker_threads` внутри API, а перевод в PDF/ODT/ODS/DOCX делает OnlyOffice Document Server.

**Architecture:** Код форка `SamRozhkov/carbone` переносится в монорепо через `git subtree`, из него удаляется LibreOffice, добавляется `renderBuffer(buf, ext, data, {lang, timezone})` и переносится синтаксис бесплатного режима Carbone EE 5.15.3; совпадение с EE проверяется эталонами (`packages/carbone/test/golden`). В API новая реализация того же интерфейса `CarboneRenderer`: пул потоков → если формат вывода совпадает с шаблоном, результат сразу; иначе файл кладётся в память реплики, Document Server забирает его по разовой ссылке на `API_SELF_URL` и конвертирует через `POST /converter`. Контейнер `carbone` уходит из compose и чарта.

**Tech Stack:** Carbone Community 3.8.2 (CommonJS, dayjs, yauzl, yazl, mocha), Node 22 `worker_threads`, Fastify 5, jose (JWT), OnlyOffice Document Server 9.4 Conversion API, vitest + testcontainers, tsup, Helm 4 (helm-unittest как плагин), kind.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §28 (План 17). Исследование: `docs/superpowers/notes/2026-10-09-carbone-ce-vs-ee.md`. Материалы исследования для исполнителей: `docs/superpowers/plans/2026-10-09-carbone-embedded/` (черновые эталоны `golden-draft/`, прототип `proto.js`, харнесс `harness.js`, экспорт проб `probes-export.json`, примеры справки `help-examples.json`, исходный Python-харнесс матрицы `probe-harness/`).

## Global Constraints

- Ветка `feat/carbone-embedded`. Никаких слияний в `main`, тегов `v2.0.0`, публикаций образов и чартов: это решает владелец проекта. Отправка ветки в GitHub для CI — только с согласия пользователя (спрашивает контроллер).
- Node 22: `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH` перед `pnpm`/`node` (в shell по умолчанию Node 16).
- Тексты для пользователя, сообщения об ошибках и комментарии — на русском, в стиле окружающего кода. В вендорном коде `packages/carbone` комментарии к нашим правкам — на русском, существующий код апстрима не переписывается без нужды.
- Секреты не печатаются никогда: ни в тестах, ни в журналах, ни в сообщениях об ошибках. `.env` и `certs/` не коммитятся.
- Каждый коммит заканчивается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Перед коммитом: `pnpm exec prettier --check .`, `pnpm lint`, `pnpm typecheck` — зелёные; тесты затронутых пакетов — зелёные.
- Правило чистой реализации: новые возможности Carbone пишутся по открытой документации carbone.io и по эталонам (записанное поведение EE). Код из образа `carbone-ee` не читается, не извлекается и не копируется.
- Пакет `@carbone-reports/carbone`: `"private": true`, `"type": "commonjs"`, лицензия CCL (`LICENSE.md` сохраняется), отдельно не публикуется.
- Текст ошибки отключённой функции — ровно `Formatter "X" is disabled in the Community Edition.` (с точкой); для `count()` имя `cumCount`. Отключены: `aggSum, aggAvg, aggMin, aggMax, aggCount, aggCountD, aggStr, aggStrD, cumSum, cumCount, cumCountD, drop, keep, html, color, barcode, chart, formatR, defaultURL, autoOrient`. `imageFit` в список не входит (в EE его нет вовсе).
- Даты: строка без смещения разбирается как UTC, вывод — в `options.timezone`; от часового пояса процесса ничего не зависит.
- Коды ошибок API: ошибка шаблона — 502 `CARBONE_ERROR` `ошибка генерации: <текст>`; отключённая функция — 400 `CARBONE_COMMUNITY` (`community.ts`); срок — 504 `TIMEOUT` `превышено время ожидания`; упавший поток — 502 `CARBONE_ERROR` `сервис генерации недоступен`; OnlyOffice недоступен — 502 `CONVERT_ERROR` `сервис конвертации недоступен`; OnlyOffice вернул `error: -N` — 502 `CONVERT_ERROR` `ошибка конвертации (код N)`. Ошибка чтения файла шаблона пробрасывается как есть (не оборачивается).
- Настройки API: `RENDER_WORKERS` — целое 1–16, по умолчанию `min(4, os.availableParallelism())`; `API_SELF_URL` — URL, по умолчанию `http://api:3000`; `CARBONE_URL` удаляется.
- Разовая ссылка на файл: `GET /internal/render-files/:id?t=<JWT>`, JWT HS256 на `APP_SECRET`, `aud: 'render-file'`, `sub: <id>`, срок не больше остатка срока рендера; файл отдаётся один раз и удаляется.
- Конвертация: `POST {ONLYOFFICE_INTERNAL_URL}/converter`, заголовок `accept: application/json`, тело `{ async: false, filetype, outputtype, key, title, url, region: 'ru-RU', token }`, `token` — JWT всего тела (без `token`) на `ONLYOFFICE_JWT_SECRET`; `key` — новый `randomUUID()` без дефисов на каждый вызов; `fileUrl` ответа → `toInternalDownloadUrl(fileUrl, onlyofficeInternalUrl)`.
- Образы: `onlyoffice/documentserver:9.4.0.1`; инструменты чарта — как в Плане 16 (`alpine/helm:4.3.0`, helm-unittest как плагин 1.2.1, `ghcr.io/yannh/kubeconform:v0.8.0`).
- Диск хоста тесный: перед сборкой образов и запуском контейнеров — `df -h /`; при свободном месте меньше 2 ГиБ — остановиться и сообщить BLOCKED. Образ OnlyOffice (3,4 ГБ) локально не тянуть: интеграционный тест с ним идёт только при `TEST_ONLYOFFICE=1` (в CI всегда). Ничего чужого в Docker не удалять.
- Интеграционные тесты под нагрузкой хоста бывают медленными; падение по таймауту перепроверить повторным запуском, прежде чем считать его дефектом.

## Review Focus

1. Две реплики API, PDF-отчёты подряд — Document Server всегда забирает файл у той реплики, что его собрала (адрес пода в `API_SELF_URL`), ни одного `-4`. Тест: Task 13 (kind-смоук строит несколько PDF при двух репликах).
2. Шаблон, который зацикливает или надолго занимает поток (огромные данные), — по сроку рендера 504, поток пересоздаётся, следующий отчёт строится. Тест: Task 9 (таймаут останавливает поток; следующая задача выполняется).
3. Отчётов больше, чем потоков, — лишние ждут в очереди, а не падают; если срок истёк в очереди — 504 без запуска. Тест: Task 9.
4. Повторное скачивание разовой ссылки (повтор Document Server, перехваченная ссылка) — 404, файл уже удалён; чужой или просроченный токен — 403. Тест: Task 10.
5. Шаблон с отключённой функцией внутри цикла или в колонтитуле — 400 `CARBONE_COMMUNITY` с именем функции, а не 502. Тест: Task 4 (эталон в колонтитуле) и Task 11 (маршрут API).

---

## Файлы

**`packages/carbone`** (вендорный Carbone, CommonJS)
- `lib/index.js` — `renderBuffer`; удалены `convert`, `set`-побочные эффекты, `render`/`renderXML` остаются для тестов апстрима.
- `lib/file.js` — `openTemplateBuffer`, защита от двойного callback в `unzip`.
- `lib/builder.js`, `lib/parser.js`, `lib/extracter.js`, `lib/input.js` — перенос синтаксиса (Tasks 4–7).
- `lib/set.js` (новый) — предварительный проход `:set`.
- `lib/community.js` (новый) — список отключённых функций.
- `formatters/*.js` — новые и исправленные форматтеры.
- `index.d.ts`, `NOTICE.md`, `package.json`.
- `test/golden/help.json`, `test/golden/matrix.json`, `test/golden/known-gaps.json`, `test/golden-lib.js`, `test/test.golden.js`.

**`apps/api/src/modules/render/`**
- `pool.ts` (+ `pool.test.ts`, фикстуры `test-workers/*.mjs`) — пул потоков.
- `worker.ts` — поток: `renderBuffer`.
- `handoff.ts` (+ тест) — файлы в памяти и разовые токены.
- `routes.ts` — `GET /internal/render-files/:id`.
- `onlyoffice-convert.ts` (+ тест) — клиент Conversion API.
- `renderer.ts` (+ тест) — реализация `CarboneRenderer`.
- `apps/api/test/render-onlyoffice.int.test.ts` — с настоящим Document Server.

**Удаляются:** `apps/api/src/modules/carbone/client.ts`, `template-cache.ts` и их тесты; компонент `carbone` в compose и чарте.

---
### Task 1: Пакет `packages/carbone` — перенос форка и очистка

**Files:**
- Create (subtree): `packages/carbone/**` из `SamRozhkov/carbone@master` (`1df45b5`, Carbone 3.8.2)
- Delete: `packages/carbone/{package-lock.json,makefile,.github,bin,examples,doc,SECURITY.md}`, `lib/tool.js`, `lib/converter.js`, `lib/converter.py`, `lib/format.js`, `test/test.converter.js`
- Modify: `packages/carbone/package.json`, `packages/carbone/lib/index.js`, `packages/carbone/lib/input.js`, `packages/carbone/lib/params.js`, `packages/carbone/test/test.carbone.js`
- Create: `packages/carbone/NOTICE.md`
- Modify: `eslint.config.js` (ignores), `.prettierignore`, `.github/dependabot.yml` (если есть секция npm — ignore для `packages/carbone`, см. шаг 7), `pnpm-lock.yaml` (через `pnpm install`)

**Interfaces:**
- Produces: workspace-пакет `@carbone-reports/carbone` (CommonJS, `main: ./lib/index.js`), команда `pnpm --filter @carbone-reports/carbone test` (mocha) зелёная без LibreOffice. API карбона `render`/`renderXML` остаются (их используют тесты апстрима), `convert`, `listConversionFormats`, `set`-опции LibreOffice удалены.

- [ ] **Step 1: Импорт через git subtree (рабочее дерево должно быть чистым)**

```bash
cd /Users/sam/carbone-reports
git status --porcelain   # должно быть пусто
git remote add carbone-fork https://github.com/SamRozhkov/carbone.git 2>/dev/null || true
git fetch carbone-fork master
git subtree add --prefix=packages/carbone carbone-fork master -m "chore(carbone): import Carbone Community 3.8.2 (SamRozhkov/carbone@1df45b5) via git subtree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # merge-коммит subtree
```

Без `--squash`: история апстрима входит в репозиторий (так требует спецификация). Все дальнейшие правки — отдельными коммитами после этого, чтобы `git subtree pull` оставался возможным.

- [ ] **Step 2: Удалить лишнее**

```bash
cd /Users/sam/carbone-reports/packages/carbone
git rm -rq package-lock.json makefile .github bin examples doc SECURITY.md lib/tool.js lib/converter.js lib/converter.py lib/format.js test/test.converter.js
```

- [ ] **Step 3: Убрать ссылки на LibreOffice из `lib/index.js`, `lib/input.js`, `lib/params.js`**

Ссылки (по исследованию, номера строк 3.8.2):
- `lib/index.js:12` — `require('./converter')`; `60-62` — `set` → `converter.init`; `380-443` — приватный `convert` и вызов из `render` (224); `136-148` — `listConversionFormats`; `decodeRenderedFilename`, `getFileExtension`, публичный `convert`; `100-128` — `addTemplate`/`removeTemplate`; `43-59` — `mkdirSync` в `set`; `615-617` — `mkdirSync(renderPath)` при загрузке модуля; `452` — `translator.loadTranslations(process.cwd())` при загрузке модуля (переводы передаются через `options.translations`).
- `lib/input.js:2` — `require('./format')`; `parseConvertTo` (81-125) и `checkAndSetOptionsFor*`, `checkDocTypeAndOutputExtensions` (199-207).
- `lib/params.js:12-32` — `pythonPath`, `renderPath`, `factories`, `attempts`, `startFactory`, `factoryMemory*`, `converterFactoryTimeout`, `pipeNamePrefix`; `reset()` в index.js:75-91 их перечисляет.

`render(templatePath, data, options, cb)` после правки: `parseOptions` → `openTemplate` → `detectType` → `preprocessor.execute` → `walkFiles` → `file.buildFile` → `callback(null, result)`. Опция `convertTo`, если передана и отличается от расширения шаблона, даёт ошибку `Conversion is not supported in this build. Use the same format as the template.` (в API конвертация делается через OnlyOffice; тесты апстрима на конвертацию удаляются в шаге 5).

- [ ] **Step 4: `package.json` пакета**

Заменить поля (остальное — как в апстриме, зависимости `dayjs`, `debug`, `yauzl`, `yazl` и devDependency `mocha` остаются; `which` удаляется):

```json
{
  "name": "@carbone-reports/carbone",
  "version": "3.8.2-cr.1",
  "private": true,
  "type": "commonjs",
  "description": "Carbone Community 3.8.2, встроенная сборка carbone-reports (см. NOTICE.md)",
  "license": "SEE LICENSE IN LICENSE.md",
  "main": "./lib/index.js",
  "types": "./index.d.ts",
  "files": ["lib", "formatters", "index.d.ts", "LICENSE.md", "NOTICE.md"],
  "scripts": {
    "test": "mocha test --timeout 20000 --exit"
  }
}
```

Удалить `bin`, `postpublish`, `engines`. `index.d.ts` создаётся в Task 2.

- [ ] **Step 5: Удалить тесты LibreOffice из `test/test.carbone.js`**

По исследованию (номера 3.8.2): тест «path instead of buffer (with conversion)» (~2772), hardRefresh TOC (~3123), `describe('render and convert document')` (~3150-3326), `describe('convert')` (~3327-3369), `describe('render and convert CSV with options')` (~3370-конец), `listConversionFormats` (~327-334), тесты `renderPrefix` (~2684, 2726, 2753), hardRefresh неизвестных файлов (~2875), тесты `set` с файловыми опциями (~16-57). Найти их по названиям (`grep -n "describe(\|it('" test/test.carbone.js`), удалить целиком.

- [ ] **Step 6: NOTICE.md**

```markdown
# Происхождение кода

Пакет `@carbone-reports/carbone` — изменённая копия Carbone Community Edition 3.8.2
(https://github.com/carboneio/carbone, через форк https://github.com/SamRozhkov/carbone, коммит `1df45b5`),
перенесённая в монорепо carbone-reports через `git subtree` вместе с историей.

Лицензия — Carbone Community License (CCL), текст в `LICENSE.md`. Пакет используется только как часть
продукта carbone-reports (CCL 2.1(b), 2.1(d)) и отдельно не распространяется (`"private": true`).
Пользователи carbone-reports уведомляются, что эта часть продукта подчиняется CCL (раздел «Лицензии» README).

## Отличия от апстрима

- Удалена конвертация через LibreOffice (`converter.js`, `converter.py`, `format.js`, опции `convertTo`/`renderPrefix`).
  Документ собирается в формате шаблона; перевод в другие форматы делает OnlyOffice Document Server в API.
- Добавлена `renderBuffer(template, ext, data, options)` — сборка из буфера без временных файлов.
- Перенесён синтаксис бесплатного режима Carbone 5 (итератор `.i`, циклы по массивам строк, `:set`,
  новые форматтеры, поведение отключённых функций) — см. историю коммитов `packages/carbone`.

## Правило чистой реализации

Новые возможности написаны по открытой документации carbone.io и по записанному поведению
Carbone EE 5.15.3 без лицензии (эталоны `test/golden/*.json`). Код из образа `carbone/carbone-ee`
не читался, не извлекался и не копировался.

## Обновление из апстрима

`git subtree pull --prefix=packages/carbone carbone-fork master` (без `--squash`, как и при импорте).
```

- [ ] **Step 7: Подключить пакет к монорепо**

`eslint.config.js` — в массив `ignores` добавить `'packages/carbone/**'` (вендорный CommonJS-код). `.prettierignore` — добавить строку `packages/carbone/`. Если в `.github/dependabot.yml` есть экосистема `npm` в `/`, добавить для неё `ignore` зависимостей `dayjs`, `debug`, `yauzl`, `yazl`, `mocha` не нужно — оставить как есть (обновления придут обычными PR). Затем:

```bash
cd /Users/sam/carbone-reports && export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH
pnpm install
git diff --stat pnpm-lock.yaml   # появился importer packages/carbone
```

Если `pnpm install` предупреждает о build-скриптах зависимостей пакета — их нет (dayjs, debug, yauzl, yazl чистый JS); `onlyBuiltDependencies` не трогать.

- [ ] **Step 8: Запустить тесты пакета**

```bash
cd /Users/sam/carbone-reports && TZ=Europe/Paris pnpm --filter @carbone-reports/carbone test 2>&1 | tail -15
```

Expected: около 800 passing, 0 failing (тесты апстрима до Task 2 рассчитаны на `TZ=Europe/Paris`). Если что-то падает из-за удалённой конвертации — удалить и этот тест (он проверял LibreOffice), перечислить удалённые в отчёте.

- [ ] **Step 9: Проверки и коммит**

```bash
cd /Users/sam/carbone-reports && pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add -A packages/carbone eslint.config.js .prettierignore pnpm-lock.yaml
git commit -m "chore(carbone): workspace package without LibreOffice conversion, CLI and publishing bits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `renderBuffer` и даты в UTC

**Files:**
- Modify: `packages/carbone/lib/file.js` (`openTemplateBuffer`, защита `unzip` от двойного callback)
- Modify: `packages/carbone/lib/index.js` (`renderBuffer`, экспорт)
- Modify: `packages/carbone/formatters/date.js` (`parse` → UTC; регистрация плагинов dayjs)
- Create: `packages/carbone/index.d.ts`
- Create: `packages/carbone/test/test.renderBuffer.js`
- Modify: `packages/carbone/test/test.carbone.js`, `packages/carbone/test/test.formatter.js` (новые ожидания дат)

**Interfaces:**
- Consumes: пакет из Task 1.
- Produces: `renderBuffer(template: Buffer, ext: string, data: unknown, options?: { lang?: string; timezone?: string; complement?: object; translations?: object; currencySource?: string; currencyTarget?: string; currencyRates?: Record<string, number> }): Promise<Buffer>` — экспорт `require('@carbone-reports/carbone').renderBuffer`; типы в `index.d.ts`. Ошибка шаблона — отклонённый Promise с `Error`, чей `message` — текст Carbone.

- [ ] **Step 1: Тест `renderBuffer` (падает)**

`packages/carbone/test/test.renderBuffer.js`:

```js
const assert = require('assert');
const yazl = require('yazl');
const yauzl = require('yauzl');
const carbone = require('../lib/index');

function docx (bodyXml) {
  return new Promise(function (resolve) {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), '[Content_Types].xml');
    zip.addBuffer(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + bodyXml + '</w:body></w:document>'), 'word/document.xml');
    const parts = [];
    zip.outputStream.on('data', function (c) { parts.push(c); }).on('end', function () { resolve(Buffer.concat(parts)); });
    zip.end();
  });
}

function documentXml (buf) {
  return new Promise(function (resolve, reject) {
    yauzl.fromBuffer(buf, { lazyEntries: true }, function (err, z) {
      if (err) return reject(err);
      z.readEntry();
      z.on('entry', function (e) {
        if (e.fileName !== 'word/document.xml') return z.readEntry();
        z.openReadStream(e, function (err, s) {
          if (err) return reject(err);
          const parts = [];
          s.on('data', function (c) { parts.push(c); }).on('end', function () { resolve(Buffer.concat(parts).toString()); });
        });
      });
    });
  });
}

const p = function (t) { return '<w:p><w:r><w:t xml:space="preserve">' + t + '</w:t></w:r></w:p>'; };

describe('renderBuffer', function () {
  it('собирает docx из буфера в формате шаблона', async function () {
    const out = await carbone.renderBuffer(await docx(p('Покупатель: {d.name}')), 'docx', { name: 'Иван' }, { lang: 'ru', timezone: 'Europe/Moscow' });
    assert.ok(Buffer.isBuffer(out));
    assert.strictEqual(out.slice(0, 2).toString(), 'PK');
    assert.ok((await documentXml(out)).includes('Покупатель: Иван'));
  });

  it('ошибка шаблона — отклонённый Promise с текстом Carbone', async function () {
    await assert.rejects(
      carbone.renderBuffer(await docx(p('{d.n:fooBar()}')), 'docx', { n: 1 }, {}),
      /Formatter "fooBar" does not exist/
    );
  });

  it('битый zip — отклонённый Promise, без двойного callback', async function () {
    await assert.rejects(carbone.renderBuffer(Buffer.from('PK\u0003\u0004 not a zip'), 'docx', {}, {}));
  });

  it('XML-шаблон без zip возвращает Buffer', async function () {
    const out = await carbone.renderBuffer(Buffer.from('<a>{d.x}</a>'), 'xml', { x: 'y' }, {});
    assert.strictEqual(out.toString(), '<a>y</a>');
  });

  it('дата без смещения разбирается как UTC при любом TZ процесса', async function () {
    const tpl = await docx(p('{d.d:formatD(\'DD.MM.YYYY HH:mm\')}'));
    const out = await carbone.renderBuffer(tpl, 'docx', { d: '2026-03-08 23:30:00' }, { lang: 'ru', timezone: 'Europe/Moscow' });
    assert.ok((await documentXml(out)).includes('09.03.2026 02:30'));
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /Users/sam/carbone-reports/packages/carbone && TZ=Asia/Yekaterinburg npx mocha test/test.renderBuffer.js --exit`
Expected: FAIL — `carbone.renderBuffer is not a function`.

- [ ] **Step 3: `openTemplateBuffer` в `lib/file.js`**

Рядом с `openTemplate` (file.js:143). Используется существующий приватный `unzipFiles(template, files, cb)` (file.js:340) — он же разворачивает встроенные xlsx/ods; `unzip` уже принимает Buffer (`yauzl.fromBuffer`, file.js:56-59). Проверить сигнатуру `unzipFiles` по коду и адаптировать вызов.

```js
/**
 * Шаблон из буфера (без файловой системы): zip — через unzipFiles, иначе один текстовый файл.
 */
openTemplateBuffer : function (buffer, extension, callback) {
  var _template = {
    isZipped   : false,
    filename   : 'template.' + extension,
    embeddings : [],
    files      : []
  };
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4B) {
    _template.isZipped = true;
    return unzipFiles(_template, buffer, callback);
  }
  _template.files.push({ name : _template.filename, data : buffer.toString('utf8'), isMarked : true, parent : '' });
  return callback(null, _template);
},
```

В `unzip` (file.js:53-106): защитить callback флагом, чтобы ветка zip-бомбы (77-79) и событие `end` не вызывали его дважды, и чтобы ошибка `yauzl` для битого буфера доходила до callback ровно один раз:

```js
var _done = false;
function finish (err, result) {
  if (_done) return;
  _done = true;
  callback(err, result);
}
```

Все `callback(...)` внутри `unzip` заменить на `finish(...)`.

- [ ] **Step 4: `renderBuffer` в `lib/index.js`**

Прототип: `docs/superpowers/plans/2026-10-09-carbone-embedded/proto.js`. Внутри `index.js` есть приватный `walkFiles` (index.js:327-356) — использовать его (проверить сигнатуру по коду: он вызывается из `render` около строки 215).

```js
/**
 * Собирает отчёт из шаблона в памяти. Формат результата совпадает с форматом шаблона;
 * перевод в другой формат в этой сборке не поддерживается (его делает OnlyOffice в API).
 * @param {Buffer} template содержимое файла шаблона
 * @param {String} extension расширение шаблона: docx, xlsx, odt, ods, pptx, xml, html…
 * @param {*} data данные отчёта (d.)
 * @param {Object} [options] lang, timezone, complement, translations, currencySource, currencyTarget, currencyRates
 * @returns {Promise<Buffer>}
 */
function renderBuffer (template, extension, data, options) {
  return new Promise(function (resolve, reject) {
    if (!Buffer.isBuffer(template)) return reject(new Error('renderBuffer: template must be a Buffer'));
    input.parseOptions(Object.assign({}, options), reject, function (_options) {
      _options.extension = extension;
      file.openTemplateBuffer(template, extension, function (err, _template) {
        if (err) return reject(err);
        _template.extension = extension;
        preprocessor.execute(_template, _options, function (err, _template) {
          if (err) return reject(err);
          walkFiles(_template, data, _options, function (err, _report) {
            if (err) return reject(err);
            file.buildFile(_report, function (err, _result) {
              if (err) return reject(err);
              resolve(Buffer.isBuffer(_result) ? _result : Buffer.from(_result, 'utf8'));
            });
          });
        });
      });
    });
  });
}
```

Добавить `renderBuffer` в экспортируемый объект `carbone`. Если `walkFiles` или `parseOptions` имеют другую форму аргументов — подстроить вызов, не меняя их поведения для `render`.

- [ ] **Step 5: Даты в UTC (`formatters/date.js`)**

Заменить `parse` (date.js:183-192):

```js
/**
 * Строка без смещения разбирается как UTC (как в Carbone EE): результат не зависит от часового пояса процесса.
 * Смещение или Z в строке, метки X/x остаются абсолютными. Вывод — в this.timezone (formatD).
 */
function parse (d, patternIn) {
  if (typeof d === 'object' && d !== null && d.isValid) return d;
  return patternIn ? dayjs.utc(d, patternIn) : dayjs.utc(d + '');
}
```

Перенести регистрацию плагинов dayjs (`utc`, `timezone`, `customParseFormat`, `advancedFormat`, `localizedFormat` и др., index.js:605-610) в начало `formatters/date.js` (`dayjs.extend(...)` идемпотентен; в index.js можно оставить), чтобы `formatters/date.js` работал при загрузке отдельно — его загружает `test/test.formatter.js`.

- [ ] **Step 6: Новые ожидания дат в тестах апстрима**

```bash
cd /Users/sam/carbone-reports/packages/carbone
for tz in UTC Europe/Paris Asia/Yekaterinburg; do echo "== $tz"; TZ=$tz npx mocha test --timeout 20000 --exit 2>&1 | grep -E "passing|failing"; done
```

Около 8 тестов в `test/test.carbone.js` (блок «format date», ~58-229) и `test/test.formatter.js` (~9-70) ожидают разбор наивных дат по Парижу. Пересчитать ожидания под правило «наивная дата = UTC, вывод в `timezone` опций» (результат должен быть одинаков при всех трёх TZ). Каждому изменённому ожиданию — комментарий `// UTC-разбор, как в Carbone EE`.

- [ ] **Step 7: `index.d.ts`**

Пакет CommonJS, поэтому типы в форме `export =`: из ESM-кода API и скриптов он импортируется как `import carbone from '@carbone-reports/carbone'` (в рантайме Node default-импорт CommonJS = `module.exports`).

```ts
declare namespace carbone {
  interface RenderBufferOptions {
    lang?: string;
    timezone?: string;
    complement?: Record<string, unknown>;
    translations?: Record<string, Record<string, string>>;
    currencySource?: string;
    currencyTarget?: string;
    currencyRates?: Record<string, number>;
  }

  /** Отчёт в формате шаблона; ошибка шаблона — отклонённый Promise с текстом Carbone. */
  function renderBuffer(
    template: Buffer,
    extension: string,
    data: unknown,
    options?: RenderBufferOptions,
  ): Promise<Buffer>;
}

export = carbone;
```

Проверка формы импорта (выполнить из корня после `pnpm install`): `node --input-type=module -e "import c from '@carbone-reports/carbone'; console.log(typeof c.renderBuffer)"` → `function` (запускать из каталога, где пакет разрешается, например `apps/api` после Task 9 или корня после Task 8). Если `tsc` откажет в default-импорте модуля с `export =`, в `tsconfig.base.json` нужен `"esModuleInterop": true` (или `allowSyntheticDefaultImports`) — добавить в той задаче, где появится первый импорт (Task 8 или 9).

- [ ] **Step 8: Все тесты пакета при трёх TZ**

Run: цикл из шага 6. Expected: при `UTC`, `Europe/Paris`, `Asia/Yekaterinburg` — одинаковое число passing, 0 failing; `test/test.renderBuffer.js` — 5 passing.

- [ ] **Step 9: Коммит**

```bash
cd /Users/sam/carbone-reports && pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add packages/carbone
git commit -m "feat(carbone): renderBuffer from memory; naive dates parsed as UTC like Carbone EE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Эталоны EE и их проверка

**Files:**
- Create: `packages/carbone/test/golden/help.json`, `packages/carbone/test/golden/matrix.json` (из `docs/superpowers/plans/2026-10-09-carbone-embedded/golden-draft/`)
- Create: `packages/carbone/test/golden/known-gaps.json`
- Create: `packages/carbone/test/golden-lib.js`, `packages/carbone/test/test.golden.js`
- Create: `packages/carbone/test/golden/README.md`
- Create: `scripts/carbone-parity.ts`
- Modify: `docs/superpowers/notes/2026-10-13-carbone-community-matrix.md` (строка 5: где теперь лежат пробы)

**Interfaces:**
- Consumes: `renderBuffer` (Task 2).
- Produces: `test/test.golden.js` — каждый случай эталона: совпадает с `expect` (или с `deviation.ours`), а случаи из `known-gaps.json` обязаны **не** совпадать (иначе тест просит убрать их из списка). Tasks 4–7 сокращают `known-gaps.json`; к концу Task 7 список пуст. Формат случая — ниже.

Формат файла эталонов:

```jsonc
{
  "version": 1,
  "engine": "carbone/carbone-ee:full-5.15.3-fonts, no licence (Community mode)",
  "source": "…",
  "compare": "text = docxText(word/document.xml); error = message без 'Unable to generate the document. Error: ' и ' Source: …'",
  "cases": [
    {
      "id": "matrix/s1/table-i-i-1",          // уникальный
      "probe": "tests.py :: …",                // происхождение (необязательно)
      "template": "строки в нотации справки",  // '| a | b |' — строка таблицы, иначе абзац
      "raw": ["<w:p>…</w:p>"],                 // необязательно: заменяет строки '<<RAW>>' по порядку
      "rels": "<Relationship …/>",             // необязательно
      "data": {},
      "options": { "lang": "ru", "timezone": "Europe/Moscow" },
      "expect": { "text": "…" },               // или { "error": "…" }
      "skip": "причина",                       // необязательно: не рендерится (pdf/txt/картинки)
      "volatile": "причина",                   // необязательно: проверяется только отсутствие ошибки
      "deviation": { "ours": "…", "why": "…" } // необязательно: осознанное отличие от EE
    }
  ]
}
```

- [ ] **Step 1: Перенести черновые эталоны**

```bash
cd /Users/sam/carbone-reports
mkdir -p packages/carbone/test/golden
cp docs/superpowers/plans/2026-10-09-carbone-embedded/golden-draft/help.json packages/carbone/test/golden/help.json
cp docs/superpowers/plans/2026-10-09-carbone-embedded/golden-draft/matrix.json packages/carbone/test/golden/matrix.json
node -e "for (const f of ['help','matrix']) { const j=require('./packages/carbone/test/golden/'+f+'.json'); console.log(f, j.cases.length, j.cases.filter(c=>c.skip).length+' skip') }"
```

Expected: `help 44 0 skip`, `matrix 254 7 skip` (6 pdf/txt + 1 картинка). Проверить, что `help.json` содержит все 44 примера из `apps/web/src/pages/admin/help/content.ts` (id `help/<id примера>`), а у недоступных `expect.error` — текст EE `Formatter "X" is disabled in the Community Edition.`, у `na-count` — имя `cumCount`.

- [ ] **Step 2: `test/golden-lib.js` — сборка DOCX и извлечение текста**

Порт `buildDocx`/`docxText` из `scripts/help-check.ts` (строки ~51-121) и `docs/superpowers/plans/2026-10-09-carbone-embedded/harness.js` на чистый CommonJS с `yazl`/`yauzl` (зависимости пакета):
- `buildDocx(template: string, raw?: string[], rels?: string): Promise<Buffer>` — строка, начинающаяся с `|`, — строка таблицы Word (`<w:tbl>`, соседние строки таблицы объединяются в одну таблицу, ширина ячейки `tcW 2000`), строка `<<RAW>>` — следующий элемент `raw` как есть, иначе абзац `<w:p><w:r><w:t xml:space="preserve">…</w:t></w:r></w:p>` (XML-экранирование `& < >`). `rels` — тело `word/_rels/document.xml.rels`.
- `docxText(buffer): Promise<string>` — как в help-check: абзацы — склеенные `<w:t>`, `<w:br/>` → `\n`, пустые абзацы пропускаются, строки таблицы → `| a | b |` (абзацы внутри ячейки через ` / `), строки через `\n`, разэкранирование XML-сущностей.
- `normalizeError(message): string` — убирает префикс `Unable to generate the document. Error: ` и суффикс ` Source: "…"` (если есть).

Проверка самого харнесса (в `test.golden.js`, отдельный `describe`): `docxText(await buildDocx(t)) === t` для шаблона без тегов из трёх абзацев и таблицы 2×2.

- [ ] **Step 3: `test/test.golden.js`**

```js
const assert = require('assert');
const { renderBuffer } = require('../lib/index');
const { buildDocx, docxText, normalizeError } = require('./golden-lib');

const GAPS = new Set(require('./golden/known-gaps.json').ids);

async function run (c) {
  const tpl = await buildDocx(c.template, c.raw, c.rels);
  try {
    const out = await renderBuffer(tpl, 'docx', c.data, c.options);
    return { text: await docxText(out) };
  } catch (e) {
    return { error: normalizeError(e.message) };
  }
}

function expected (c) {
  return c.deviation ? { text: c.deviation.ours } : c.expect;
}

for (const name of ['help', 'matrix']) {
  const set = require('./golden/' + name + '.json');
  describe('эталоны EE: ' + name, function () {
    for (const c of set.cases) {
      if (c.skip) { it.skip(c.id + ' — ' + c.skip); continue; }
      it(c.id, async function () {
        const got = await run(c);
        if (c.volatile) return assert.ok(!got.error, c.id + ': ' + got.error);
        const want = expected(c);
        const same = JSON.stringify(got) === JSON.stringify(want);
        if (GAPS.has(c.id)) {
          assert.ok(!same, c.id + ' теперь совпадает с эталоном — уберите его из test/golden/known-gaps.json');
        } else {
          assert.deepStrictEqual(got, want);
        }
      });
    }
  });
}
```

- [ ] **Step 4: Составить `known-gaps.json` по факту**

Временно запустить без списка, собрать id упавших случаев:

```bash
cd /Users/sam/carbone-reports/packages/carbone
echo '{"ids":[]}' > test/golden/known-gaps.json
npx mocha test/test.golden.js --exit --reporter json 2>/dev/null > /tmp/golden.json || true
node -e "const r=require('/tmp/golden.json'); const ids=r.failures.map(f=>f.title).sort(); require('fs').writeFileSync('test/golden/known-gaps.json', JSON.stringify({comment:'Случаи, где сборка пока расходится с EE. Каждая задача переноса синтаксиса убирает свои id; к концу плана список пуст.', ids}, null, 1)+'\n'); console.log(ids.length)"
rm /tmp/golden.json
```

Expected: около 90 id (матрица) + 13 (справка) минус то, что уже починили Task 2 (даты). Затем `npx mocha test --timeout 20000 --exit` — 0 failing.

- [ ] **Step 5: `test/golden/README.md`**

Кратко (по-русски): откуда эталоны (записи EE 5.15.3 без лицензии: пробы матрицы `docs/superpowers/notes/2026-10-13-carbone-community-matrix.md` и примеры справки), формат случая (как выше), правила: `known-gaps.json` только сокращается; осознанное отличие — поле `deviation` с объяснением `why`; новые пробы добавляются через `scripts/carbone-parity.ts`.

- [ ] **Step 6: `scripts/carbone-parity.ts` — дописать эталоны новым пробам (только для разработки)**

Скрипт берёт JSON-файл со случаями (формат выше), для случаев без `expect` поднимает `carbone/carbone-ee:full-5.15.3-fonts` (`docker run -d --rm -p 127.0.0.1::4000`), для каждого случая собирает DOCX (`buildDocx` из `packages/carbone/test/golden-lib.js` через `createRequire`), делает `POST /template` (multipart, поле `template`, заголовок `carbone-version: 5`) и `POST /render/{id}?download=true` с телом `{ data, convertTo: 'docx', ...options }` и записывает `expect.text` (`docxText`) или `expect.error` (`normalizeError(json.error)`), затем останавливает контейнер. Аргументы: `pnpm exec tsx scripts/carbone-parity.ts <файл.json>`. Перед запуском проверяет `df -h`-эквивалент не нужен; печатает предупреждение, что образ весит 3,7 ГБ и в CI не используется. Комментарий в начале файла — назначение и пример запуска. Скрипт входит в `typecheck:scripts`; модульного теста нет (он только для ручного запуска), но `pnpm typecheck` должен проходить.

- [ ] **Step 7: Заметка матрицы**

В `docs/superpowers/notes/2026-10-13-carbone-community-matrix.md` строку 5 (про «в этой папке») заменить: пробы и записанные ответы EE перенесены в `packages/carbone/test/golden/matrix.json`, исходный Python-харнесс — в `docs/superpowers/plans/2026-10-09-carbone-embedded/probe-harness/`.

- [ ] **Step 8: Тесты и коммит**

```bash
cd /Users/sam/carbone-reports && export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH
pnpm --filter @carbone-reports/carbone test 2>&1 | tail -5     # 0 failing
pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add packages/carbone scripts/carbone-parity.ts docs/superpowers/notes/2026-10-13-carbone-community-matrix.md
git commit -m "test(carbone): EE 5.15.3 golden cases (help + community matrix) with shrinking known-gaps list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Общее для Tasks 4–7 (перенос синтаксиса)

- Источник истины — эталоны `packages/carbone/test/golden/*.json` (записанное поведение EE) и открытая документация carbone.io. Код образа `carbone-ee` не использовать.
- Каждая задача: (1) пишет модульные тесты своих возможностей в `packages/carbone/test/test.ee-compat.js` (общий файл, каждая задача добавляет свой `describe`), (2) видит их падение, (3) реализует, (4) убирает из `test/golden/known-gaps.json` id, которые теперь совпадают (тест эталонов сам укажет их сообщением «теперь совпадает с эталоном»), (5) прогоняет все тесты пакета при `TZ=UTC`, `Europe/Paris`, `Asia/Yekaterinburg`, (6) коммитит.
- Помощник для модульных тестов — в начале `test/test.ee-compat.js` (создаёт Task 4):

```js
const assert = require('assert');
const { renderBuffer } = require('../lib/index');
const { buildDocx, docxText, normalizeError } = require('./golden-lib');

const RU = { lang: 'ru', timezone: 'Europe/Moscow' };

async function text (template, data, options) {
  return docxText(await renderBuffer(await buildDocx(template), 'docx', data, options || RU));
}

async function error (template, data, options) {
  try {
    await renderBuffer(await buildDocx(template), 'docx', data, options || RU);
  } catch (e) {
    return normalizeError(e.message);
  }
  throw new Error('ожидалась ошибка');
}
```

- Если тест апстрима утверждает старое поведение 3.8.2, которое противоречит эталону EE, — изменить ожидание с комментарием `// как в Carbone EE 5 (эталон <id>)`. Перечислить такие тесты в отчёте.
- Если случай эталона не удаётся воспроизвести разумно, не подгонять: записать в эталон `deviation: { ours, why }` с объяснением и упомянуть в отчёте. Это допустимо только для случаев, которых нет в справке (`help/*` должны совпадать все, кроме записанных в спецификации).

---

### Task 4: Отключённые функции и текст ошибок EE

**Files:**
- Create: `packages/carbone/lib/community.js`
- Modify: `packages/carbone/lib/builder.js` (`getFormatterString`, ~126), `packages/carbone/lib/parser.js` (`assignLoopId`, ~362-391), `packages/carbone/formatters/array.js` (`count`)
- Create: `packages/carbone/test/test.ee-compat.js`
- Modify: `packages/carbone/test/golden/known-gaps.json`

**Interfaces:**
- Consumes: `renderBuffer`, эталоны (Tasks 2–3).
- Produces: `require('./community').disabledName(name: string): string | null` — имя для сообщения (для `count` — `cumCount`) или `null`; ошибка `Formatter "X" is disabled in the Community Edition.` из сборки. API разбирает её существующим `apps/api/src/modules/carbone/community.ts` (регулярка совместима с точкой и суффиксом `Source`).

- [ ] **Step 1: Тесты (падают)**

В `test/test.ee-compat.js` (помощник из «Общего» + блок):

```js
describe('EE: отключённые функции', function () {
  const cars = { cars: [{ brand: 'Лада', qty: 3 }, { brand: 'Тесла', qty: 2 }] };
  for (const f of ['aggSum', 'aggAvg', 'aggMin', 'aggMax', 'aggCount', 'aggCountD', 'aggStr', 'aggStrD', 'cumSum', 'cumCount', 'cumCountD']) {
    it(f, async function () {
      assert.strictEqual(await error('Итого: {d.cars[].qty:' + f + '}', cars), 'Formatter "' + f + '" is disabled in the Community Edition.');
    });
  }
  for (const f of ['drop', 'keep', 'html', 'color', 'barcode', 'chart', 'formatR', 'defaultURL', 'autoOrient']) {
    it(f, async function () {
      assert.strictEqual(await error('{d.v:' + f + '()}', { v: 'x' }), 'Formatter "' + f + '" is disabled in the Community Edition.');
    });
  }
  it('count() называется cumCount, как в EE', async function () {
    const t = '| {d.cars[i].brand:count()} |\n| {d.cars[i+1].brand} |';
    assert.strictEqual(await error(t, cars), 'Formatter "cumCount" is disabled in the Community Edition.');
  });
  it('imageFit не отключён, а неизвестен', async function () {
    assert.match(await error('{d.v:imageFit()}', { v: 'x' }), /^Formatter "imageFit" does not exist/);
  });
  it('отключённая функция в колонтитуле тоже даёт ошибку', async function () {
    // Колонтитул: отдельный word/header1.xml. Собрать DOCX с header через buildDocx не получится —
    // проверяется на уровне buildXML, как это делают тесты апстрима test.builder.buildXML.js.
    const builder = require('../lib/builder');
    const input = require('../lib/input');
    await new Promise(function (resolve, reject) {
      input.parseOptions({}, reject, function (options) {
        builder.buildXML('<w:hdr><w:p><w:r><w:t>{d.n:aggSum}</w:t></w:r></w:p></w:hdr>', { n: 1 }, options, function (err) {
          try { assert.match(String(err && err.message), /Formatter "aggSum" is disabled in the Community Edition\./); resolve(); } catch (e) { reject(e); }
        });
      });
    });
  });
});
```

Run: `cd packages/carbone && npx mocha test/test.ee-compat.js --exit` → FAIL (`does not exist`).

- [ ] **Step 2: `lib/community.js`**

```js
/**
 * Функции, отключённые в бесплатном режиме Carbone EE 5.15.3 (эталоны test/golden).
 * Их нет в реестре форматтеров, чтобы подсказка «Do you mean» не предлагала их.
 */
const DISABLED = new Set([
  'aggSum', 'aggAvg', 'aggMin', 'aggMax', 'aggCount', 'aggCountD', 'aggStr', 'aggStrD',
  'cumSum', 'cumCount', 'cumCountD', 'drop', 'keep', 'html', 'color', 'barcode', 'chart',
  'formatR', 'defaultURL', 'autoOrient'
]);

/** EE сообщает count() под именем cumCount. */
const ALIAS = { count : 'cumCount' };

/** Имя для сообщения об ошибке или null, если функция не отключена. */
function disabledName (name) {
  const _name = ALIAS[name] || name;
  return DISABLED.has(_name) ? _name : null;
}

function disabledError (name) {
  return new Error('Formatter "' + name + '" is disabled in the Community Edition.');
}

module.exports = { disabledName, disabledError };
```

- [ ] **Step 3: Проверка в `builder.getFormatterString`**

Перед проверкой существования (builder.js:126-129):

```js
var _disabled = community.disabledName(_functionStr);
if (_disabled !== null) {
  throw community.disabledError(_disabled);
}
```

`var community = require('./community');` — в начале builder.js. Удалить `count` из `formatters/array.js` (экспорт) и переписывание `count` в `parser.assignLoopId` (parser.js:362-391), если после этого оно стало мёртвым кодом (проверить, что тесты апстрима на `count` — теперь ожидают ошибку; их ожидания заменить с комментарием `// как в Carbone EE 5: count отключён`).

- [ ] **Step 4: Тесты зелёные, сократить known-gaps**

```bash
cd /Users/sam/carbone-reports/packages/carbone
npx mocha test/test.ee-compat.js --exit
npx mocha test --timeout 20000 --exit 2>&1 | grep -E "passing|failing|теперь совпадает"
```

Каждый id из сообщений «теперь совпадает с эталоном» удалить из `test/golden/known-gaps.json` (это случаи `help/na-*` и пробы матрицы раздела «отключённые функции»). Повторить до 0 failing; затем цикл по трём TZ.

- [ ] **Step 5: Коммит**

```bash
cd /Users/sam/carbone-reports && pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add packages/carbone
git commit -m "feat(carbone): EE free-mode disabled functions with EE error text; count reported as cumCount

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Форматтеры бесплатного режима EE

**Files:**
- Modify: `packages/carbone/formatters/string.js`, `number.js`, `date.js`, `array.js`, `condition.js`
- Modify: `packages/carbone/lib/builder.js` (литералы в кавычках, ~82-118)
- Modify: `packages/carbone/lib/index.js` (порядок регистрации — для подсказки `Do you mean "mod"`)
- Modify: `packages/carbone/test/test.ee-compat.js`, `packages/carbone/test/golden/known-gaps.json`

**Interfaces:**
- Consumes: Task 4.
- Produces: новые форматтеры `ellipsis, append, replace, split, mod, abs, ceil, floor, formatI, diffD, ifTE, printJSON, t`; исправленные `substr`, `arrayJoin`, `formatC`, `ifEmpty`, `padl`/`padr` (литерал `'.'`). Названия и аргументы — как в документации Carbone 5 (https://carbone.io/documentation/design/formatters/overview.html и страницы разделов).

Ожидаемое поведение (из эталонов; полный набор — `matrix.json`/`help.json`, разделы «Formatting» и `tests2/tests3`):

| Шаблон | Данные | Результат EE |
|---|---|---|
| `{d.s:ellipsis(7)}` | `s: 'Длинная строка'` | `Длинная...` |
| `{d.s:append('!')}` | `s: 'a'` | `a!` |
| `{d.s:replace('-','/')}` | `s: '2026-03-08'` | `2026/03/08` |
| `{d.s:split(',')}` | `s: 'a,b'` | `a,b` |
| `{d.n:mod(3)}` | `n: 10` | `1` |
| `{d.n:abs()}` | `n: -5` | `5` |
| `{d.n:ceil()}` / `{d.n:floor()}` | `n: 1.5` | `2` / `1` |
| `{d.n:formatI('human')}` (lang ru) | `n: 7200000` | `2 часа` |
| `{d.n:formatI('human+')}` | `n: 7200000` | `через 2 часа` |
| `{d.n:formatI('days','hours')}` | `n: 48` | `2` |
| `{d.d:diffD('2026-12-31','days')}` | `d: '2026-03-08'` | `298` |
| `{d.v:ifTE('number'):show('number'):elseShow('string')}` | `v: 1` / `v: 'x'` | `number` / `string` |
| `{d.o:printJSON()}` | `o: {a:1}` | `{"a":1}` |
| `{d.v:t}` с `translations: { ru: { 'Hello': 'Привет' } }` | `v: 'Hello'` | `Привет` |
| `{d.s:substr(0,10,true)}` | `s: 'Длинная строка'` | `Длинная ` (режим слов) |
| `{d.a:arrayJoin('; ',1,1)}` | `a: ['a','b','c']` | `b` |
| `{d.n:formatC(2,'USD')}` | `n: 1140.3`, lang `en` | `1,140.30 $` (точные строки и курсы — в эталонах `formatC`) |
| `{d.s:padr(6,'.')}` | `s: 'ab'` | `ab....` |
| `{d.v:ifEmpty('—'):formatD('DD.MM.YYYY')}` | `v: null` | `Invalid Date` (цепочка не обрывается) |
| `{d.n:fooBar()}` | — | ошибка `Formatter "fooBar" does not exist. Do you mean "mod"?` |

- [ ] **Step 1: Тесты (падают)**

В `test/test.ee-compat.js` добавить `describe('EE: форматтеры', …)` с одним `it` на каждую строку таблицы (`assert.strictEqual(await text(шаблон, данные[, опции]), результат)`; для `fooBar` — `await error(...)`). Для `formatC(2,'USD')` взять шаблон, данные, опции и результат из случая эталона `matrix.json`, где `template` содержит `formatC(2,'USD')` (`grep -n "formatC(2" test/golden/matrix.json`). Для `t` — опция `translations`.

Run: `npx mocha test/test.ee-compat.js --exit` → новые тесты FAIL.

- [ ] **Step 2: Реализация**

- Новые форматтеры — в файлы по смыслу (string: `ellipsis, append, replace, split, printJSON, t`; number: `mod, abs, ceil, floor`; date: `formatI, diffD` (через `dayjs.duration`/`relativeTime` с локалью `this.lang`, разбор дат — тем же `parse` (UTC) из Task 2); condition: `ifTE`). Поведение уточнять по документации carbone.io и эталонам; где эталона нет — по документации, с тестом.
- `t` — перевод значения через `this.translations[this.lang]` (`input.parseOptions` уже кладёт `translations` в опции); нет перевода — значение как есть.
- `substr(start, end, wordMode)` — в режиме слов не режет слово: результат — подстрока до последней границы слова в пределах `end` (эталон `Длинная `).
- `arrayJoin(sep, index, count)` — с `index`/`count` берёт срез массива.
- `formatC(precision, targetCurrency)` — второй аргумент задаёт целевую валюту (переводит через `convCurr`-курсы опций, как `convCurr` → `this.modifiedCurrencyTarget`).
- `ifEmpty` — не ставит `this.stopPropagation = true` (condition.js:458-460): цепочка продолжается, следующий форматтер получает подставленное значение.
- Литералы в кавычках (builder.js:82-118): решать «путь или литерал» **до** снятия кавычек — путём считается только аргумент без кавычек, начинающийся с `.` (`.x`, `..x`). `'.'` в кавычках — литерал.
- Подсказка `Do you mean`: `helper.findClosest` берёт первый минимум по порядку ключей; зарегистрировать новые числовые форматтеры так, чтобы для `fooBar` выходило `mod` (проверить тестом).

- [ ] **Step 3: Тесты зелёные, сократить known-gaps (как в Task 4, шаг 4), три TZ**

- [ ] **Step 4: Коммит**

```bash
git add packages/carbone
git commit -m "feat(carbone): Carbone 5 free-mode formatters and EE fixes (substr words, arrayJoin range, formatC target, ifEmpty chain, quoted literals)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Циклы — `.i`, массивы строк, повтор в одном абзаце, `{o.…}`, ошибка без `[i+1]`

**Files:**
- Modify: `packages/carbone/lib/builder.js` (~82-93 `getInjectedVariable`, ~718-728 данные части и `parentsData`), `packages/carbone/lib/extracter.js` (~219-232, ~636-657), `packages/carbone/lib/parser.js` (~12-15 `isCarboneMarker`, ~488-583 `findPivot`/`findRepetitionPosition`), `packages/carbone/lib/input.js` (опции `o.`)
- Modify: `packages/carbone/test/test.ee-compat.js`, `packages/carbone/test/golden/known-gaps.json`

**Interfaces:**
- Consumes: Tasks 4–5.
- Produces: в контексте форматтера `this.parentsIndex: (number|undefined)[]` — индексы циклов, параллельно `this.parentsData` (их использует `:set` в Task 7); опции `options.preReleaseFeatureIn` (число) и `options.useHighPrecisionArithmetic` (булево) из тегов `{o.…}`.

Ожидаемое поведение (эталоны; данные `cars = [{brand:'Лада',qty:3,ok:true},{brand:'Тесла',qty:2,ok:false},{brand:'Лада',qty:5,ok:true},{brand:'БМВ',qty:1,ok:true}]`):

| Шаблон | Результат EE |
|---|---|
| `| {d.cars[i].brand:print(.i)} |` + `| {d.cars[i+1].brand} |` | строки `0`…`3` |
| то же с `print(.i):add(1)` | `1`…`4` |
| `mul(0):add(.i):add(1)` | `1`…`4` |
| фильтр `[i, ok=true]` с `print(.i):add(1)` | `1`, `3`, `4` (исходный индекс) |
| `{d.cars[i].i}`, `{d.cars[i]..i}` | пусто (не менять) |
| `{d.tags[i]}` / `{d.tags[i+1]}` по `tags: ['a','b','c']` (абзацы) | `a`, `b`, `c` |
| `[{d.cars[i].brand}, {d.cars[i+1].brand}]` в одном абзаце | `[Лада, Тесла, Лада, БМВ, ]` |
| `{o.useHighPrecisionArithmetic=true}{d.a:add(.b)}` по `a: 0.1, b: 0.2` | `0.3` (тег `{o.…}` сам ничего не печатает) |
| `{d.cars[i].brand}` без `[i+1]` | ошибка `The marker {d.cars[i].brand} has no corresponding [i+1] for array "cars". Add at least one tag with cars[i+1] to describe where is the i+1-th item.` (точный текст — из эталона, `grep -n "no corresponding" test/golden/matrix.json`) |

- [ ] **Step 1: Тесты (падают)** — `describe('EE: циклы', …)`, по `it` на строку таблицы, через `text`/`error`.

- [ ] **Step 2: `.i`**

1. В `getBuilderFunction` рядом с генерацией `context.parentsData = [...]` (builder.js:~728) генерировать `context.parentsIndex = [...]`: для каждого уровня — переменная индекса цикла (`_arrayIndexNameG`, объявлена ~576/627), если уровень — массив и переменная в области видимости, иначе `undefined`.
2. В `getInjectedVariable` (builder.js:84-91): аргумент `.i` (одна точка, имя `i`) → `contextName + '.parentsIndex[' + (_nbPoint - 1) + ']'` вместо `getValueOfPath`. Математические выражения (`parseMathematicalExpression` → тот же `getInjectedVariable`) получают это автоматически.
3. Фильтр сохраняет исходный индекс: индекс — позиция в исходном массиве, а не счётчик выведенных строк.

- [ ] **Step 3: Массив строк**

builder.js:~718: если у части нет атрибута (`!_dataAttr`) и уровень — элемент массива (`_dynamicData[_dataObj].type === 'array'`), значением считать сам элемент; печатать только примитивы (строка, число, булево), объекты — `''` (существующие `{d.list[i]}` как якоря цикла остаются невидимыми; это решение записать в `deviation` эталона, если для объектов есть проба, иначе — комментарием в коде).

- [ ] **Step 4: Повтор внутри одного абзаца**

В `extracter.findAndSetExactPositionOfArrays` (extracter.js:636-657), до `findPivot`: если между `position.start` и `position.end` нет символа `<` (повтор чисто текстовый внутри одного `<w:t>`), то `startEven = roughStart`, `endEven = startOdd = roughEnd` — повторяется только текст, без поиска тегов (`findPivot` в этом случае возвращал конец строки, и `findOpeningTagPosition` поднимался до корня документа).

- [ ] **Step 5: Теги `{o.…}`**

`parser.isCarboneMarker` (parser.js:12-15) — распознавать `o.`. Теги вида `{o.name=value}` удаляются из документа на этапе `findMarkers` и записываются в опции рендера (`options.preReleaseFeatureIn = Number(value)`, `options.useHighPrecisionArithmetic = value === 'true'`). `useHighPrecisionArithmetic` — `add/sub/mul/div` считают с округлением до 15 значащих цифр (`0.1 + 0.2` → `0.3`); точное правило — по документации carbone.io («useHighPrecisionArithmetic»), проверить эталоном.

- [ ] **Step 6: Ошибка цикла без `[i+1]`**

В `splitMarkers` при создании массива (extracter.js:219-232) запомнить текст первого маркера; в `findAndSetExactPositionOfArrays` для `type === 'array'` без итераторов `[i+1]` бросить `Error` с текстом из эталона.

- [ ] **Step 7: Тесты зелёные, сократить known-gaps, три TZ; тесты апстрима, ожидавшие старое поведение, — новые ожидания с комментарием**

- [ ] **Step 8: Коммит**

```bash
git add packages/carbone
git commit -m "feat(carbone): loop index .i, string arrays, inline repetition, {o.} option tags, missing [i+1] error like EE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `:set`, пути `c.` в аргументах, поиск по ключу, итоговая сверка

**Files:**
- Create: `packages/carbone/lib/set.js`
- Modify: `packages/carbone/lib/builder.js` (`buildXML` ~21-64; `getInjectedVariable` — пути `c.`)
- Modify: `packages/carbone/test/test.ee-compat.js`, `packages/carbone/test/golden/known-gaps.json`, при необходимости `test/golden/*.json` (`deviation`)

**Interfaces:**
- Consumes: `this.parentsData`, `this.parentsIndex` (Task 6), `options.preReleaseFeatureIn` (Task 6).
- Produces: `:set(c.<путь>)`; аргументы форматтеров вида `c.x.y` читаются из `c`; к концу задачи `known-gaps.json` содержит `"ids": []`.

Ожидаемое поведение (эталоны; `cars` как в Task 6):

| Шаблон | Результат EE |
|---|---|
| `{d.v:set(c.x)}{c.x}` по `v: 'stored'` | `stored` (тег `set` ничего не печатает) |
| `{d.cars[]:set(c.g[id=.brand].rows[])}` + таблица `| {c.g[i].id} |`, вложенный цикл `{c.g[i].rows[i].qty}` / `{c.g[i].rows[i+1].qty}`, `{c.g[i+1].id}` | группы в порядке первого появления (`Лада` с 3 и 5, `Тесла` с 2, `БМВ` с 1); `rows` — целые элементы |
| `{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}Итого: {c.total}` (`zero: 0`) | `Итого: 14` — особенность EE: первый элемент учитывается дважды (справка `totals-set-sum`, antiPattern) |
| без инициализации `c.total` | `Итого: NaN` |
| `{d.cars[].qty:add(c.g[id=.brand].sum):set(c.g[id=.brand].sum)}` | ошибка `Forbidden array access in "c.g[id=.brand].sum". Only positive integers are allowed in []` |
| `{d.cars[i].actorId:print(..actors[id=.actorId].name)}` без `{o.preReleaseFeatureIn=…}` | та же ошибка `Forbidden array access in "actors[id=.actorId].name". …` |
| то же с `{o.preReleaseFeatureIn=5002000}` | имя актёра из `actors` (поиск по ключу) |

Точные шаблоны, данные и ожидания — в эталонах (`grep -n '"template".*set(' test/golden/*.json`, `grep -n preReleaseFeatureIn test/golden/matrix.json`).

- [ ] **Step 1: Тесты (падают)** — `describe('EE: set и c.', …)`, по `it` на строку таблицы, данные — из эталонов.

- [ ] **Step 2: Предварительный проход `lib/set.js`**

Вызывается из `builder.buildXML` после `parser.findMarkers` (builder.js:~30) и до `parser.preprocessMarkers`:
1. Отделить маркеры, в цепочке которых есть `:set(`; из списка маркеров их убрать (плейсхолдеры `￿` удаляет `splitXml`), они ничего не печатают.
2. Для каждого по порядку документа: разобрать цель `c.<seg>(.<seg>)*`, где `seg = name | name[] | name[key=.field]`.
3. Источник: `d.a[]` (и вложенные `d.a[].b[]`) — «для каждого элемента», `d.x` — одно значение. Для итерации переиспользовать движок: собрать синтетический XML `{d.cars[i].qty:add(c.total):__set(<k>)}{d.cars[i+1].qty}` и прогнать обычным `buildXML` с теми же опциями — циклы, фильтры и аргументы `.field` работают сами. `__set` — внутренний форматтер (не регистрируется в публичном реестре, имя с `__`): пишет в `this.complement` по цели `k`, для ключей `.brand` берёт текущий элемент `this.parentsData[0]`, возвращает `''`.
4. Семантика цели: `x[]` — добавить новый элемент; `x[key=.f]` — найти или создать элемент `{key: item.f}`; последний сегмент присваивает; для `rows[]` добавляется само значение.
5. Особенность EE: если у цели нет `[]`, а источник итерирует (`d.cars[]…`), цепочка один раз применяется к **первому** элементу до цикла (даёт `14` вместо `11`).
6. `c` общий для всех файлов одного рендера (`options.complement`); колонтитул, обработанный раньше `document.xml`, не видит значений, записанных в `document.xml`, — ограничение, записать в `NOTICE.md` (раздел «Отличия»).

- [ ] **Step 3: Пути `c.` и поиск в аргументах (`getInjectedVariable`)**

Аргумент без кавычек `^c\.` → значение `helper.getValueOfPath(<корень>, 'c.…')` в момент выполнения. Путь аргумента с `[…]`, где внутри не положительное целое, — ошибка `Forbidden array access in "<путь>". Only positive integers are allowed in []`, кроме случая `options.preReleaseFeatureIn >= 5002000` — тогда `[key=.field]` ищет элемент по ключу (для `..actors[id=.actorId].name` — в родительских данных).

- [ ] **Step 4: Итоговая сверка**

```bash
cd /Users/sam/carbone-reports/packages/carbone
for tz in UTC Europe/Paris Asia/Yekaterinburg; do TZ=$tz npx mocha test --timeout 20000 --exit 2>&1 | grep -E "passing|failing|pending"; done
node -e "console.log(require('./test/golden/known-gaps.json').ids.length)"   # 0
```

Оставшиеся расхождения, которые нельзя закрыть (например, `hideBegin` в конце предыдущей строки таблицы — `Missing at least one showEnd or hideEnd`), — перенести из `known-gaps.json` в эталон как `deviation: { ours: '<что выдаёт сборка>', why: '<почему>' }` и перечислить в отчёте; для `help/*` расхождений быть не должно. В итоге `known-gaps.json` → `{ "comment": "…", "ids": [] }`.

- [ ] **Step 5: Коммит**

```bash
cd /Users/sam/carbone-reports && pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add packages/carbone
git commit -m "feat(carbone): :set with grouping and EE accumulator quirk, c. paths and keyed lookup in arguments; all EE goldens match

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `pnpm help:check` через пакет; тесты пакета в CI

**Files:**
- Modify: `scripts/help-check.ts` (живая проверка через `renderBuffer`)
- Modify: `package.json` (корень: devDependency `@carbone-reports/carbone`), `pnpm-lock.yaml`
- Modify: `README.md` (раздел про `help:check`, ~строка 488)

**Interfaces:**
- Consumes: `renderBuffer` (`index.d.ts`), `communityErrorMessage` (`apps/api/src/modules/carbone/community.ts`).
- Produces: `pnpm help:check` работает без поднятого стека; CI-задача `checks` (`pnpm test` → `pnpm -r test`) уже запускает `pnpm --filter @carbone-reports/carbone test` — проверить, что это так (скрипт `test` пакета из Task 1).

- [ ] **Step 1: Подключить пакет к корню**

В корневой `package.json` в `devDependencies` добавить `"@carbone-reports/carbone": "workspace:*"` (рядом с `@carbone-reports/shared`), затем `pnpm install`.

- [ ] **Step 2: Заменить живую проверку**

В `scripts/help-check.ts` удалить `RUNNER` (~156-200) и `execFileSync` (~208-243). Новая живая проверка:

```ts
import carbone from '@carbone-reports/carbone';

async function liveCheck(examples: HelpExample[]): Promise<number> {
  const timezone = process.env.TZ ?? 'Europe/Moscow';
  let failed = 0;
  for (const e of examples) {
    let got: string;
    try {
      const out = await carbone.renderBuffer(await buildDocx(e.template), 'docx', JSON.parse(e.data), {
        lang: CARBONE_LANG,
        timezone,
      });
      got = e.unavailable ? 'нет ошибки' : (await docxText(out)) || 'пустой текст документа';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      got = e.unavailable
        ? (communityErrorMessage(message) ?? `другая ошибка: ${message}`)
        : `ошибка: ${message}`;
    }
    if (got !== e.result) {
      failed++;
      console.error(`✗ ${e.id}\n  ждали: ${e.result}\n  вышло: ${got}`);
    }
  }
  return failed;
}
```

Сохранить существующие форму вывода, `--self-test` и код выхода (сверить с текущим кодом: имена `buildDocx`, `docxText`, `HelpExample` — те, что в файле). Комментарий в начале файла: «рендер каждого примера встроенной сборкой Carbone (`packages/carbone`) так же, как API». Если TS не видит default-импорт CommonJS-пакета — проверить `esModuleInterop`/`allowSyntheticDefaultImports` в `scripts/tsconfig.json`; при необходимости `import { createRequire } from 'node:module'` и `createRequire(import.meta.url)('@carbone-reports/carbone')` с типом из `index.d.ts`.

- [ ] **Step 3: Прогон**

```bash
cd /Users/sam/carbone-reports && export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH
pnpm help:check
pnpm help:check -- --self-test
```

Expected: все 44 примера совпадают, код выхода 0.

- [ ] **Step 4: README**

Абзац про `pnpm help:check` (~488): проверка идёт встроенной сборкой Carbone без поднятого стека.

- [ ] **Step 5: Коммит**

```bash
pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add scripts/help-check.ts package.json pnpm-lock.yaml README.md
git commit -m "feat(scripts): help:check renders with the embedded Carbone build, no running stack needed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Пул потоков рендера в API

**Files:**
- Create: `apps/api/src/modules/render/pool.ts`, `apps/api/src/modules/render/worker.ts`, `apps/api/src/modules/render/worker-url.ts`
- Create: `apps/api/src/modules/render/pool.test.ts`, `apps/api/src/modules/render/test-workers/fake-render.mjs`
- Modify: `apps/api/package.json` (dependency `"@carbone-reports/carbone": "workspace:*"`), `pnpm-lock.yaml`
- Modify: `apps/api/tsup.config.ts` (вторая точка входа), `docker/api.Dockerfile`, `docker/web.Dockerfile`, `docker/backup/Dockerfile` (копирование `packages/carbone`)

**Interfaces:**
- Consumes: `renderBuffer` (Task 2).
- Produces (используют Tasks 11–12):
  - `class RenderPool { constructor(opts: RenderPoolOptions); run(job: RenderJob, deadlineAt: number): Promise<Buffer>; destroy(): Promise<void> }`
  - `interface RenderJob { template: Buffer; ext: string; data: unknown; options: { lang: string; timezone: string } }`
  - `interface RenderPoolOptions { size: number; workerUrl: URL; execArgv?: string[]; resourceLimits?: ResourceLimits; onCrash?(err: unknown): void }`
  - ошибки: `RenderTimeoutError` (срок истёк в очереди или в потоке), `RenderCrashError` (поток упал или пул остановлен), `TemplateRenderError` (текст Carbone в `message`).
  - `renderWorkerUrl(): { url: URL; execArgv?: string[] }` — путь к потоку в dev (`worker.ts` под tsx) и в prod (`dist/render-worker.js`).
  - Протокол потока: вход `{ id: number; template: Uint8Array; ext: string; data: string /* JSON */; options }`, ответ `{ id; ok: true; out: Uint8Array } | { id; ok: false; message: string }`. Данные передаются JSON-строкой — как раньше по HTTP (даты → ISO-строки).

- [ ] **Step 1: Фикстура потока для тестов**

`apps/api/src/modules/render/test-workers/fake-render.mjs` — поведение задаётся данными (`data` — JSON-строка `{ "mode": … }`):

```js
// Тестовый поток пула: вместо Carbone ведёт себя по data.mode.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (m) => {
  const { mode, ms } = JSON.parse(m.data);
  const reply = () => {
    const out = new Uint8Array(m.template.byteLength + 1);
    out.set(m.template);
    out[out.length - 1] = 0x21; // «!» — признак, что поток обработал шаблон
    parentPort.postMessage({ id: m.id, ok: true, out }, [out.buffer]);
  };
  if (mode === 'echo') reply();
  else if (mode === 'slow') setTimeout(reply, ms);
  else if (mode === 'hang') setInterval(() => {}, 1000);
  else if (mode === 'fail') parentPort.postMessage({ id: m.id, ok: false, message: 'Formatter "x" does not exist' });
  else if (mode === 'crash') process.exit(3);
});
```

- [ ] **Step 2: Тесты пула (падают)**

`apps/api/src/modules/render/pool.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { RenderCrashError, RenderPool, RenderTimeoutError, TemplateRenderError } from './pool';

const workerUrl = new URL('./test-workers/fake-render.mjs', import.meta.url);
const job = (mode: string, ms = 0) => ({
  template: Buffer.from('tpl'),
  ext: 'docx',
  data: { mode, ms },
  options: { lang: 'ru', timezone: 'Europe/Moscow' },
});
const soon = (ms: number) => Date.now() + ms;

let pool: RenderPool | undefined;
afterEach(async () => {
  await pool?.destroy();
  pool = undefined;
});

describe('RenderPool', () => {
  it('возвращает результат потока', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    expect((await pool.run(job('echo'), soon(5000))).toString()).toBe('tpl!');
  });

  it('ошибка шаблона — TemplateRenderError с текстом Carbone', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    await expect(pool.run(job('fail'), soon(5000))).rejects.toThrow(TemplateRenderError);
    await expect(pool.run(job('fail'), soon(5000))).rejects.toThrow('Formatter "x" does not exist');
  });

  it('срок истёк в потоке — RenderTimeoutError, поток пересоздан, следующий отчёт строится', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    await expect(pool.run(job('hang'), soon(200))).rejects.toThrow(RenderTimeoutError);
    expect((await pool.run(job('echo'), soon(5000))).toString()).toBe('tpl!');
  });

  it('упавший поток — RenderCrashError, пул продолжает работать', async () => {
    const crashes: unknown[] = [];
    pool = new RenderPool({ size: 1, workerUrl, onCrash: (e) => crashes.push(e) });
    await expect(pool.run(job('crash'), soon(5000))).rejects.toThrow(RenderCrashError);
    expect(crashes).toHaveLength(1);
    expect((await pool.run(job('echo'), soon(5000))).toString()).toBe('tpl!');
  });

  it('задач больше, чем потоков: лишние ждут в очереди', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    const a = pool.run(job('slow', 150), soon(5000));
    const b = pool.run(job('echo'), soon(5000));
    expect((await a).toString()).toBe('tpl!');
    expect((await b).toString()).toBe('tpl!');
  });

  it('срок истёк в очереди — RenderTimeoutError без запуска, занятый поток не трогается', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    const slow = pool.run(job('slow', 400), soon(5000));
    const t0 = Date.now();
    await expect(pool.run(job('echo'), soon(100))).rejects.toThrow(RenderTimeoutError);
    expect(Date.now() - t0).toBeLessThan(350);
    expect((await slow).toString()).toBe('tpl!');
  });

  it('срок уже истёк — отказ сразу', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    await expect(pool.run(job('echo'), Date.now() - 1)).rejects.toThrow(RenderTimeoutError);
  });

  it('destroy отклоняет ожидающие задачи', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    const running = pool.run(job('hang'), soon(5000));
    const queued = pool.run(job('echo'), soon(5000));
    await pool.destroy();
    await expect(running).rejects.toThrow(RenderCrashError);
    await expect(queued).rejects.toThrow(RenderCrashError);
    pool = undefined;
  });

  it('буфер шаблона из общего пула Node не отсоединяется', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    const neighbour = Buffer.from('сосед');
    const template = Buffer.from('tpl'); // маленькие Buffer.from делят общий ArrayBuffer
    await pool.run({ ...job('echo'), template }, soon(5000));
    expect(neighbour.toString()).toBe('сосед');
    expect(template.toString()).toBe('tpl');
  });
});
```

Run: `cd apps/api && pnpm exec vitest run src/modules/render/pool.test.ts` → FAIL (нет модуля).

- [ ] **Step 3: `pool.ts`**

```ts
import { Worker, type ResourceLimits } from 'node:worker_threads';

export interface RenderJob {
  template: Buffer;
  ext: string;
  data: unknown;
  options: { lang: string; timezone: string };
}

export interface RenderPoolOptions {
  size: number;
  workerUrl: URL;
  execArgv?: string[];
  resourceLimits?: ResourceLimits;
  /** Аварийное завершение потока — для журнала. */
  onCrash?(err: unknown): void;
}

/** Срок рендера истёк — в очереди или в потоке. */
export class RenderTimeoutError extends Error {
  constructor() {
    super('превышено время ожидания');
  }
}

/** Поток завершился аварийно или пул остановлен. */
export class RenderCrashError extends Error {}

/** Ошибка шаблона: message — текст Carbone. */
export class TemplateRenderError extends Error {}

type Reply = { id: number; ok: true; out: Uint8Array } | { id: number; ok: false; message: string };

interface Task {
  id: number;
  job: RenderJob;
  deadlineAt: number;
  resolve(out: Buffer): void;
  reject(err: Error): void;
  timer?: NodeJS.Timeout;
}

interface Slot {
  worker: Worker;
  task: Task | null;
}

/**
 * Пул worker_threads для Carbone: сборка отчёта не блокирует основной поток API.
 * Поток, не уложившийся в срок, останавливается и пересоздаётся; срок тикает и в очереди.
 */
export class RenderPool {
  private slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private seq = 0;
  private closed = false;

  constructor(private readonly opts: RenderPoolOptions) {
    for (let i = 0; i < opts.size; i++) this.slots.push(this.spawn());
  }

  run(job: RenderJob, deadlineAt: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (this.closed) return reject(new RenderCrashError('пул рендера остановлен'));
      const wait = deadlineAt - Date.now();
      if (wait <= 0) return reject(new RenderTimeoutError());
      const task: Task = { id: ++this.seq, job, deadlineAt, resolve, reject };
      task.timer = setTimeout(() => this.expireQueued(task), wait);
      this.queue.push(task);
      this.dispatch();
    });
  }

  async destroy(): Promise<void> {
    this.closed = true;
    const stopped = new RenderCrashError('пул рендера остановлен');
    for (const t of this.queue.splice(0)) {
      clearTimeout(t.timer);
      t.reject(stopped);
    }
    const slots = this.slots;
    this.slots = [];
    for (const s of slots) {
      if (s.task) {
        clearTimeout(s.task.timer);
        s.task.reject(stopped);
        s.task = null;
      }
    }
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }

  private spawn(): Slot {
    const worker = new Worker(this.opts.workerUrl, {
      execArgv: this.opts.execArgv,
      resourceLimits: this.opts.resourceLimits,
    });
    const slot: Slot = { worker, task: null };
    worker.on('message', (m: Reply) => this.finish(slot, m));
    worker.on('error', (err) => this.crash(slot, err));
    worker.on('exit', (code) => this.crash(slot, new Error(`поток рендера завершился с кодом ${code}`)));
    return slot;
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.task) continue;
      const task = this.queue.shift();
      if (!task) return;
      this.start(slot, task);
    }
  }

  private start(slot: Slot, task: Task): void {
    clearTimeout(task.timer);
    slot.task = task;
    // Копия: Buffer из общего пула Node делит ArrayBuffer с другими буферами, передача отсоединила бы их.
    const template = new Uint8Array(task.job.template);
    slot.worker.postMessage(
      {
        id: task.id,
        template,
        ext: task.job.ext,
        data: JSON.stringify(task.job.data),
        options: task.job.options,
      },
      [template.buffer],
    );
    task.timer = setTimeout(() => this.timeout(slot, task), Math.max(0, task.deadlineAt - Date.now()));
  }

  private finish(slot: Slot, m: Reply): void {
    const task = slot.task;
    if (!task || task.id !== m.id) return;
    clearTimeout(task.timer);
    slot.task = null;
    if (m.ok) task.resolve(Buffer.from(m.out.buffer, m.out.byteOffset, m.out.byteLength));
    else task.reject(new TemplateRenderError(m.message));
    this.dispatch();
  }

  private timeout(slot: Slot, task: Task): void {
    if (slot.task !== task) return;
    slot.task = null;
    this.replace(slot);
    task.reject(new RenderTimeoutError());
    this.dispatch();
  }

  private crash(slot: Slot, err: unknown): void {
    if (this.closed || !this.slots.includes(slot)) return;
    const task = slot.task;
    slot.task = null;
    this.replace(slot);
    if (task) {
      clearTimeout(task.timer);
      this.opts.onCrash?.(err);
      task.reject(new RenderCrashError('поток рендера завершился аварийно'));
    }
    this.dispatch();
  }

  private replace(slot: Slot): void {
    const i = this.slots.indexOf(slot);
    if (i < 0) return;
    slot.worker.removeAllListeners();
    void slot.worker.terminate();
    this.slots[i] = this.spawn();
  }

  private expireQueued(task: Task): void {
    const i = this.queue.indexOf(task);
    if (i < 0) return;
    this.queue.splice(i, 1);
    task.reject(new RenderTimeoutError());
  }
}
```

Примечание: `removeAllListeners` перед `terminate` нужен, чтобы событие `exit` остановленного потока не засчиталось как авария. Поток, упавший без задачи (`crash` при `task === null`), просто пересоздаётся.

- [ ] **Step 4: Тесты пула зелёные**

Run: `cd apps/api && pnpm exec vitest run src/modules/render/pool.test.ts` → 9 passed.

- [ ] **Step 5: Поток `worker.ts` и путь к нему**

`apps/api/src/modules/render/worker.ts`:

```ts
// Поток пула рендера: собирает отчёт встроенной сборкой Carbone (формат шаблона).
import { parentPort } from 'node:worker_threads';
import carbone from '@carbone-reports/carbone';

interface Request {
  id: number;
  template: Uint8Array;
  ext: string;
  data: string;
  options: { lang: string; timezone: string };
}

const port = parentPort;
if (!port) throw new Error('worker.ts запускается только как поток пула рендера');

port.on('message', (m: Request) => {
  const template = Buffer.from(m.template.buffer, m.template.byteOffset, m.template.byteLength);
  carbone.renderBuffer(template, m.ext, JSON.parse(m.data), m.options).then(
    (out) => {
      const copy = new Uint8Array(out.byteLength);
      copy.set(out);
      port.postMessage({ id: m.id, ok: true, out: copy }, [copy.buffer]);
    },
    (err: unknown) => {
      port.postMessage({ id: m.id, ok: false, message: err instanceof Error ? err.message : String(err) });
    },
  );
});
```

`apps/api/src/modules/render/worker-url.ts`:

```ts
/**
 * Путь к потоку рендера. В prod tsup собирает его в dist/render-worker.js рядом с dist/server.js
 * (этот модуль вшит в server.js); в dev (tsx) — исходник worker.ts, загрузчик tsx передаётся потоку.
 */
export function renderWorkerUrl(): { url: URL; execArgv?: string[] } {
  if (import.meta.url.endsWith('.ts')) {
    return { url: new URL('./worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] };
  }
  return { url: new URL('./render-worker.js', import.meta.url) };
}
```

Если default-импорт CommonJS-пакета не проходит `tsc` (`verbatimModuleSyntax`), использовать `import carbone = require('@carbone-reports/carbone')` нельзя в ESM — тогда `import * as carbone from '@carbone-reports/carbone'` с проверкой, что `renderBuffer` доступен в рантайме (`node -e "import('@carbone-reports/carbone').then(m=>console.log(typeof m.default.renderBuffer, typeof m.renderBuffer))"`), и выбрать рабочую форму.

- [ ] **Step 6: Зависимость, tsup, Dockerfile**

- `apps/api/package.json` → `dependencies`: `"@carbone-reports/carbone": "workspace:*"`; `pnpm install`.
- `apps/api/tsup.config.ts`: `entry: { server: 'src/server.ts', 'render-worker': 'src/modules/render/worker.ts' }`; `@carbone-reports/carbone` не добавлять в `noExternal` (CommonJS с `new Function` и десятками `require` локалей dayjs — грузится из `node_modules`).
- `docker/api.Dockerfile`: рядом с `COPY packages/shared/package.json packages/shared/` добавить `COPY packages/carbone/package.json packages/carbone/`; перед сборкой рядом с `COPY packages/shared packages/shared` — `COPY packages/carbone packages/carbone`.
- `docker/web.Dockerfile` и `docker/backup/Dockerfile`: добавить `COPY packages/carbone/package.json packages/carbone/` рядом с остальными `package.json` (замороженный lockfile проверяется по всем участникам workspace).
- `.dockerignore`: убедиться, что `packages/carbone/test` не тащит в образ api ничего лишнего — `pnpm deploy --prod --legacy` копирует пакет по полю `files` (Task 1), проверить в шаге 7.

- [ ] **Step 7: Проверка сборки и потока в prod-образе**

```bash
cd /Users/sam/carbone-reports && export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH
pnpm --filter @carbone-reports/api build && ls apps/api/dist   # server.js, render-worker.js
df -h / | tail -1   # нужно ≥ 2 ГиБ
docker build -f docker/api.Dockerfile --target prod -t carbone-reports-api:p17 .
docker run --rm --entrypoint node carbone-reports-api:p17 -e "const {Worker}=require('node:worker_threads'); const w=new Worker('/app/dist/render-worker.js'); w.on('online',()=>{console.log('worker ok'); w.terminate()}); w.on('error',e=>{console.error(e); process.exit(1)})"
docker run --rm --entrypoint sh carbone-reports-api:p17 -c "ls /app/node_modules/@carbone-reports/carbone && test ! -d /app/node_modules/@carbone-reports/carbone/test && echo 'без тестов'"
docker rmi carbone-reports-api:p17
docker builder prune -f >/dev/null   # кэш сборки этого проекта, разрешено после пересборки
```

Expected: `worker ok`, список `lib formatters index.d.ts LICENSE.md NOTICE.md package.json`, `без тестов`. Если путь `/app/dist/...` или `--target prod` отличается — взять из `docker/api.Dockerfile`. Если `CMD`-образ использует ESM и `-e` с `require` не работает — `--input-type=module` и `import`.

- [ ] **Step 8: Проверки и коммит**

```bash
pnpm exec prettier --check . && pnpm lint && pnpm typecheck && pnpm --filter @carbone-reports/api test
git add apps/api docker pnpm-lock.yaml
git commit -m "feat(api): worker_threads render pool on the embedded Carbone build

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Разовые ссылки на файлы и клиент конвертации OnlyOffice

**Files:**
- Create: `apps/api/src/modules/render/handoff.ts`, `handoff.test.ts`
- Create: `apps/api/src/modules/render/routes.ts`
- Create: `apps/api/src/modules/render/onlyoffice-convert.ts`, `onlyoffice-convert.test.ts`

**Interfaces:**
- Consumes: `signOnlyOffice` (`modules/onlyoffice/jwt.ts`), `toInternalDownloadUrl` (`modules/onlyoffice/download-url.ts`), `AppError` (`lib/errors.ts`), `MIME` (`lib/http.ts`).
- Produces:
  - `interface RenderHandoff { put(file: Buffer, ext: TemplateExt, deadlineAt: number): Promise<{ id: string; token: string }>; take(id: string, token: string): Promise<{ file: Buffer; ext: TemplateExt } | 'forbidden' | 'gone'>; remove(id: string): void; close(): void }`
  - `createRenderHandoff(secret: Uint8Array): RenderHandoff`
  - `registerRenderRoutes(app: FastifyInstance, deps: AppDeps): void` — `GET /internal/render-files/:id?t=`; использует `deps.renderFiles`.
  - `type Converter = (req: { filetype: TemplateExt; outputtype: OutputFormat; title: string; url: string; signal: AbortSignal }) => Promise<Buffer>`
  - `createOnlyOfficeConverter(opts: { baseUrl: string; secret: Uint8Array; fetch?: typeof fetch; maxBytes?: number }): Converter`
  - `AppDeps.renderFiles: RenderHandoff` — новое поле (добавляет Task 11 вместе с подключением).

- [ ] **Step 1: Тесты handoff (падают)**

`apps/api/src/modules/render/handoff.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderHandoff, type RenderHandoff } from './handoff';

const secret = new TextEncoder().encode('x'.repeat(32));
const other = new TextEncoder().encode('y'.repeat(32));
let h: RenderHandoff;
afterEach(() => {
  h?.close();
  vi.useRealTimers();
});

describe('RenderHandoff', () => {
  it('выдаёт файл по токену один раз', async () => {
    h = createRenderHandoff(secret);
    const { id, token } = await h.put(Buffer.from('PK..'), 'docx', Date.now() + 10_000);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const got = await h.take(id, token);
    expect(got).toEqual({ file: Buffer.from('PK..'), ext: 'docx' });
    expect(await h.take(id, token)).toBe('gone');
  });

  it('чужой токен, токен другого файла или подпись другим ключом — forbidden, файл остаётся', async () => {
    h = createRenderHandoff(secret);
    const a = await h.put(Buffer.from('a'), 'docx', Date.now() + 10_000);
    const b = await h.put(Buffer.from('b'), 'docx', Date.now() + 10_000);
    expect(await h.take(a.id, b.token)).toBe('forbidden');
    expect(await h.take(a.id, 'мусор')).toBe('forbidden');
    const forged = createRenderHandoff(other);
    const f = await forged.put(Buffer.from('f'), 'docx', Date.now() + 10_000);
    expect(await h.take(a.id, f.token)).toBe('forbidden');
    forged.close();
    expect(await h.take(a.id, a.token)).toEqual({ file: Buffer.from('a'), ext: 'docx' });
  });

  it('по сроку файл удаляется сам', async () => {
    vi.useFakeTimers();
    h = createRenderHandoff(secret);
    const { id, token } = await h.put(Buffer.from('a'), 'docx', Date.now() + 1_000);
    vi.advanceTimersByTime(1_001);
    expect(await h.take(id, token)).toBe('gone');
  });

  it('remove удаляет файл до выдачи', async () => {
    h = createRenderHandoff(secret);
    const { id, token } = await h.put(Buffer.from('a'), 'docx', Date.now() + 10_000);
    h.remove(id);
    expect(await h.take(id, token)).toBe('gone');
  });
});
```

- [ ] **Step 2: `handoff.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { TemplateExt } from '@carbone-reports/shared';
import { jwtVerify, SignJWT } from 'jose';

const AUDIENCE = 'render-file';

export interface RenderHandoff {
  put(file: Buffer, ext: TemplateExt, deadlineAt: number): Promise<{ id: string; token: string }>;
  take(id: string, token: string): Promise<{ file: Buffer; ext: TemplateExt } | 'forbidden' | 'gone'>;
  remove(id: string): void;
  close(): void;
}

interface Entry {
  file: Buffer;
  ext: TemplateExt;
  timer: NodeJS.Timeout;
}

/**
 * Файлы для Document Server в памяти этой реплики: ссылка разовая, подписана APP_SECRET,
 * живёт не дольше срока рендера. Ссылка ведёт на API_SELF_URL — адрес именно этой реплики.
 */
export function createRenderHandoff(secret: Uint8Array): RenderHandoff {
  const files = new Map<string, Entry>();
  const remove = (id: string) => {
    const e = files.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    files.delete(id);
  };
  return {
    async put(file, ext, deadlineAt) {
      const id = randomUUID().replaceAll('-', '');
      const timer = setTimeout(() => files.delete(id), Math.max(0, deadlineAt - Date.now()));
      timer.unref();
      files.set(id, { file, ext, timer });
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(id)
        .setAudience(AUDIENCE)
        .setExpirationTime(Math.ceil(deadlineAt / 1000))
        .sign(secret);
      return { id, token };
    },
    async take(id, token) {
      try {
        await jwtVerify(token, secret, { algorithms: ['HS256'], subject: id, audience: AUDIENCE });
      } catch {
        return 'forbidden';
      }
      const e = files.get(id);
      if (!e) return 'gone';
      remove(id);
      return { file: e.file, ext: e.ext };
    },
    remove,
    close() {
      for (const id of [...files.keys()]) remove(id);
    },
  };
}
```

Run: `pnpm exec vitest run src/modules/render/handoff.test.ts` → 4 passed.

- [ ] **Step 3: Маршрут `routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { MIME } from '../../lib/http';

/** Разовая выдача собранного отчёта Document Server для конвертации. Снаружи /internal/* закрыт в nginx. */
export function registerRenderRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    '/internal/render-files/:id',
    {
      schema: {
        params: z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }),
        querystring: z.object({ t: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const got = await deps.renderFiles.take(req.params.id, req.query.t ?? '');
      if (got === 'forbidden') throw new AppError('FORBIDDEN', 403, 'неверный токен файла');
      if (got === 'gone') throw new AppError('NOT_FOUND', 404, 'файл уже выдан или устарел');
      return reply.header('content-type', MIME[got.ext]).send(got.file);
    },
  );
}
```

Сверить имена схем/типов с соседним `modules/onlyoffice/routes.ts` (как там подключён zod-провайдер Fastify) и сделать так же. Тест маршрута — в Task 11 (там он подключается в `buildApp`).

- [ ] **Step 4: Тесты клиента конвертации (падают)**

`apps/api/src/modules/render/onlyoffice-convert.test.ts` (стиль — как `modules/onlyoffice/commands.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { verifyOnlyOffice } from '../onlyoffice/jwt';
import { createOnlyOfficeConverter } from './onlyoffice-convert';

const secret = new TextEncoder().encode('s'.repeat(32));
const BASE = 'http://onlyoffice';
const req = (signal = AbortSignal.timeout(5000)) => ({
  filetype: 'docx' as const,
  outputtype: 'pdf' as const,
  title: 'report.docx',
  url: 'http://10.0.0.5:3000/internal/render-files/abc?t=tok',
  signal,
});

function fake(converter: unknown, file: Response | (() => Response) = new Response('%PDF-1.7 ok')) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/converter')) {
      return converter instanceof Response ? converter : Response.json(converter);
    }
    return typeof file === 'function' ? file() : file;
  }) as typeof fetch;
  return { fn, calls };
}

describe('createOnlyOfficeConverter', () => {
  it('тело запроса, JWT тела, accept json, скачивание результата по внутреннему адресу', async () => {
    const { fn, calls } = fake({ endConvert: true, fileUrl: 'https://reports.example/onlyoffice/cache/files/data/k/output.pdf?md5=1&expires=2', percent: 100 });
    const out = await createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req());
    expect(out.toString()).toBe('%PDF-1.7 ok');
    expect(calls[0]!.url).toBe('http://onlyoffice/converter');
    expect(new Headers(calls[0]!.init!.headers).get('accept')).toBe('application/json');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({ async: false, filetype: 'docx', outputtype: 'pdf', title: 'report.docx', region: 'ru-RU', url: req().url });
    expect(body.key).toMatch(/^[0-9a-f]{32}$/);
    const { token, ...rest } = body;
    expect(await verifyOnlyOffice(token, secret)).toMatchObject(rest);
    expect(calls[1]!.url).toBe('http://onlyoffice/cache/files/data/k/output.pdf?md5=1&expires=2');
  });

  it('ключ новый на каждый вызов', async () => {
    const { fn, calls } = fake({ endConvert: true, fileUrl: 'http://x/cache/files/a/output.pdf' });
    const convert = createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn });
    await convert(req());
    await convert(req());
    const keys = calls.filter((c) => c.url.endsWith('/converter')).map((c) => JSON.parse(String(c.init!.body)).key);
    expect(new Set(keys).size).toBe(2);
  });

  it('error: -4 — CONVERT_ERROR «ошибка конвертации (код -4)»', async () => {
    const { fn } = fake({ error: -4 });
    await expect(createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req())).rejects.toMatchObject({
      code: 'CONVERT_ERROR',
      status: 502,
      message: 'ошибка конвертации (код -4)',
    });
  });

  it('Document Server недоступен — CONVERT_ERROR «сервис конвертации недоступен»', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req())).rejects.toMatchObject({
      code: 'CONVERT_ERROR',
      message: 'сервис конвертации недоступен',
    });
  });

  it('HTTP 500 или не JSON — «сервис конвертации недоступен»', async () => {
    const { fn } = fake(new Response('<xml/>', { status: 500 }));
    await expect(createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req())).rejects.toMatchObject({
      message: 'сервис конвертации недоступен',
    });
  });

  it('адрес результата не из /cache/files/ — ошибка, файл не скачивается', async () => {
    const { fn, calls } = fake({ endConvert: true, fileUrl: 'http://evil/other' });
    await expect(createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req())).rejects.toMatchObject({
      code: 'CONVERT_ERROR',
    });
    expect(calls).toHaveLength(1);
  });

  it('результат больше лимита — ошибка', async () => {
    const { fn } = fake({ endConvert: true, fileUrl: 'http://x/cache/files/a/output.pdf' }, new Response('%PDF' + 'x'.repeat(100)));
    await expect(createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn, maxBytes: 50 })(req())).rejects.toMatchObject({
      code: 'CONVERT_ERROR',
    });
  });

  it('прерывание по сроку — TIMEOUT', async () => {
    const ctrl = new AbortController();
    const fn = (async (_u: string | URL, init?: RequestInit) => {
      ctrl.abort();
      throw init?.signal?.reason ?? new Error('aborted');
    }) as typeof fetch;
    await expect(createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req(ctrl.signal))).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 504,
    });
  });
});
```

- [ ] **Step 5: `onlyoffice-convert.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { OutputFormat, TemplateExt } from '@carbone-reports/shared';
import { AppError } from '../../lib/errors';
import { toInternalDownloadUrl } from '../onlyoffice/download-url';
import { signOnlyOffice } from '../onlyoffice/jwt';

export interface ConvertRequest {
  filetype: TemplateExt;
  outputtype: OutputFormat;
  title: string;
  url: string;
  signal: AbortSignal;
}

export type Converter = (req: ConvertRequest) => Promise<Buffer>;

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

const unavailable = (cause?: unknown) =>
  new AppError('CONVERT_ERROR', 502, 'сервис конвертации недоступен', undefined, cause);
const failed = (code: number) => new AppError('CONVERT_ERROR', 502, `ошибка конвертации (код ${code})`);
const timeout = () => new AppError('TIMEOUT', 504, 'превышено время ожидания');

/** Перевод отчёта в другой формат через Conversion API Document Server (POST /converter). */
export function createOnlyOfficeConverter(opts: {
  baseUrl: string;
  secret: Uint8Array;
  fetch?: typeof fetch;
  maxBytes?: number;
}): Converter {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return async (req) => {
    const body = {
      async: false,
      filetype: req.filetype,
      outputtype: req.outputtype,
      // Document Server кэширует результат по ключу: новый ключ на каждый вызов.
      key: randomUUID().replaceAll('-', ''),
      title: req.title,
      url: req.url,
      region: 'ru-RU',
    };
    let reply: { endConvert?: boolean; fileUrl?: string; error?: number };
    try {
      const res = await doFetch(`${base}/converter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...body, token: await signOnlyOffice(body, opts.secret) }),
        signal: req.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      reply = (await res.json()) as typeof reply;
    } catch (e) {
      if (req.signal.aborted) throw timeout();
      throw unavailable(e);
    }
    if (typeof reply.error === 'number' && reply.error < 0) throw failed(reply.error);
    if (reply.endConvert !== true || !reply.fileUrl) throw failed(-1);
    const internal = toInternalDownloadUrl(reply.fileUrl, base);
    if (!internal) throw failed(-1);
    return download(doFetch, internal, req.signal, maxBytes);
  };
}

async function download(doFetch: typeof fetch, url: string, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
  try {
    const res = await doFetch(url, { redirect: 'error', signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('результат конвертации больше лимита');
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  } catch (e) {
    if (signal.aborted) throw timeout();
    throw unavailable(e);
  }
}
```

Если тест «больше лимита» ждёт `CONVERT_ERROR`, а сообщение «сервис конвертации недоступен» кажется неверным для этого случая — допустимо; код ошибки важнее (сообщение для пользователя общее). Проверить, что `toInternalDownloadUrl` принимает базу без `/` на конце (см. `download-url.ts`).

- [ ] **Step 6: Тесты зелёные, проверки, коммит**

```bash
cd /Users/sam/carbone-reports/apps/api && pnpm exec vitest run src/modules/render
cd ../.. && pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add apps/api/src/modules/render
git commit -m "feat(api): one-time in-memory render files for Document Server and OnlyOffice conversion client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Встроенный рендерер в API вместо клиента Carbone EE

**Files:**
- Create: `apps/api/src/modules/render/renderer.ts`, `renderer.test.ts`
- Modify: `apps/api/src/deps.ts` (`renderFiles`), `apps/api/src/server.ts`, `apps/api/src/app.ts` (`registerRenderRoutes`), `apps/api/src/config.ts` (+ `config.test.ts`), `apps/api/test/helpers.ts`
- Delete: `apps/api/src/modules/carbone/client.ts`, `client.test.ts`, `template-cache.ts`, `template-cache.test.ts`
- Modify: `apps/api/test/redis.int.test.ts`, `apps/api/test/reports.int.test.ts`, комментарии в `apps/api/src/modules/reports/snapshot.ts` (~81, 117), `snapshot.test.ts` (~99), `lib/deadline.ts:22`, `lib/run-file-gate.ts:25`, `reports/routes.ts:208`
- Modify: `.env.example` (~34-37)

**Interfaces:**
- Consumes: `RenderPool` и ошибки (Task 9), `RenderHandoff`, `Converter` (Task 10), `communityErrorMessage` (`modules/carbone/community.ts`), `outputFormatsFor` (`@carbone-reports/shared`).
- Produces: `createEmbeddedRenderer(opts: { pool: Pick<RenderPool, 'run'>; handoff: RenderHandoff; convert: Converter; selfUrl: string; log?: { error(obj: object, msg: string): void } }): CarboneRenderer`; `Config.renderWorkers: number`, `Config.apiSelfUrl: string`; `AppDeps.renderFiles: RenderHandoff`.

- [ ] **Step 1: Тесты рендерера (падают)**

`apps/api/src/modules/render/renderer.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TemplateFileRef } from '../../deps';
import { createRenderHandoff } from './handoff';
import { RenderCrashError, RenderTimeoutError, TemplateRenderError } from './pool';
import { createEmbeddedRenderer } from './renderer';

const secret = new TextEncoder().encode('k'.repeat(32));
const tpl = (ext: TemplateFileRef['ext'] = 'docx', read = async () => Buffer.from('TPL')): TemplateFileRef => ({
  id: 't1',
  version: 1,
  ext,
  read,
});
const opts = (convertTo: string, timeoutMs = 5000) => ({ convertTo, lang: 'ru', timezone: 'Europe/Moscow', timeoutMs }) as never;

function setup(run: (job: { template: Buffer }) => Promise<Buffer>) {
  const handoff = createRenderHandoff(secret);
  const convert = vi.fn(async (r: { url: string }) => {
    const u = new URL(r.url);
    const got = await handoff.take(u.pathname.split('/').pop()!, u.searchParams.get('t')!);
    if (typeof got === 'string') throw new Error(got);
    return Buffer.concat([Buffer.from('PDF:'), got.file]);
  });
  const renderer = createEmbeddedRenderer({ pool: { run }, handoff, convert, selfUrl: 'http://10.0.0.5:3000' });
  return { renderer, convert, handoff };
}

describe('createEmbeddedRenderer', () => {
  it('формат шаблона — без OnlyOffice', async () => {
    const { renderer, convert } = setup(async () => Buffer.from('OUT'));
    expect((await renderer.render(tpl(), {}, opts('docx'))).toString()).toBe('OUT');
    expect(convert).not.toHaveBeenCalled();
  });

  it('другой формат — файл отдаётся OnlyOffice по разовой ссылке на свою реплику', async () => {
    const { renderer, convert } = setup(async () => Buffer.from('OUT'));
    expect((await renderer.render(tpl(), {}, opts('pdf'))).toString()).toBe('PDF:OUT');
    const r = convert.mock.calls[0]![0] as { url: string; filetype: string; outputtype: string };
    expect(r.url).toMatch(/^http:\/\/10\.0\.0\.5:3000\/internal\/render-files\/[0-9a-f]{32}\?t=/);
    expect(r).toMatchObject({ filetype: 'docx', outputtype: 'pdf' });
  });

  it('после конвертации файла в памяти не остаётся, даже при ошибке', async () => {
    const { renderer, handoff, convert } = setup(async () => Buffer.from('OUT'));
    const put = vi.spyOn(handoff, 'put');
    convert.mockRejectedValueOnce(new Error('oo'));
    await expect(renderer.render(tpl(), {}, opts('pdf'))).rejects.toThrow();
    const { id, token } = await put.mock.results[0]!.value;
    expect(await handoff.take(id, token)).toBe('gone');
  });

  it('ошибка чтения шаблона пробрасывается как есть', async () => {
    const err = Object.assign(new Error('нет файла'), { code: 'ENOENT' });
    const { renderer } = setup(async () => Buffer.from('OUT'));
    await expect(renderer.render(tpl('docx', async () => { throw err; }), {}, opts('pdf'))).rejects.toBe(err);
  });

  it('отключённая функция — 400 CARBONE_COMMUNITY с именем', async () => {
    const { renderer } = setup(async () => {
      throw new TemplateRenderError('Formatter "aggSum" is disabled in the Community Edition.');
    });
    await expect(renderer.render(tpl(), {}, opts('pdf'))).rejects.toMatchObject({
      code: 'CARBONE_COMMUNITY',
      status: 400,
      message: expect.stringContaining('aggSum'),
    });
  });

  it('другая ошибка шаблона — 502 CARBONE_ERROR с текстом Carbone', async () => {
    const { renderer } = setup(async () => {
      throw new TemplateRenderError('Formatter "fooBar" does not exist. Do you mean "mod"?');
    });
    await expect(renderer.render(tpl(), {}, opts('docx'))).rejects.toMatchObject({
      code: 'CARBONE_ERROR',
      status: 502,
      message: 'ошибка генерации: Formatter "fooBar" does not exist. Do you mean "mod"?',
    });
  });

  it('срок — 504 TIMEOUT; упавший поток — 502 «сервис генерации недоступен»', async () => {
    const t = setup(async () => {
      throw new RenderTimeoutError();
    });
    await expect(t.renderer.render(tpl(), {}, opts('docx'))).rejects.toMatchObject({ code: 'TIMEOUT', status: 504 });
    const c = setup(async () => {
      throw new RenderCrashError('x');
    });
    await expect(c.renderer.render(tpl(), {}, opts('docx'))).rejects.toMatchObject({
      code: 'CARBONE_ERROR',
      status: 502,
      message: 'сервис генерации недоступен',
    });
  });

  it('недопустимая пара форматов — отказ без рендера', async () => {
    const run = vi.fn(async () => Buffer.from('OUT'));
    const { renderer } = setup(run);
    await expect(renderer.render(tpl('pptx'), {}, opts('xlsx'))).rejects.toMatchObject({ status: 400 });
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: `renderer.ts`**

```ts
import { outputFormatsFor } from '@carbone-reports/shared';
import type { CarboneRenderer } from '../../deps';
import { AppError } from '../../lib/errors';
import { communityErrorMessage } from '../carbone/community';
import type { RenderHandoff } from './handoff';
import type { Converter } from './onlyoffice-convert';
import { RenderCrashError, RenderTimeoutError, TemplateRenderError, type RenderPool } from './pool';

const timeout = () => new AppError('TIMEOUT', 504, 'превышено время ожидания');

/**
 * Рендер встроенной сборкой Carbone: поток пула собирает отчёт в формате шаблона;
 * другой формат делает Document Server, забирая файл у этой реплики по разовой ссылке.
 */
export function createEmbeddedRenderer(opts: {
  pool: Pick<RenderPool, 'run'>;
  handoff: RenderHandoff;
  convert: Converter;
  selfUrl: string;
  log?: { error(obj: object, msg: string): void };
}): CarboneRenderer {
  const selfUrl = opts.selfUrl.replace(/\/$/, '');
  return {
    async render(tpl, data, ro) {
      if (!outputFormatsFor(tpl.ext).includes(ro.convertTo)) {
        throw new AppError('BAD_REQUEST', 400, `формат ${ro.convertTo} недоступен для шаблона ${tpl.ext}`);
      }
      const deadlineAt = Date.now() + ro.timeoutMs;
      const template = await tpl.read(); // ошибка чтения — как есть (ENOENT обрабатывают вызывающие)
      let out: Buffer;
      try {
        out = await opts.pool.run(
          { template, ext: tpl.ext, data, options: { lang: ro.lang, timezone: ro.timezone } },
          deadlineAt,
        );
      } catch (e) {
        if (e instanceof RenderTimeoutError) throw timeout();
        if (e instanceof TemplateRenderError) {
          const community = communityErrorMessage(e.message);
          if (community) throw new AppError('CARBONE_COMMUNITY', 400, community);
          throw new AppError('CARBONE_ERROR', 502, `ошибка генерации: ${e.message}`);
        }
        if (e instanceof RenderCrashError) opts.log?.error({ err: e }, 'поток рендера завершился аварийно');
        throw new AppError('CARBONE_ERROR', 502, 'сервис генерации недоступен', undefined, e);
      }
      if (ro.convertTo === tpl.ext) return out;

      const left = deadlineAt - Date.now();
      if (left <= 0) throw timeout();
      const { id, token } = await opts.handoff.put(out, tpl.ext, deadlineAt);
      try {
        return await opts.convert({
          filetype: tpl.ext,
          outputtype: ro.convertTo,
          title: `report.${tpl.ext}`,
          url: `${selfUrl}/internal/render-files/${id}?t=${encodeURIComponent(token)}`,
          signal: AbortSignal.timeout(left),
        });
      } finally {
        opts.handoff.remove(id);
      }
    },
  };
}
```

Run: `pnpm exec vitest run src/modules/render/renderer.test.ts` → 8 passed.

- [ ] **Step 3: Настройки (`config.ts`, `config.test.ts`, `test/helpers.ts`)**

- Удалить `CARBONE_URL` (схема ~15, `Config.carboneUrl` ~173, отображение ~225).
- Добавить в схему по образцу `TRUSTED_PROXY_HOPS` (~21-26):

```ts
API_SELF_URL: z.url().default('http://api:3000'),
RENDER_WORKERS: z.coerce
  .number({ error: 'целое от 1 до 16' })
  .int('целое от 1 до 16')
  .min(1, 'целое от 1 до 16')
  .max(16, 'целое от 1 до 16')
  .optional(),
```

- В `Config`: `apiSelfUrl: string; renderWorkers: number;`. В `loadConfig`: `apiSelfUrl: e.API_SELF_URL.replace(/\/$/, '')`, `renderWorkers: e.RENDER_WORKERS ?? Math.min(4, os.availableParallelism())` (`import os from 'node:os'`).
- `config.test.ts`: вместо проверки `carboneUrl` — значения по умолчанию (`apiSelfUrl === 'http://api:3000'`, `renderWorkers` от 1 до 4), явные значения, ошибка для `RENDER_WORKERS=0` и `17` с текстом `RENDER_WORKERS: целое от 1 до 16`.
- `test/helpers.ts` `testConfig`: убрать `carboneUrl`, добавить `apiSelfUrl: 'http://api:3000'`, `renderWorkers: 1`; в `createTestApp` по умолчанию `renderFiles: createRenderHandoff(config.appSecret)` (и закрывать в `close`, если там есть очистка).

- [ ] **Step 4: Подключение (`deps.ts`, `server.ts`, `app.ts`)**

- `deps.ts`: в `AppDeps` добавить `renderFiles: RenderHandoff;`; комментарий у `redis` про кэш Carbone убрать.
- `app.ts`: `registerRenderRoutes(app, deps);` рядом с `registerOnlyOfficeRoutes` (~97). Проверить `registerMaintenance` (~75): если он отвечает 503 на всё, кроме списка исключений, `/internal/render-files/` в исключения не добавлять — во время восстановления отчёты всё равно не строятся.
- `server.ts`: удалить импорты `CarboneClient`, `redisTemplateCache` и строку создания клиента (~15-16, 47, 67). Создать до `deps`:

```ts
const worker = renderWorkerUrl();
const pool = new RenderPool({
  size: config.renderWorkers,
  workerUrl: worker.url,
  execArgv: worker.execArgv,
  onCrash: (err) => log.error({ err }, 'поток рендера завершился аварийно'),
});
const renderFiles = createRenderHandoff(config.appSecret);
const carbone = createEmbeddedRenderer({
  pool,
  handoff: renderFiles,
  convert: createOnlyOfficeConverter({ baseUrl: config.onlyofficeInternalUrl, secret: config.onlyofficeJwtSecret }),
  selfUrl: config.apiSelfUrl,
  log,
});
```

`log` — тот логгер, что уже используется в `server.ts` до создания приложения (если его нет — передавать `log` позже, как раньше делали `carbone.log = app.log`: сделать у рендерера изменяемое поле `log`). В `deps` — `carbone`, `renderFiles`. В `shutdown()` до `process.exit`: `await pool.destroy(); renderFiles.close();`.

- [ ] **Step 5: Удалить старый клиент и обновить тесты**

```bash
cd /Users/sam/carbone-reports/apps/api
git rm src/modules/carbone/client.ts src/modules/carbone/client.test.ts src/modules/carbone/template-cache.ts src/modules/carbone/template-cache.test.ts
grep -rn "CarboneClient\|redisTemplateCache\|memoryTemplateCache\|carboneUrl\|cr:carbone" src test
```

- `test/redis.int.test.ts`: удалить случаи общего кэша шаблонов Carbone (~67-150 и импорты ~5-9), остальные тесты Redis оставить.
- `test/reports.int.test.ts`: `liveCarbone`/`communityCarbone` (~21-52, ~479) заменить на `createEmbeddedRenderer` с поддельным пулом (`{ run: async () => … }`) и поддельным `convert`, сохранив смысл тестов: (а) отключённая функция → 400 `CARBONE_COMMUNITY` с именем в сообщении через маршрут построения отчёта (Review Focus 5); (б) «preview: не CARBONE_ERROR 502, а 500 INTERNAL» при ошибке чтения файла шаблона.
- Добавить в `test/reports.int.test.ts` проверку маршрута разовой ссылки через `app.inject`: файл, положенный в `deps.renderFiles`, выдаётся по `GET /internal/render-files/:id?t=` с `content-type` шаблона, повторный запрос — 404 `NOT_FOUND`, чужой токен — 403 `FORBIDDEN`, без токена — 403.
- Комментарии про кэш Carbone в `snapshot.ts` (~81, 117), `snapshot.test.ts` (~99: название теста), `lib/deadline.ts:22`, `lib/run-file-gate.ts:25`, `reports/routes.ts:208` — переписать без упоминания HTTP-сервиса Carbone и кэша шаблонов.
- `.env.example` (~34-37): вместо `CARBONE_URL` и абзаца о кэше шаблонов — `API_SELF_URL=http://api:3000` (комментарий: адрес этой реплики API для Document Server; в k8s — IP пода) и закомментированный `# RENDER_WORKERS=` (по умолчанию min(4, число ядер)).

- [ ] **Step 6: Тесты API**

```bash
cd /Users/sam/carbone-reports && export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH
pnpm --filter @carbone-reports/api test
df -h / | tail -1
pnpm --filter @carbone-reports/api test:int
```

Expected: всё зелёное. Падение по таймауту под нагрузкой — перезапустить один раз.

- [ ] **Step 7: Проверка dev-режима (tsx в потоке)**

```bash
cd /Users/sam/carbone-reports/apps/api && timeout 20 node --import tsx -e "
import('./src/modules/render/worker-url.ts').then(async ({ renderWorkerUrl }) => {
  const { RenderPool } = await import('./src/modules/render/pool.ts');
  const w = renderWorkerUrl();
  const pool = new RenderPool({ size: 1, workerUrl: w.url, execArgv: w.execArgv });
  const out = await pool.run({ template: Buffer.from('<a>{d.x}</a>'), ext: 'xml', data: { x: 'ok' }, options: { lang: 'ru', timezone: 'UTC' } }, Date.now() + 10000);
  console.log(out.toString()); await pool.destroy();
})"
```

Expected: `<a>ok</a>`. Если `renderWorkerUrl` под `node --import tsx` выбирает `.ts`-ветку, а поток не грузит TS — поправить `execArgv` (tsx 4: `['--import', 'tsx']`) и повторить.

- [ ] **Step 8: Проверки и коммит**

```bash
cd /Users/sam/carbone-reports && pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add -A apps/api .env.example
git commit -m "feat(api)!: embedded Carbone renderer with OnlyOffice conversion replaces the Carbone EE client

CARBONE_URL is gone; new API_SELF_URL and RENDER_WORKERS.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Интеграционный тест с настоящим Document Server и CI

**Files:**
- Create: `apps/api/test/render-onlyoffice.int.test.ts`
- Modify: `apps/api/test/images.ts` (`ONLYOFFICE_IMAGE`), `.github/workflows/ci.yml` (задание `integration`: `TEST_ONLYOFFICE=1`, таймаут)

**Interfaces:**
- Consumes: `createEmbeddedRenderer`, `RenderPool`, `renderWorkerUrl`, `createRenderHandoff`, `createOnlyOfficeConverter`, `registerRenderRoutes`.
- Produces: тест, который в CI проверяет docx → pdf, xlsx → ods, odt → docx на настоящем Document Server и ошибку `-4` при недоступной ссылке.

- [ ] **Step 1: Тест**

`apps/api/test/render-onlyoffice.int.test.ts` — запускается только при `TEST_ONLYOFFICE=1` (`describe.skipIf(!process.env.TEST_ONLYOFFICE)`), локально по умолчанию пропускается (образ 3,4 ГБ):

1. `beforeAll` (таймаут 300 000 мс): поднять минимальный Fastify (`Fastify()` + zod-провайдер, как в `buildApp`) только с `registerRenderRoutes(app, { renderFiles } as AppDeps)`, слушать `0.0.0.0` на свободном порту; `await TestContainers.exposeHostPorts(port)`; затем `new GenericContainer(ONLYOFFICE_IMAGE).withEnvironment({ JWT_ENABLED: 'true', JWT_SECRET: <32+ символа>, JWT_HEADER: 'Authorization', ALLOW_PRIVATE_IP_ADDRESS: 'true' }).withExposedPorts(80).withWaitStrategy(Wait.forHttp('/healthcheck', 80).forResponsePredicate((b) => b.includes('true')).withStartupTimeout(240_000)).start()`.
2. Рендерер: `new RenderPool({ size: 1, workerUrl: new URL('../src/modules/render/worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] })`, `createOnlyOfficeConverter({ baseUrl: 'http://<host>:<mapped 80>', secret })`, `selfUrl: 'http://host.testcontainers.internal:<port>'`. Если `.ts`-поток с `--import tsx` под vitest не стартует — собрать `pnpm --filter @carbone-reports/api build` в `beforeAll` и взять `dist/render-worker.js` (записать в отчёт, какой путь сработал).
3. Шаблоны (JSZip, как `buildDocx` в `scripts/help-check.ts`): docx с абзацем `Компания: {d.name}`; xlsx — минимальная книга (`[Content_Types].xml`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/worksheets/sheet1.xml` с ячейкой A1 `inlineStr` `{d.name}`); odt — получить конвертацией docx-шаблона в odt через тот же рендерер (`convertTo: 'odt'` с пустыми данными не подставит теги — поэтому конвертировать **шаблон** напрямую клиентом `createOnlyOfficeConverter`, положив его в handoff).
4. Проверки (данные `{ name: 'ООО Ромашка' }`):
   - docx → pdf: начинается с `%PDF`, размер > 1 КБ;
   - xlsx → ods: zip, `mimetype` = `application/vnd.oasis.opendocument.spreadsheet`, `content.xml` содержит `ООО Ромашка`;
   - odt → docx: zip, `word/document.xml` содержит `ООО Ромашка`;
   - разовая ссылка израсходована: после рендера `handoff` пуст (через `put`-шпион и `take` → `'gone'`);
   - ссылка на недоступный адрес (`selfUrl: 'http://host.testcontainers.internal:1'`) → `CONVERT_ERROR` `ошибка конвертации (код -4)`.
5. `afterAll`: остановить контейнер, `pool.destroy()`, `app.close()`.

`apps/api/test/images.ts`: `export const ONLYOFFICE_IMAGE = 'onlyoffice/documentserver:9.4.0.1';` с комментарием в стиле файла.

- [ ] **Step 2: CI**

`.github/workflows/ci.yml`, задание `integration`: `env: TEST_ONLYOFFICE: '1'` для шага `pnpm test:int`; `timeout-minutes` 45 → 60 (загрузка образа и старт Document Server). Комментарий задания — дополнить «и Document Server для конвертации».

- [ ] **Step 3: Локальная проверка без OnlyOffice**

```bash
cd /Users/sam/carbone-reports && export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH
pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/render-onlyoffice.int.test.ts
```

Expected: тесты пропущены (skipped), остальная часть — без ошибок компиляции. Образ OnlyOffice локально не тянуть; настоящий прогон — в CI (контроллер отправит ветку с согласия пользователя).

- [ ] **Step 4: Проверки и коммит**

```bash
pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add apps/api/test .github/workflows/ci.yml
git commit -m "test(api): real Document Server conversion (docx→pdf, xlsx→ods, odt→docx) in CI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Развёртывание — compose, чарт, kind-смоук, скрипты

**Files:**
- Modify: `docker-compose.yml`, `docker-compose.dev.yml`
- Modify (чарт `charts/carbone-reports`): `values.yaml`, `templates/_helpers.tpl`, `templates/_validate.tpl`, `templates/configmap-api.yaml`, `templates/api.yaml`, `templates/networkpolicy.yaml`, `tests/components_test.yaml`, `tests/api_test.yaml`, `tests/networkpolicy_test.yaml`, `tests/validate_test.yaml`, `ci/kind-values.yaml`, `ci/netpol-values.yaml`
- Delete: `charts/carbone-reports/templates/carbone.yaml`
- Modify: `scripts/k8s-smoke.ts`, `scripts/smoke.ts`, `scripts/restore.sh`, `apps/backup-agent/test/agent.int.test.ts` (~259, 291), `.github/workflows/ci.yml` (задание `chart-kind`)

**Interfaces:**
- Consumes: `API_SELF_URL`, `RENDER_WORKERS` (Task 11).
- Produces: стек без Carbone EE; в чарте у api `POD_IP` из downward API и `API_SELF_URL=http://$(POD_IP):3000`; kind-смоук строит отчёт в PDF и docx с включённым OnlyOffice.

- [ ] **Step 1: Compose**

`docker-compose.yml`: удалить сервис `carbone` (~162-167), том `carbone_templates` (~274), у `api` — `CARBONE_URL` (~53) и `depends_on: carbone` (~97-98); добавить `API_SELF_URL: http://api:3000` рядом с `API_INTERNAL_URL`. `docker-compose.dev.yml`: если у `packages/carbone` есть свои `node_modules` (зависимости `dayjs`, `debug`, `yauzl`, `yazl`), добавить том `dev_carbone_node_modules:/repo/packages/carbone/node_modules` по образцу `dev_shared_node_modules` и его объявление.

```bash
docker compose config -q && docker compose -f docker-compose.yml -f docker-compose.dev.yml config -q && echo ok
```

- [ ] **Step 2: Чарт — тесты (падают)**

- `tests/components_test.yaml`: удалить `carbone.yaml` из `templates` и тесты Carbone.
- `tests/api_test.yaml`: вместо утверждения `data.CARBONE_URL` — в ConfigMap нет `CARBONE_URL`; в контейнере api есть `env` `POD_IP` с `valueFrom.fieldRef.fieldPath: status.podIP` и **после него** `API_SELF_URL` = `http://$(POD_IP):3000` (проверить порядок: `contains` для обоих и `equal` по индексам); ресурсы api по умолчанию `requests: { cpu: 500m, memory: 512Mi }`, `limits: { memory: 2Gi }`.
- `tests/validate_test.yaml`: удалить случай `carbone.url`.
- `tests/networkpolicy_test.yaml`: убрать `carbone.*` из `set`; число политик и `documentIndex` — проверить после правки шаблона (политики: backup-agent, api, onlyoffice, postgresql, redis, s3).

Run: `sh scripts/chart.sh unittest` → FAIL.

- [ ] **Step 3: Чарт — шаблоны и values**

- `git rm charts/carbone-reports/templates/carbone.yaml`.
- `values.yaml`: удалить блок `carbone:` (~107-120); `api.resources` → `requests: { cpu: 500m, memory: 512Mi }`, `limits: { memory: 2Gi }`; в `config` добавить `renderWorkers: ""` с комментарием (пусто — `min(4, ядра)`; для пода с лимитом CPU разумно указать явно).
- `_helpers.tpl`: удалить `cr.carboneUrl` (~137-139). `_validate.tpl`: удалить проверку `carbone.url` (~22-24). `configmap-api.yaml`: удалить `CARBONE_URL`; `RENDER_WORKERS` — только если `config.renderWorkers` задан. `networkpolicy.yaml`: удалить правило для `carbone` (~12) и упоминание в комментарии (~5).
- `api.yaml`, в начало списка `env:` контейнера api:

```yaml
            # Адрес именно этого пода: Document Server забирает собранный отчёт у реплики, которая его собрала.
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: API_SELF_URL
              value: 'http://$(POD_IP):3000'
```

`$(POD_IP)` раскрывается только из переменных, объявленных раньше в том же `env:` (не из ConfigMap) — порядок важен.

- `ci/kind-values.yaml`: удалить блок `carbone:` и упоминание в комментарии; включить OnlyOffice: `onlyoffice: { enabled: true }` (ресурсы и `persistence` — минимальные, по values; `jwtSecret` уже задан в секретах набора). `ci/netpol-values.yaml`: удалить `carbone:` и упоминание.

Run: `sh scripts/chart.sh all` → зелёное (lint, unittest, kubeconform для всех `ci/*.yaml`).

- [ ] **Step 4: kind-смоук строит отчёты**

`scripts/k8s-smoke.ts` — новый шаг «Отчёт: PDF и DOCX» после входа (до бэкапа), через существующие помощники `call`/`json`/`step`:
1. Источник данных `POST /api/datasources`: хост `cr-carbone-reports-postgresql` (имя сервиса — из чарта для релиза `cr`, проверить `kubectl get svc` в шаге CI или константой, как остальные имена в скрипте), порт 5432, база/пользователь/пароль — из `ci/kind-values.yaml` (пароль читать из переменной окружения, которую задаёт CI-шаг, а не хардкодить в логах), `sslMode: 'disable'`.
2. Шаблон `POST /api/templates/upload` (multipart: `name`, `description`, `datasourceId`, `file` — DOCX с `Компания: {d.company.name}`; построение DOCX — как `docxWithTag()` в `scripts/smoke.ts`).
3. Запросы `PUT /api/templates/:id/queries`: `[{ key: 'company', mode: 'single', sql: "select 'ООО Ромашка' as name" }]`.
4. Три раза подряд `POST /api/reports/:id/render` с `{ params: {} }` → 201 `{ runId }` (при двух репликах API запросы попадают на обе; каждый строит PDF через OnlyOffice по адресу пода); для каждого `GET /api/runs/:runId/file?format=pdf` → начинается с `%PDF`.
5. Для последнего запуска `GET /api/runs/:runId/file?format=docx` → zip, в `word/document.xml` есть `ООО Ромашка`.

`.github/workflows/ci.yml`, задание `chart-kind`: `helm install … --wait --timeout 10m` → `--timeout 20m` (OnlyOffice стартует несколько минут), `timeout-minutes` задания 40 → 60; в шаг смоука передать пароль Postgres из values набора через `env`. В диагностику при сбое добавить логи пода onlyoffice.

- [ ] **Step 5: Остальные скрипты**

- `scripts/smoke.ts`: удалить флаг `--carbone-restart` и `carboneRestart()` (~2, 77-150, 157-165, 348); шаги «Carbone: DOCX/PDF» (~296, 303) переименовать в «Отчёт: DOCX/PDF».
- `scripts/restore.sh` (~69, 81-83, 167): тексты про кэш шаблонов Carbone — переписать (очистка Redis нужна для счётчиков входа и флага обслуживания).
- `apps/backup-agent/test/agent.int.test.ts` (~259, 291): ключ `cr:carbone:tpl:x` заменить на `cr:test:x` (смысл теста — проверка очистки `cr:*`).

- [ ] **Step 6: Проверки и коммит**

```bash
cd /Users/sam/carbone-reports && export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH
sh scripts/chart.sh all
pnpm exec prettier --check . && pnpm lint && pnpm typecheck
grep -rn "CARBONE_URL\|carbone-ee\|carbone_templates" --include=*.yml --include=*.yaml --include=*.ts --include=*.sh --include=*.tpl . | grep -v node_modules | grep -v docs/
git add -A docker-compose.yml docker-compose.dev.yml charts scripts apps/backup-agent/test .github/workflows/ci.yml
git commit -m "feat(deploy)!: drop the Carbone EE container; API_SELF_URL from pod IP; kind smoke renders PDF and DOCX through OnlyOffice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Expected от `grep`: пусто (кроме `scripts/carbone-parity.ts`, где образ EE используется намеренно).

---

### Task 14: Документация 2.0.0

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/notes/2026-10-02-backend-follow-ups.md` (раздел «Итоги Плана 17»)
- Modify: `packages/carbone/NOTICE.md` (если Tasks 4–7 добавили ограничения)

**Interfaces:**
- Consumes: всё вышеперечисленное.
- Produces: README для версии 2.0.0.

- [ ] **Step 1: README**

Обновить по фактическому коду (перечень мест — исследование `docs/superpowers/plans/2026-10-09-carbone-embedded/` не нужно, искать `grep -n -i carbone README.md`):
- состав стека и образов: нет контейнера Carbone; отчёты собирает API (встроенная сборка Carbone 3.8.2, `packages/carbone`), PDF/ODT/ODS — OnlyOffice; OnlyOffice обязателен для построения отчётов (API сначала строит PDF);
- переменные: `API_SELF_URL`, `RENDER_WORKERS`; `RENDER_TIMEOUT_MS` ограничивает сборку и конвертацию; `CARBONE_URL` удалена; Redis больше не хранит кэш шаблонов;
- Helm: компонента `carbone` нет; `API_SELF_URL` из IP пода; ресурсы api;
- **«Обновление с 1.x»**: `docker compose up -d --remove-orphans` убирает старый контейнер; том `carbone_templates` удалить вручную (`docker volume rm <проект>_carbone_templates`); `CARBONE_URL` больше не читается; ключи `cr:carbone:tpl:*` в Redis не используются — удалить: `redis-cli -a "$REDIS_PASSWORD" --scan --pattern 'cr:carbone:tpl:*' | xargs -r redis-cli -a "$REDIS_PASSWORD" del` (или подождать 7 дней — у ключей есть срок); шаблоны в S3 не меняются; PDF собирает OnlyOffice — вёрстка ближе к редактору и может немного отличаться от отчётов 1.x; в Helm удалить из своих values блок `carbone:`;
- **«Лицензии»**: часть продукта `packages/carbone` — Carbone Community Edition под Carbone Community License (ссылка на `packages/carbone/LICENSE.md` и https://github.com/carboneio/carbone/blob/master/LICENSE.md); использование этой части подчиняется CCL (требование CCL 2.1(b) — уведомить пользователей продукта);
- раздел о проверке синтаксиса: `pnpm help:check` (Task 8), эталоны `packages/carbone/test/golden`, `scripts/carbone-parity.ts`.

- [ ] **Step 2: Заметки «Итоги Плана 17»**

В стиле разделов «Итоги Плана 15/16»: что сделано; решения, принятые по ходу (из журнала контроллера — строки `Ruling:`); осознанные отличия от EE (`deviation` в эталонах — перечислить id и причины); открытые вопросы (платные функции EE — следующие планы; общий `c.` и колонтитулы; ограничения Document Server).

- [ ] **Step 3: Проверки и коммит**

```bash
cd /Users/sam/carbone-reports && pnpm exec prettier --check . && pnpm lint && pnpm typecheck
git add README.md docs/superpowers/notes packages/carbone/NOTICE.md
git commit -m "docs: 2.0.0 — embedded Carbone build, OnlyOffice conversion, upgrade from 1.x, CCL notice

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Ручная проверка после плана (не задача исполнителя)

Владелец проекта перед решением о слиянии: поднять стек `docker compose up -d --build --remove-orphans` на демо-данных, построить несколько своих отчётов из S3 в PDF и в формате шаблона, сравнить с отчётами 1.x; при расхождениях на реальных шаблонах — новые пробы через `scripts/carbone-parity.ts` и правки сборки.
