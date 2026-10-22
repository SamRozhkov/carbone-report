# 2.14.0: локализация отчётов (этап 2) — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** язык отчёта задаётся в шаблоне (7 языков или «как у пользователя») и определяет форматы Carbone (даты, числа, валюту по умолчанию), `region` конвертации OnlyOffice, штамп подписи и нумерацию страниц PDF; китайский текст в PDF рисуется шрифтом Noto Sans SC.

**Architecture:** shared получает тип `ReportLocale`, таблицы `CARBONE_LANGS` и `OFFICE_REGIONS` и серверное пространство имён каталога `report`. API определяет язык отчёта один раз на построение (`resolveReportLocale`), передаёт его в `renderReport` (Carbone `lang`, OnlyOffice `region`, формат нумерации по умолчанию) и сохраняет в `report_runs.report_locale`; подпись и сборка из снимка берут язык запуска. Шрифт PDF выбирается на строку: Noto Sans, если в нём есть все символы, иначе Noto Sans SC.

**Tech Stack:** Fastify 5, drizzle (миграция 0017), pdf-lib + @pdf-lib/fontkit, Carbone (пакет `packages/carbone`), i18next (серверный переводчик `@carbone-reports/shared/i18n/server`), React 19 + Gravity UI, vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §45 (контекст — §44 этап 1, §39.5 штамп, §36 настройки PDF, §42 ГОСТ, §43 права правки).

## Global Constraints

- Node 22: `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH`.
- Модульные тесты: `pnpm --filter <pkg> test`; интеграционные API: `pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts <файлы>`. Не запускать два набора одновременно; никогда не запускать `render-onlyoffice.int.test.ts`. Под нагрузкой бывают случайные тайм-ауты 5 с в чужих файлах — перепроверять такой файл отдельно и писать в отчёт оба результата.
- Перед коммитом: `pnpm typecheck`, `pnpm exec prettier --check .`, `pnpm i18n:check`, eslint на `apps packages scripts` (локальный `cades/cadesplugin_api.js` вне репозитория — его ошибки не считаются).
- `LOCALES = ['ru','en','es','pt-BR','fr','de','zh-CN']`. `ReportLocale = Locale | 'user'`.
- `CARBONE_LANGS`: `ru`→`ru`, `en`→`en-us`, `es`→`es-es`, `pt-BR`→`pt-br`, `fr`→`fr-fr`, `de`→`de-de`, `zh-CN`→`zh-cn`. Валюта `formatC` по умолчанию следует за языком (`currencySource`/`currencyTarget` не задаются): RUB, USD, EUR, BRL, EUR, EUR, CNY.
- `OFFICE_REGIONS`: `ru-RU`, `en-US`, `es-ES`, `pt-BR`, `fr-FR`, `de-DE`, `zh-CN` (та же таблица, что сейчас `REGION` в `apps/api/src/modules/onlyoffice/editor-config.ts` — перенести, не дублировать).
- Для `ru` всё выходит дословно как до 2.14.0: строки штампа, формат дат в штампе, «Стр. {page} из {pages}», вывод Carbone. Существующие тесты на русские тексты не меняются.
- Каталог `report` — только сервер (как `errors`/`validation`): не попадает в веб-бандл.
- Переводы — по глоссарию `docs/localization.md`, правила пунктуации языков как в 2.13.0; `{page}`/`{pages}` в формате нумерации — одинарные фигурные скобки, не интерполяция i18next.
- Миграции не меняют существующие миграции; новая — `apps/api/drizzle/0017_report_locale.sql` + метаданные drizzle тем же способом, что 0016.
- Коммиты: сообщение в стиле репозитория, последний абзац `-m` из двух строк:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB`
  Ветка `feat/2.14.0`; не переключать ветки, не пушить, не мержить.
- Не собирать Docker-образы и не трогать Docker-ресурсы; `.env` и `certs/` не читать.
- Новых npm-зависимостей нет. Новый файл шрифта — только Noto Sans SC Regular (OFL), с файлом лицензии рядом, как у Noto Sans.

## Решения контроллера (до исполнения)

- **Язык запуска хранится** в `report_runs.report_locale` (спецификация §45.2 дополнена): подпись `.p12`/ГОСТ и `renderFromSnapshot` берут его; `NULL` → `'ru'`.
- **`'user'`** = `users.locale` строящего (если задан и из `LOCALES`), иначе `req.locale` (уже `X-Locale` → `Accept-Language` → `DEFAULT_LOCALE`, `apps/api/src/lib/locale.ts`).
- **Колонка шаблона** `report_locale text NOT NULL DEFAULT 'ru'` в миграции (существующие → `'ru'`); при создании шаблона код явно пишет `config.defaultLocale`; копия — значение исходного; импорт — значение из выгрузки или `'ru'`.
- **Нумерация:** формат по умолчанию — таблица `PAGE_FORMATS` в shared (данные, как `CARBONE_LANGS`; её читают и сервер, и веб — каталог `report` веб не грузит). `PdfPageNumbers.format` — `.optional()`; пустая строка в форме веба отправляется как отсутствие поля. Подстановка формата по языку — в `buildPdfJob` (main thread, перед пулом), чтобы задача `pdf` в пуле получала готовую строку.
- **Штамп:** `stampLines(info, now, timeZone, locale)`; тексты — из каталога `report` через `createTranslator(locale)`, дата/время — `Intl.DateTimeFormat(<BCP47 языка>, …)` с теми же опциями, что сейчас; для `ru` BCP47 — `ru-RU`.
- **Шрифт:** выбор на строку в `apps/api/src/modules/pdf/font.ts` (`pickPdfFont(text) → 'base' | 'cjk'`), очистка `sanitizePdfText(text, font)` — по выбранному шрифту. Встраивание SC — лениво (только если в документе есть такая строка).

## Review Focus

1. Запуск, построенный до 2.14.0 (`report_locale = NULL`), подписывают после обновления — штамп по-русски, как раньше. Тест — Task 3.
2. Шаблон переключили с `ru` на `en` после построения отчёта; отчёт из истории подписывают или собирают в другом формате — язык исходного запуска, а не новый. Тест — Task 3.
3. Шаблон «как у пользователя» строится через API без `X-Locale`/`Accept-Language` пользователем без языка в профиле — язык `DEFAULT_LOCALE`. Тест — Task 3.
4. Имя владельца сертификата смешанное («Ли Вэй 李伟 😀») — строка рисуется Noto Sans SC, иероглифы извлекаются из PDF, эмодзи → «?»; на `ru` с латиницей/кириллицей строка остаётся Noto Sans. Тест — Task 1.
5. У шаблона свой формат нумерации («Page {page}») — миграция и смена языка его не трогают; формат с пробелами/другим текстом, отличный от «Стр. {page} из {pages}», не удаляется. Тест — Task 2.

---

### Task 1: шрифт Noto Sans SC и выбор шрифта на строку

**Files:**
- Create: `packages/carbone/assets/fonts/NotoSansSC-Regular.<ttf|otf>` и лицензия (OFL) рядом, если у Noto Sans лицензия лежит отдельным файлом.
- Modify: `apps/api/src/modules/pdf/font.ts`, `apps/api/src/modules/pdf/postprocess.ts` (водяной знак, нумерация), `apps/api/src/modules/pdf/sign/prepare.ts` (штамп `.p12`), `apps/api/src/modules/pdf/sign/gost/*` (штамп ГОСТ — найти место, где рисуются `lines`), `apps/api/src/modules/pdf/finish.ts` (очистка текстов).
- Test: `apps/api/src/modules/pdf/font.test.ts`, `postprocess.test.ts`, `sign/prepare.test.ts` (или `sign-pdf.test.ts`).

**Interfaces:**
- Produces: `pdfCjkFontBytes(): Buffer`; `pickPdfFont(text: string): 'base' | 'cjk'` — `'base'`, если каждый символ (после замены управляющих на пробел) есть в Noto Sans, иначе `'cjk'`; `sanitizePdfText(text: string, font: 'base' | 'cjk' = 'base'): string` — символы вне выбранного шрифта → «?»; `hasGlyph(ch, font = 'base')`.

- [ ] **Step 1: проверка файла шрифта.** Скачать Noto Sans SC Regular (Google Fonts / notofonts, OFL). Одноразовым скриптом в scratchpad: `PDFDocument.create()`, `registerFontkit`, `embedFont(bytes, { subset: true })`, `drawText('签名 李伟 Иван 2026')`, сохранить; извлечь текст тем же способом, что существующие тесты PDF (`apps/api/src/modules/pdf/test-pdf.ts`). Если подмножество OTF/CFF ломается или текст не извлекается — взять TTF-вариант того же шрифта. Записать в отчёт выбранный файл, его размер и результат.
- [ ] **Step 2: тесты `font.test.ts`** — `pickPdfFont('Иван Petrov')` → `'base'`; `pickPdfFont('李伟')` → `'cjk'`; `pickPdfFont('Ли Вэй 李伟 😀')` → `'cjk'`; `sanitizePdfText('李伟 😀', 'cjk')` → `'李伟 ?'`; `sanitizePdfText('李伟')` (base) → `'??'` (прежнее поведение). Запустить — падают.
- [ ] **Step 3: реализация `font.ts`** — второй ленивый fontkit для SC; `pickPdfFont`, `sanitizePdfText(text, font)`, `hasGlyph(ch, font)`.
- [ ] **Step 4: рисование.** В `postprocess.ts`, `sign/prepare.ts` и подготовке ГОСТ: для каждой строки — `pickPdfFont` по сырому тексту, `sanitizePdfText(text, font)`, рисовать `regular`/`bold` (base) или SC (cjk; для заголовка штампа — SC Regular); SC встраивать только при первой cjk-строке. Ширина/центровка — по шрифту строки. В `finish.ts` очистку текстов водяного знака и метаданных не делать заранее по base-шрифту — передавать сырой текст с подставленными тегами и очищать при рисовании (метаданные PDF — строки Info, их только чистить от управляющих символов, глифы не нужны).
- [ ] **Step 5: тесты рисования** — штамп `.p12` с владельцем «Ли Вэй 李伟 😀»: текст извлекается и содержит «李伟», эмодзи → «?»; водяной знак «机密» извлекается; русский штамп/водяной знак — те же байты шрифта (Noto Sans) и прежний текст; PDF без cjk-строк не содержит шрифт SC (имя шрифта в ресурсах страницы).
- [ ] **Step 6:** `pnpm --filter @carbone-reports/api test` (pdf/*), typecheck, prettier. Commit: `feat(pdf): Noto Sans SC for CJK text in stamp, watermark and page numbers`.

### Task 2: shared, каталог `report`, миграция 0017

**Files:**
- Modify: `packages/shared/src/i18n/index.ts` (`NAMESPACES` += `'report'`; `ReportLocale`, `REPORT_LOCALES = [...LOCALES, 'user']`, `zodReportLocale`, `CARBONE_LANGS`, `OFFICE_REGIONS`, `PAGE_FORMATS: Record<Locale, string>` — формат нумерации по умолчанию на каждом языке (`ru`: «Стр. {page} из {pages}»), `localeTag(locale)` → BCP47 для `Intl`: `ru`→`ru-RU`, `en`→`en-US`, `es`→`es-ES`, `pt-BR`→`pt-BR`, `fr`→`fr-FR`, `de`→`de-DE`, `zh-CN`→`zh-CN`), `packages/shared/src/index.ts` (удалить `CARBONE_LANG`), `packages/shared/src/pdf-options.ts` (удалить `PDF_PAGE_FORMAT_DEFAULT`, `format` — `.optional()`), схемы шаблона в shared (`TemplateAdminDetails` и тела создания/изменения/экспорта — поле `reportLocale`).
- Create: `packages/shared/src/i18n/<7 языков>/report.json`.
- Modify: веб-исключение каталога: `report` не должен попасть в веб — проверить, как `errors`/`validation` исключены из globs `apps/web/src/i18n/instance.ts` и из веб-проверок `scripts/i18n-check.ts`, и сделать так же.
- Create: `apps/api/drizzle/0017_report_locale.sql` (+ meta), Modify: `apps/api/src/db/schema.ts`.
- Test: `packages/shared/src/i18n/index.test.ts`, `packages/shared/src/pdf-options.test.ts` (если есть), миграционный int-тест рядом с тестами 0016.

**Interfaces:**
- Produces: `type ReportLocale = Locale | 'user'`; `zodReportLocale`; `CARBONE_LANGS: Record<Locale, string>`; `OFFICE_REGIONS: Record<Locale, string>`; `localeTag(l: Locale): string`; ключи `report:stamp.title`, `report:stamp.certificate` (`{{serial}}`), `report:stamp.owner` (`{{owner}}`), `report:stamp.valid` (`{{from}}`, `{{to}}`), `report:stamp.signed` (`{{date}}`, `{{time}}`); `PAGE_FORMATS: Record<Locale, string>`; колонки `templates.reportLocale: ReportLocale`, `reportRuns.reportLocale: Locale | null`.

- [ ] **Step 1: тесты shared** — `CARBONE_LANGS`/`OFFICE_REGIONS` покрывают все `LOCALES` и равны значениям из Global Constraints; `zodReportLocale` принимает `'user'` и 7 языков, отвергает `'pt-PT'`; `PdfPageNumbers.parse({})` без `format`; `createTranslator('ru')('report:stamp.title')` = «ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ»; `PAGE_FORMATS.ru` = «Стр. {page} из {pages}», все 7 значений содержат `{page}` и проходят `PdfPageNumbers`.
- [ ] **Step 2: реализация shared и каталоги.** `ru/report.json` — дословно строки из `stampLines` (`sign-pdf.ts`): «ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ», «Сертификат: {{serial}}», «Владелец: {{owner}}», «Действителен: с {{from}} по {{to}}», «Подписан: {{date}} {{time}}». Переводы на 6 языков (и значения `PAGE_FORMATS` для 6 языков, напр. `en` «Page {page} of {pages}») (заголовок — заглавными, где в языке есть регистр). `REGION` из `editor-config.ts` заменить на `OFFICE_REGIONS`. Удаление `CARBONE_LANG`/`PDF_PAGE_FORMAT_DEFAULT` сломает использования в API — в этой задаче временно заменить их на `CARBONE_LANGS.ru` и `PAGE_FORMATS.ru` в местах вызова, чтобы поведение не изменилось (Task 3 подключает язык).
- [ ] **Step 3: миграция 0017.**
  ```sql
  ALTER TABLE templates ADD COLUMN report_locale text NOT NULL DEFAULT 'ru';
  ALTER TABLE report_runs ADD COLUMN report_locale text;
  UPDATE templates
     SET pdf_options = jsonb_set(pdf_options, '{pageNumbers}', (pdf_options->'pageNumbers') - 'format')
   WHERE pdf_options->'pageNumbers'->>'format' = 'Стр. {page} из {pages}';
  ```
  Схема drizzle: `reportLocale: text('report_locale').$type<ReportLocale>().notNull().default('ru')` у `templates`, `reportLocale: text('report_locale').$type<Locale>()` у `reportRuns`.
- [ ] **Step 4: int-тест миграции** (по образцу теста 0016): шаблон с `format` «Стр. {page} из {pages}» → поле удалено, `position`/`skipFirst` на месте; с «Page {page}» и с « Стр. {page} из {pages} и др.» → не тронут; без `pageNumbers` → `pdf_options` не изменился; `report_locale` = `'ru'`; у запусков — `NULL`.
- [ ] **Step 5:** shared/API модульные, int-тест миграции, `pnpm i18n:check` (знает `report`), веб-сборка — в бандле нет строки «ДОКУМЕНТ ПОДПИСАН». Commit: `feat(i18n): report locale types, report catalog, migration 0017`.

### Task 3: API — язык отчёта в шаблоне, построении, запуске и подписи

**Files:**
- Create: `apps/api/src/modules/reports/report-locale.ts`.
- Modify: `apps/api/src/modules/reports/service.ts` (`renderReport`), `snapshot.ts` (`renderFromSnapshot`), `reports/routes.ts` (построение, превью `/api/templates/:id/preview`, запись `report_runs`), `apps/api/src/modules/render/renderer.ts` + `deps.ts` (передать `region` в `convert`), `render/onlyoffice-convert.ts` (`region` из запроса), `pdf/finish.ts` (`buildPdfJob` — формат по языку), `pdf/sign/sign-pdf.ts` (`stampLines`/`signPdf` с языком), `signature/sign-run.ts`, `signature/gost-routes.ts`, `templates/routes.ts` (создание, копия, изменение настроек, выдача деталей), `templates/transfer/export.ts`, `import.ts`.
- Test: `report-locale.test.ts`, `sign-pdf.test.ts`, `finish.test.ts`, `onlyoffice-convert.test.ts`, `renderer.test.ts`, int-тесты построения, превью, подписи, копии, экспорта/импорта (рядом с существующими).

**Interfaces:**
- Consumes (Task 2): `ReportLocale`, `CARBONE_LANGS`, `OFFICE_REGIONS`, `localeTag`, ключи `report:*`, колонки `reportLocale`.
- Produces: `resolveReportLocale(setting: ReportLocale, userLocale: string | null, reqLocale: Locale): Locale`; `runLocale(run: { reportLocale: string | null }): Locale` (`NULL`/неизвестное → `'ru'`); `renderReport(deps, tpl, data, format, locale: Locale, deadline?, pdf?)`; `stampLines(info, now, timeZone, locale: Locale)`; `SignPdfOptions.locale: Locale`; `ConvertRequest.region: string`; API-поле шаблона `reportLocale: ReportLocale` в деталях, теле изменения настроек и выгрузке.

- [ ] **Step 1: `report-locale.test.ts`** — `resolveReportLocale('de', 'en', 'fr')` → `de`; `('user', 'en', 'fr')` → `en`; `('user', null, 'fr')` → `fr`; `('user', 'xx', 'fr')` → `fr`; `runLocale({ reportLocale: null })` → `ru`.
- [ ] **Step 2: `stampLines` с языком** — тест: `ru` даёт дословно прежние 5 строк (существующий тест не меняется, добавить `'ru'` аргументом); `en`/`de`/`zh-CN` — строки из каталога, дата в формате языка (`en`: `MM/DD/YYYY`, `de`: `DD.MM.YYYY`), время 24 ч как сейчас (`hourCycle: 'h23'`).
- [ ] **Step 3: `buildPdfJob`** — `pageNumbers` без `format` → `PAGE_FORMATS[locale]`; с `format` — как задан. `buildPdfJob(p, data, now, files, locale)`.
- [ ] **Step 4: Carbone и OnlyOffice** — `renderReport(..., locale)` передаёт `lang: CARBONE_LANGS[locale]`; `renderer` передаёт `region: OFFICE_REGIONS[locale]` в `convert`; `onlyoffice-convert.ts` кладёт `req.region` в тело. Тесты: `renderer.test.ts` (опции пула и запрос конвертации), `onlyoffice-convert.test.ts` (`region` в теле). Тест с настоящим Carbone (модульный, рядом с существующими тестами рендера, без OnlyOffice): шаблон-строка с `{d.date:formatD('LL')}`, `{d.n:formatN(2)}`, `{d.n:formatC(2)}` на `ru`, `en`, `de`, `zh-CN` — месяц и разделители языка, валюта RUB/USD/EUR/CNY; на `ru` — как в существующих ee-compat тестах.
- [ ] **Step 5: построение и запуск** — в маршруте построения: `const locale = resolveReportLocale(full.row.reportLocale, me.locale, req.locale)`; рендер с `locale`; `reportLocale: locale` в `insert(reportRuns)` (обе ветки, ok и error). Превью — то же правило. `renderFromSnapshot(deps, run, …)` — язык `runLocale(run)` (поменять сигнатуру, чтобы принимать язык; вызывающие в `reports/routes.ts:111` и `snapshot.ts:233` передают `runLocale(run)`).
- [ ] **Step 6: подпись** — `sign-run.ts` и `gost-routes.ts`: `stampLines(info, now, config.tz, runLocale(run))`, `signPdf(..., { locale: runLocale(run) })`.
- [ ] **Step 7: шаблон** — создание: `reportLocale: config.defaultLocale`; копия — значение исходного; изменение настроек шаблона (тот же маршрут/тело, что меняют настройки вкладки «Настройки», под `requireTemplateEdit`) принимает `reportLocale` (`zodReportLocale`); детали шаблона отдают `reportLocale`. Экспорт пишет `reportLocale`; импорт — значение или `'ru'`, неизвестное → `400 VALIDATION`.
- [ ] **Step 8: int-тесты (Review Focus 1–3)** — построение шаблона `de` → `report_runs.report_locale = 'de'`; шаблон `'user'` пользователем с `users.locale = 'en'` → `'en'`, без языка и без заголовков → `DEFAULT_LOCALE`; запуск `de`, затем шаблон переключён на `ru`, подпись `.p12` → штамп на немецком (текст извлекается из PDF), сборка другого формата из снимка вызывает рендер с `de`; запуск с `report_locale = NULL` → подпись по-русски; создание шаблона при `DEFAULT_LOCALE=en` → `reportLocale = 'en'`; копия сохраняет `fr`; экспорт/импорт с `reportLocale` и без него (`'ru'`); импорт с `'xx'` → 400; изменение `reportLocale` пользователем без права правки → 403 (как прочие настройки, §43).
- [ ] **Step 9:** модульные API, затронутые int-тесты по одному файлу, typecheck, prettier, i18n:check. Commit: `feat(reports): report locale for Carbone, OnlyOffice, PDF stamp and page numbers`.

### Task 4: веб — поле «Язык отчёта» и формат нумерации

**Files:**
- Modify: `apps/web/src/pages/admin/template-editor/SettingsTab.tsx` (+ тест), `PdfTab.tsx` (+ тест), типы API шаблона в `apps/web/src/api/*`, каталоги `packages/shared/src/i18n/<7>/editor.json` (новые ключи поля и подсказки; удалить `pdf.pageFormatDefault`).

**Interfaces:**
- Consumes: API-поле `reportLocale: ReportLocale`; `LOCALE_NAMES`; `REPORT_LOCALES`; `PAGE_FORMATS`.

- [ ] **Step 1: тест `SettingsTab`** — поле «Язык отчёта» показывает значение шаблона; варианты — 7 самоназваний и «Как у пользователя»; выбор `Deutsch` → в запросе сохранения `reportLocale: 'de'`; подсказка к полю видна (текст из каталога, `ru`: «Язык задаёт формат дат и чисел, валюту formatC по умолчанию, штамп подписи и нумерацию страниц. Текст шаблона не переводится.»). Без права правки поле только для чтения, как остальные поля вкладки.
- [ ] **Step 2: тест `PdfTab`** — включение нумерации больше не подставляет значение; поле пустое, placeholder = `PAGE_FORMATS[язык отчёта]` (для `'user'` — язык интерфейса); у шаблона `de` placeholder — `PAGE_FORMATS.de`; пустое поле при сохранении → `format` отсутствует в теле; введённый формат сохраняется как есть.
- [ ] **Step 3: реализация** — поле в `SettingsTab` (Gravity UI `Select`, как прочие выборы вкладки), сохранение тем же запросом, что остальные настройки; `PdfTab` — убрать подстановку `editor:pdf.pageFormatDefault`, ключ удалить из 7 каталогов; переводы новых ключей на 6 языков.
- [ ] **Step 4:** web-тесты затронутых файлов, полный web-прогон, `pnpm i18n:check`, typecheck, prettier, web-сборка (каталог `report` не в бандле). Commit: `feat(web): report language setting and page-number format by report language`.

### Task 5: документация, CHANGELOG, полный прогон

**Files:** `docs/localization.md`, `README.md`, `CHANGELOG.md`.

- [ ] **Step 1: `docs/localization.md`** — раздел «Язык отчёта»: настройка шаблона, правило `'user'`, язык запуска (подпись и сборка из снимка), таблица `CARBONE_LANGS`/`OFFICE_REGIONS`/`PAGE_FORMATS`/валют, предупреждение «валюта следует за языком», шрифт Noto Sans SC и правило выбора шрифта на строку, каталог `report` (только сервер). В «Как добавить язык» — новые шаги: `CARBONE_LANGS` (проверить ключ в `packages/carbone/formatters/_locale.js` и валюту), `OFFICE_REGIONS`, `localeTag`, `report.json`, значение `PAGE_FORMATS`, шрифт, если письменность не покрыта Noto Sans/SC. В «Что не переводится» — убрать штамп, нумерацию по умолчанию и `CARBONE_LANG`; оставить остальное, добавить: текст самого шаблона (`{t()}` не поддерживается), китайский текст в диаграммах.
- [ ] **Step 2: README** — раздел о языке отчёта (кратко) рядом с разделом «Язык интерфейса». **CHANGELOG** `## [2.14.0] — <дата>`: «Добавлено» — «Язык отчёта» в шаблоне, штамп и нумерация на 7 языках, шрифт Noto Sans SC; «Изменено» — формат Carbone и `region` OnlyOffice по языку отчёта, формат нумерации по умолчанию по языку, миграция 0017 (существующие шаблоны и запуски — `ru`); «Обновление» — валюта `formatC` по умолчанию следует за языком отчёта (en → USD, de/fr/es → EUR, pt-BR → BRL, zh-CN → CNY) — при смене языка шаблона проверьте суммы или задайте валюту в метке; сторонние клиенты API, создающие шаблон без формата нумерации, больше не получают русский формат — он берётся по языку отчёта. `node scripts/changelog-section.mjs 2.14.0`; prettier.
- [ ] **Step 3: полный прогон** последовательно: модульные всех пакетов, web, `pnpm i18n:check`, `pnpm test:scripts`, int-тесты API (без `render-onlyoffice.int.test.ts`). Commit: `docs: report language in localization guide, README and CHANGELOG for 2.14.0`.
