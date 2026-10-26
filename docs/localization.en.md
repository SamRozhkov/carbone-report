[Русский](localization.md) · **English**

# Interface and report localization

Interface and report languages: `ru` (primary and source), `en`, `es`, `pt-BR`, `fr`, `de`, `zh-CN` (specification, §44 and §45, in Russian). There are no right-to-left languages.

Localization proceeds in stages:

1. The interface, API errors, interface date formats and this document — 2.13.0.
2. Reports: the Carbone format language, the signature stamp and PDF page numbering — 2.14.0 (section “Report language”).
3. Template help — 2.15.0 (section “Template help”).
4. Documentation in English — 2.17.0 (section “Documentation”).

## Catalogs and namespaces

Catalogs live in `packages/shared/src/i18n/<language>/<namespace>.json`, in the i18next JSON v4 format. The source is `ru`; the other languages have the same keys. The list of namespaces is `NAMESPACES` in `packages/shared/src/i18n/index.ts`.

| Namespace | What it contains | Where it is used |
| --- | --- | --- |
| `common` | Roles, menu and shell, sign-in, language switcher, common buttons and states, maintenance mode, backup phases, duration, file sizes, parameter labels | web |
| `reports` | Report list and report generation | web |
| `history` | Run history | web |
| `signature` | “My signature”, the `.p12` and GOST signing dialogs, the CryptoPro plugin check | web |
| `templates` | Template list, creation, export and import from an archive, access | web |
| `editor` | Template editor: tabs, document, data, charts, parameters, PDF, settings | web |
| `help` | Labels of the “Template help” page (the help content is the `content/<language>.ts` modules, section “Template help”) | web |
| `admin` | Users, groups, categories, data sources, report access, backups and restore | web |
| `errors` | API error texts (`AppError`, Fastify `FST_*` codes) | API only |
| `validation` | Own messages of the shared schemas (`v:…` keys) | API only |
| `report` | Texts inside the report: PDF signature stamp lines (`report:stamp.*`) | API only |

How the catalogs reach the applications:

- **The API** takes all languages and namespaces at once: `packages/shared/src/i18n/resources.ts` (an import of every file) and `createTranslator(locale)` from `packages/shared/src/i18n/server.ts`.
- **The web app** (`apps/web/src/i18n/instance.ts`):
  - the `ru` catalogs are part of the main bundle (`import.meta.glob` with `eager: true`, the `RU` list);
  - the other languages are separate chunks, one per language and namespace (the `LAZY` list). They are loaded when a language is selected, together with the fallback `en`.
  - Both lists name the namespaces explicitly, one line for each. `errors`, `validation` and `report` are not in the lists: the API translates these texts, and they must not end up in the web bundle.
  - Do not use exclusions such as `!…/errors.json` in `import.meta.glob` patterns: Vitest does not apply them to paths outside the web package, so tests that build the bundle see different sets of catalogs; this is why the needed files are listed explicitly.
- The fallback chain when a key is missing: `<language>` → `en` → `ru`. A production release never reaches it: `pnpm i18n:check` catches a missing key.

## Language selection

The interface language (web, `apps/web/src/i18n/index.ts`, function `pickLocale`) is chosen in this order:

1. `me.locale` — the language the user chose in the menu (stored in `users.locale`, `PUT /api/me/locale`).
2. The choice on the sign-in page — `localStorage`, key `cr.locale`. It stays in effect after sign-in as long as `me.locale` is empty.
3. The browser language: the first entry of `navigator.languages` that has a catalog. Matching is done on the exact tag, case-insensitively, then on the primary subtag: `pt-PT` → `pt-BR`, `zh-TW`/`zh-HK` → `zh-CN`, `en-GB` → `en`, `de-AT` → `de` (`resolveLocale` in `packages/shared/src/i18n/index.ts`).
4. The server's `DEFAULT_LOCALE` (the public `GET /api/i18n` → `{ defaultLocale }`; `ru` by default, `config.defaultLocale` in Helm).

The switcher (`apps/web/src/i18n/LocaleSwitcher.tsx`):

- in the bottom menu of the sidebar (“Language”): the choice changes the language immediately and is saved through `PUT /api/me/locale`;
- on the sign-in page: the choice is stored only in `localStorage` (`cr.locale`);
- the “Browser default” menu item resets `me.locale` to `null` and removes `cr.locale`; the language is again taken from the browser or `DEFAULT_LOCALE`.

Together with the language (`changeLocale`), the following change:

- `<html lang>`;
- the uikit language: `ThemeProvider lang` and `configure({ lang })`. uikit knows only `ru` and `en`, so `en` is set for every language except `ru`;
- the `@gravity-ui/date-utils` locale (`DATE_LOCALES`: `ru`, `en`, `es`, `pt-br`, `fr`, `de`, `zh-cn`);
- `Intl.*` and `localeCompare` in `apps/web/src/lib/format.ts`, `ReportsPage` and `DocumentTab` — by the current language;
- the `X-Locale: <language>` header on every `api/*` request (`setRequestLocale` in `apps/web/src/api/client.ts`).

The API response language (`req.locale`, `apps/api/src/lib/locale.ts`):

1. `X-Locale`, if the value is in `LOCALES`;
2. otherwise the best language from `Accept-Language` (by descending `q`) by the same `resolveLocale` rule;
3. otherwise `DEFAULT_LOCALE`.

For response texts the server does not read `users.locale`: the web app has already taken the user's choice into account in `X-Locale`. The exception is the report language “Same as the user” (`'user'`), see “Report language”. Internal routes (`/internal/…`) always work in `DEFAULT_LOCALE`. In the request language the API returns error texts and the OnlyOffice editor language (`editorConfig.lang` and `region`, `apps/api/src/modules/onlyoffice/editor-config.ts`).

## Report language

Since 2.14.0 a template has its own report language (specification, §45, in Russian), independent of the interface language. It sets the Carbone date and number format, the default `formatC` currency, the OnlyOffice conversion region, the signature stamp lines and the PDF page numbering format. The text of the template itself is not translated.

### Template setting

- The “Report language” field on the “Settings” tab of the template editor (`apps/web/src/pages/admin/template-editor/SettingsTab.tsx`): seven languages (self-names from `LOCALE_NAMES`) and “Same as the user”. Anyone with the right to edit the template can change it.
- Stored in `templates.report_locale`: a language from `LOCALES` or `'user'`. The `ReportLocale` type and the `zodReportLocale` schema (`packages/shared/src/i18n/index.ts`); in the API it is the `reportLocale` field in `TemplateAdminDetails` and in the body of `PATCH /api/templates/:id`.
- Migration 0017 (`apps/api/drizzle/0017_report_locale.sql`) sets `'ru'` on all existing templates: earlier reports are still built in Russian for any `DEFAULT_LOCALE`.
- A new template gets `DEFAULT_LOCALE`; a copy (“Duplicate”) gets the language of the source template.
- Template export carries `reportLocale`. On import from an archive, a missing value (exports made before 2.14.0) becomes `'ru'`; an unknown value gives `400 IMPORT_INVALID`, like other manifest errors.

### Which language a run uses

`resolveReportLocale` in `apps/api/src/modules/reports/report-locale.ts`:

1. the template language, if it is not `'user'`;
2. for `'user'`, the profile language of the user who builds the report (`users.locale`), if it is set and is in `LOCALES`;
3. otherwise the request language (`X-Locale` → `Accept-Language`, see “Language selection”);
4. otherwise `DEFAULT_LOCALE`.

The language is determined once per build (the editor preview and report generation follow the same rule) and passed on: to Carbone, the OnlyOffice conversion and PDF post-processing.

A run stores the determined language in `report_runs.report_locale`. Signing a run (`.p12` and GOST, including later, from “History”) and building another format from a snapshot use the run language (`runLocale`), not the current template setting. Runs made before 2.14.0 have no value and are treated as `'ru'`.

### What depends on the language

The tables are in `packages/shared/src/i18n/index.ts`:

| Language | `CARBONE_LANGS` (Carbone `options.lang`) | Default `formatC` currency | `OFFICE_REGIONS` (OnlyOffice region) | `PAGE_FORMATS` (default numbering) |
| --- | --- | --- | --- | --- |
| `ru` | `ru` | RUB | `ru-RU` | `Стр. {page} из {pages}` |
| `en` | `en-us` | USD | `en-US` | `Page {page} of {pages}` |
| `es` | `es-es` | EUR | `es-ES` | `Pág. {page} de {pages}` |
| `pt-BR` | `pt-br` | BRL | `pt-BR` | `Pág. {page} de {pages}` |
| `fr` | `fr-fr` | EUR | `fr-FR` | `Page {page} sur {pages}` |
| `de` | `de-de` | EUR | `de-DE` | `Seite {page} von {pages}` |
| `zh-CN` | `zh-cn` | CNY | `zh-CN` | `第 {page} 页，共 {pages} 页` |

- **Carbone.** `renderReport` (`apps/api/src/modules/reports/service.ts`) passes `lang: CARBONE_LANGS[language]`. For `ru` it is `ru`, not `ru-ru`: this way Carbone gives Russian separators and roubles in `formatC`, as before 2.14.0.
- **The currency follows the language.** `currencySource`/`currencyTarget` are not set, so `formatC()` without arguments prints the currency of the language (the table column), and `formatC(…,'USD')`/`convCurr` convert from it. When the template language changes, amounts change currency: check the report or set the currency in the tag. On `zh-CN`, `formatC` prints “¥” (the CNY symbol in Carbone).
- **OnlyOffice.** The conversion `region` (`apps/api/src/modules/render/onlyoffice-convert.ts`) is `OFFICE_REGIONS[language]`. The same table sets the document editor's `editorConfig.region`, but there it follows the interface language.
- **PDF page numbering.** `PdfPageNumbers.format` is optional. If no format is set, `buildPdfJob` (`apps/api/src/modules/pdf/finish.ts`) substitutes `PAGE_FORMATS[language]`; a format that is set is not changed. Migration 0017 removed the format from templates where it equaled the previous default “Стр. {page} из {pages}”, so Russian reports give the same result. `{page}` and `{pages}` use single curly braces: PDF post-processing substitutes them, not i18next.
- **Template editor, “PDF” tab** (`PdfTab.tsx`): the numbering format field is empty, and the format of the report language is shown as a hint (placeholder). The hint follows the saved template language (for “Same as the user”, the interface language). An empty field goes to the server without `format`. Before 2.14.0 the field was pre-filled from the catalog (`editor:pdf.pageFormatDefault`) — the key was removed, and so was `PDF_PAGE_FORMAT_DEFAULT`.
- **Signature stamp.** `stampLines` (`apps/api/src/modules/pdf/sign/sign-pdf.ts`): the texts are the keys `report:stamp.title|certificate|owner|valid|signed`; the date and time are `Intl.DateTimeFormat(localeTag(language))` in the server's `TZ` time zone. `localeTag` is a BCP 47 tag and matches `OFFICE_REGIONS`. For `ru` the lines and date format are exactly as before 2.14.0.

The `report` catalog is API-only (like `errors` and `validation`): the web app does not load it. This is why the default numbering format lives not in the catalog but in the `PAGE_FORMATS` table, which both the API and the template editor read.

### PDF font and Chinese text

The texts drawn by PDF post-processing (signature stamp, page numbering, watermark) are drawn with the fonts from `packages/carbone/assets/fonts`: Noto Sans (Regular and Bold) and, since 2.14.0, Noto Sans SC Regular (`NotoSansSC-Regular.ttf`, OFL, license in `NotoSansSC-OFL.txt`). The code is `apps/api/src/modules/pdf/font.ts`.

- **The font is chosen per line** (`pickPdfFont`): if all characters are in Noto Sans, Noto Sans is used (Bold for the stamp title); otherwise Noto Sans SC Regular, if it has the missing characters (the stamp title is then Regular too). Characters that are in neither font (for example, emoji) are replaced with “?” (`sanitizePdfText`).
- **Known limitation: a line with Chinese characters is drawn entirely with Noto Sans SC.** Characters that are not in it but are in Noto Sans are also printed as “?” in such a line: for example “₽”, the Ukrainian “і”, “ї”, “є”, “ґ”, the Polish “Ł” and many other Latin letters with diacritics, as well as emoji. Example: in the stamp on `zh-CN` the owner line begins with “所有者：”, so “Łukasz” is printed as “?ukasz”. Saving the PDF settings does not reject such characters: they are in one of the fonts.
- A subset of the characters used is embedded in the PDF. Noto Sans SC is read from disk at the first character that is not in Noto Sans, and is embedded in the PDF only if the document has a line with its characters. Before embedding, `alignGlyphs` aligns the glyph table of the Google Fonts file in memory, otherwise pdf-lib/fontkit corrupts the subset; the file on disk is not changed.
- The character check when saving the PDF settings (`unsupportedChars`, `apps/api/src/modules/templates/pdf.ts`) rejects only characters that are in neither font: a Chinese watermark or numbering format is saved, while emoji still give `400`.
- PDF metadata (title, author, subject, keywords) needs no font: PDF Info strings are Unicode, and Chinese characters and emoji are saved as they are. Lone surrogates and U+FFFE/U+FFFF, which are invalid in XML (XMP), are replaced with “?” (`cleanPdfMeta`).
- The cost: the API image is larger by about 10.5 MB; a render worker that encounters a line with Chinese characters loads the font — about 100 MB of process memory.

## Template help

Since 2.15.0 the “Template help” (`/admin/help`) is available in seven languages (specification, §46, in Russian). It is shown in the interface language and switches together with it without reloading the page; example anchors (`#fmt-money`) do not depend on the language. The example results are those that a report with the report language of the same language would give (dates, numbers and the `formatC` currency follow the table in the section “Report language”); there is an explanation of this above the sections (`help:resultsFor`).

### Where things are

- **Content** — one module per language: `apps/web/src/pages/admin/help/content/<language>.ts` (`ru.ts`, `en.ts`, `es.ts`, `pt-BR.ts`, `fr.ts`, `de.ts`, `zh-CN.ts`). A module exports `HELP_INTRO` and `HELP_SECTIONS`; the types are in `content/types.ts`. `ru.ts` is the source module and also the fallback.
- **Loading** — `loadHelpContent` in `content/index.ts`. `ru` is part of the help page chunk; the other languages are separate chunks, one line each in the `HELP_MODULES` table (`en: () => import('./en')`), loaded only when the help is opened in that language. If the language is not in `HELP_MODULES`, the help is shown in `ru` without a message; if the chunk failed to load (for example, after a version update), the help is shown in `ru` with the message `help:loadFailed`.
- **Labels of the page itself** (“Tag in the template”, “Data”, the SQL modes “List of rows”/“Single row”, “Copy”, “Note”, the hint about Word tables) — the `help` catalog namespace, like the rest of the interface.

### What is translated

- Translated: headings, introductory paragraphs (`intro`), notes (`note`), limitations (`limits[].title`, `limits[].instead`), the constant text inside templates, the values in the example data (the JSON keys stay the same), results (`result`); for examples with an image and HTML (`picture`, `rich`) the result is a description in words.
- Not translated: Carbone tags, field names (`d.…`, `c.…`), formatter names and their order, SQL queries (`sql.key`, `sql.mode`, `sql.text`), example and limitation `id`s, flags (`unavailable`, `antiPattern`, `picture`, `rich`).
- String arguments of formatters can be replaced with ones customary for the language (`formatD('MM/DD/YYYY')` in `en`, `formatD('YYYY-MM-DD')` in `zh-CN`), if `help:check` for that language confirms the result.
- Notes with Russian specifics (the rouble and `formatC`, `convCurr` with the built-in rates, Word menu names, Gosuslugi) are rewritten by meaning: the fact is the same, the example is for the currency and environment of the language. Statements about system behavior are the same in all languages.
- The help in every language except Russian warns that the error texts of the Carbone engine itself (images, barcodes, colors, charts, HTML) are shown in Russian — they are not translated (section “What is not translated”).
- Terms follow the glossary; quotes and punctuation follow the “Translation rules”.

### Checks

- **Results** — `pnpm help:check`: every example of every language is rendered by the built-in Carbone with `lang: CARBONE_LANGS[language]` and compared with the `result` of that language's module; the message about a formatter unavailable in the free version is the `errors:` one in the same language. `pnpm help:check -- --locale de` — one language only; `pnpm help:check -- --self-test` — only the DOCX build and text parsing (for all languages). On a mismatch the script prints “expected” and “got” and exits with code 1.
- **Structure** — `apps/web/src/pages/admin/help/content/structure.test.ts`: every module from `HELP_MODULES` is compared with `ru` — the same sections, examples and `limits[].id` in the same order, the same flags and `sql`, the same set of data paths in tags, the same formatters in the same order, `data` is valid JSON with the same keys. A language added to `HELP_MODULES` enters the test by itself. The earlier content checks (`content.test.ts`, including the canonical form of Word table rows “| cell |”) run for every module.
- **Cyrillic** — `pnpm i18n:check` checks the help like the rest of the web app: the only exception is `pages/admin/help/content/ru.ts`. There must be no Cyrillic in other modules or in `HelpPage.tsx`.

### How to translate the help into a new language

The example is `it` (first do steps 1–6 of “How to add a language”: without `CARBONE_LANGS` and the `help` catalog the help cannot be checked).

1. Copy `content/en.ts` (or `content/ru.ts`) to `content/it.ts` and translate by the rules above. Do not change the structure: sections, examples, tags, SQL and data keys stay as in `ru.ts`.
2. Add a line to `HELP_MODULES` (`content/index.ts`): `it: () => import('./it')`.
3. Get the results: put the expected text into `result` and run `pnpm help:check -- --locale it`. For each mismatch the script shows what Carbone gave with the report language `it`; check that it is the expected result (and not an error in the template or data) and move it into `result`. Then `pnpm help:check -- --self-test`.
4. Help tests: `pnpm --filter @carbone-reports/web exec vitest run src/pages/admin/help` (structure, content, page) and `pnpm i18n:check` (Cyrillic).
5. The language row in the “Language status” table — help “reviewed by a native speaker: no”.

## Keys

- **Names.** A key is `namespace:section.key`, in Latin camelCase, by meaning and not by the Russian text: `reports:run.sign`, `admin:users.block`. Nesting is at most two levels deep. `errors` keys in the API code are passed without the namespace prefix: `badRequest('sign.tooManyPasswords', { count })`, `notFound('template')` → `errors:notFound.template`.
- **Shared schema keys.** A schema message is a `validation` catalog key with the `v:` prefix: `z.uuid('v:invalidId')`. Before translation the API replaces `v:` with `validation:` (`apps/api/src/lib/errors.ts`). Schema messages are translated only by the API: the web app does not validate with the shared schemas. The API translates the built-in zod messages through `zodLocale(locale)`.
- **Parameters.** `{{name}}`; a translation has the same parameters as `ru`: they must not be renamed, removed or added. A parameter may be repeated. Parameter values are not escaped (React escapes by itself).
- **Plurals** — with CLDR suffixes; the set of forms for a language is given by `Intl.PluralRules(locale).resolvedOptions().pluralCategories`. The key is called without a suffix, with the `count` parameter.

  `ru` — `_one/_few/_many/_other`:

  ```json
  "tooManyPasswords_one": "слишком много неверных паролей — попробуйте через {{count}} минуту",
  "tooManyPasswords_few": "слишком много неверных паролей — попробуйте через {{count}} минуты",
  "tooManyPasswords_many": "слишком много неверных паролей — попробуйте через {{count}} минут",
  "tooManyPasswords_other": "слишком много неверных паролей — попробуйте через {{count}} минуты"
  ```

  `en` and `de` — `_one/_other`:

  ```json
  "tooManyPasswords_one": "too many wrong passwords — try again in {{count}} minute",
  "tooManyPasswords_other": "too many wrong passwords — try again in {{count}} minutes"
  ```

  `es`, `pt-BR` and `fr` — `_one/_many/_other` (the `_many` form is for large round numbers such as 1,000,000; the text is usually the same as `_other`).

  `zh-CN` — only `_other`:

  ```json
  "tooManyPasswords_other": "密码错误次数过多——请 {{count}} 分钟后重试"
  ```

  (`errors:sign.tooManyPasswords`.)

- **Phrases are not assembled from pieces.** Each phrase is one key with parameters; the translation sets the word order. Do not build text like `t('a') + name + t('b')`.
- **Links and markup inside a phrase** — the `Trans` component with named tags: `"Загрузите сертификат на странице «<page>Моя подпись</page>»"` (`reports:run.uploadCertificate`). Do not name a tag `<link>`: i18next treats it as an empty HTML element (like `<br>`), so the link comes out empty and its text ends up after it. `<page>`, `<a1>` and the like are fine.
- **Nested key references** `$t(namespace:key)` — to avoid duplicating the same wording. For example, in `admin:roleInTable` the languages other than `ru` have `"$t(common:role.admin)"`: in `ru` the role is written in lowercase in the users table, while in the other languages it matches the role name.
- **Adding text to the interface:** the key first in `ru`, then in all the other languages (by the glossary); in code — `t('ns:key', params)` from `useTranslation()`. Russian text directly in the web code does not pass `pnpm i18n:check`.

## Glossary

Terms are translated only as given in the table, in all catalogs and in all parts of the interface. Roles are written with a capital letter, as names (in the interface they stand alone: in the users table, in the menu).

| Русский | English | Español | Português (Brasil) | Français | Deutsch | 简体中文 |
| --- | --- | --- | --- | --- | --- | --- |
| шаблон | template | plantilla | modelo | modèle | Vorlage | 模板 |
| отчёт | report | informe | relatório | rapport | Bericht | 报表 |
| запуск (построение отчёта) | run | ejecución | execução | exécution | Ausführung | 运行 |
| сформировать (кнопка) | Generate | Generar | Gerar | Générer | Erstellen | 生成 |
| история (запусков) | history | historial | histórico | historique | Verlauf | 历史记录 |
| источник данных | data source | origen de datos | fonte de dados | source de données | Datenquelle | 数据源 |
| запрос | query | consulta | consulta | requête | Abfrage | 查询 |
| параметр | parameter | parámetro | parâmetro | paramètre | Parameter | 参数 |
| диаграмма | chart | gráfico | gráfico | graphique | Diagramm | 图表 |
| группа (пользователей) | group | grupo | grupo | groupe | Gruppe | 用户组 |
| категория (шаблонов) | category | categoría | categoria | catégorie | Kategorie | 类别 |
| доступен всем | available to everyone | disponible para todos | disponível para todos | accessible à tous | für alle verfügbar | 所有人可用 |
| владелец | owner | propietario | proprietário | propriétaire | Eigentümer | 所有者 |
| Редактор (роль) | Editor | Editor | Editor | Éditeur | Bearbeiter | 编辑者 |
| Менеджер безопасности (роль) | Security manager | Responsable de seguridad | Gerente de segurança | Responsable de la sécurité | Sicherheitsbeauftragter | 安全管理员 |
| Администратор (роль) | Administrator | Administrador | Administrador | Administrateur | Administrator | 管理员 |
| Пользователь (роль) | User | Usuario | Usuário | Utilisateur | Benutzer | 用户 |
| подпись (электронная) | signature | firma | assinatura | signature | Signatur | 签名 |
| штамп (подписи) | stamp | sello | carimbo | cachet | Stempel | 签章 |
| сертификат | certificate | certificado | certificado | certificat | Zertifikat | 证书 |
| превью | preview | vista previa | pré-visualização | aperçu | Vorschau | 预览 |
| выгрузить (архив шаблонов) | export | exportar | exportar | exporter | exportieren | 导出 |
| загрузить из архива | import from archive | importar desde archivo ZIP | importar de arquivo ZIP | importer depuis une archive | aus Archiv importieren | 从压缩包导入 |
| архив (шаблонов) | archive | archivo ZIP | arquivo ZIP | archive | Archiv | 压缩包 |
| блокировка правки | edit lock | bloqueo de edición | bloqueio de edição | verrouillage de modification | Bearbeitungssperre | 编辑锁定 |
| резервная копия | backup | copia de seguridad | backup | sauvegarde | Sicherung | 备份 |
| режим обслуживания | maintenance mode | modo de mantenimiento | modo de manutenção | mode maintenance | Wartungsmodus | 维护模式 |
| тег (метка Carbone в шаблоне) | tag | etiqueta | tag | balise | Tag (das) | 标签 |
| язык (интерфейса) | language | idioma | idioma | langue | Sprache | 语言 |
| логин (поле входа) | Login | Nombre de usuario | Login | Identifiant | Benutzername | 用户名 |
| пароль | password | contraseña | senha | mot de passe | Passwort | 密码 |
| войти / выйти | Sign in / Sign out | Iniciar sesión / Cerrar sesión | Entrar / Sair | Se connecter / Se déconnecter | Anmelden / Abmelden | 登录 / 退出 |
| заблокировать / разблокировать (пользователя) | Block / Unblock | Bloquear / Desbloquear | Bloquear / Desbloquear | Bloquer / Débloquer | Sperren / Entsperren | 禁用 / 启用 |
| заблокирован / активен (пользователь) | blocked / active | bloqueado / activo | bloqueado / ativo | bloqué / actif | gesperrt / aktiv | 已禁用 / 已启用 |
| журнал (бэкапа) | log | registro | log | journal | Protokoll | 日志 |

Notes on the table:

- `zh-CN`: blocking a user is 禁用/启用 (“disable/enable”), not 锁定: 锁定 is taken by the edit lock (编辑锁定).
- `de`: “tag” is „das Tag“ (neuter), not „der Tag“ (day).
- File size units (`common:size.*`): `ru` — Б, КБ, МБ, ГБ, ТБ; `fr` — o, Ko, Mo, Go, To; the other languages — B, KB, MB, GB, TB. The number is formatted by the `Intl.NumberFormat` of the current language (in `ru` and `fr`, with a decimal comma).

Common buttons and states (`common:action.*`, `common:status.*`):

| Русский | English | Español | Português (Brasil) | Français | Deutsch | 简体中文 |
| --- | --- | --- | --- | --- | --- | --- |
| Сохранить | Save | Guardar | Salvar | Enregistrer | Speichern | 保存 |
| Отмена | Cancel | Cancelar | Cancelar | Annuler | Abbrechen | 取消 |
| Удалить | Delete | Eliminar | Excluir | Supprimer | Löschen | 删除 |
| Закрыть | Close | Cerrar | Fechar | Fermer | Schließen | 关闭 |
| Изменить | Edit | Editar | Editar | Modifier | Bearbeiten | 编辑 |
| Добавить | Add | Añadir | Adicionar | Ajouter | Hinzufügen | 添加 |
| Загрузка… | Loading… | Cargando… | Carregando… | Chargement… | Wird geladen… | 正在加载… |
| Ошибка | Error | Error | Erro | Erreur | Fehler | 错误 |
| Как в браузере | Browser default | Según el navegador | Igual ao navegador | Langue du navigateur | Wie im Browser | 跟随浏览器 |

Interface labels that API errors refer to (`errors`, `validation`): the web app translates these sections, buttons and modes the same way.

| Русский | English | Español | Português (Brasil) | Français | Deutsch | 简体中文 |
| --- | --- | --- | --- | --- | --- | --- |
| Выйти везде | Sign out everywhere | Cerrar sesión en todas partes | Sair de todos os lugares | Se déconnecter partout | Überall abmelden | 在所有设备上退出 |
| Моя подпись | My signature | Mi firma | Minha assinatura | Ma signature | Meine Signatur | 我的签名 |
| Справка по шаблонам | Template help | Ayuda sobre plantillas | Ajuda sobre modelos | Aide sur les modèles | Hilfe zu Vorlagen | 模板帮助 |
| Список строк (режим запроса) | List of rows | Lista de filas | Lista de linhas | Liste de lignes | Liste von Zeilen | 行列表 |
| SQL-список (тип параметра) | SQL list | Lista SQL | Lista SQL | Liste SQL | SQL-Liste | SQL 列表 |
| SSL с проверкой | SSL with verification | SSL con verificación | SSL com verificação | SSL avec vérification | SSL mit Prüfung | SSL（验证证书） |
| обновить / копия / пропустить (загрузка из архива) | update / copy / skip | actualizar / copia / omitir | atualizar / cópia / ignorar | mettre à jour / copie / ignorer | aktualisieren / Kopie / überspringen | 更新 / 副本 / 跳过 |

## Translation rules

- The source of the texts is `ru`. Russian texts are not changed when moved into a catalog.
- Terms strictly follow the glossary. A new term is added to the glossary first, then to the catalogs.
- The tone is neutral and businesslike. The formal “you” form where the language distinguishes forms: `de` — “Sie”, `fr` — “vous”, `es` and `pt-BR` — neutral forms without “tú”/“tu”.
- Quotes and spaces follow the norms of the language:
  - `ru` — «guillemets»;
  - `en` — “…”;
  - `es` — «…»; `pt-BR` — “…”;
  - `fr` — « … » with non-breaking spaces inside and a non-breaking space before `: ; ! ?`;
  - `de` — „…“;
  - `zh-CN` — full-width punctuation `，。：；！？` and the quotes “…”.
- Interface terms in quotes (section and button names) match the translation of the sections and buttons themselves.
- The `{{name}}` parameters in a translation are the same as in `ru`: they must not be renamed, removed or added.
- Plurals — with CLDR suffixes (`Intl.PluralRules(locale).resolvedOptions().pluralCategories`): `ru` — `_one/_few/_many/_other`, `en` and `de` — `_one/_other`, `es`, `pt-BR` and `fr` — `_one/_many/_other`, `zh-CN` — only `_other`.
- Phrases are not assembled from pieces: each phrase is one key with parameters, and the translation sets the word order.
- What is not translated is in the section “What is not translated” below.

## How to add a language

The example is Italian, `it`. The tag is as in the browser (`navigator.languages`): the primary subtag, and the region only if it matters (`pt-BR`, `zh-CN`).

1. **Code and self-name** — `packages/shared/src/i18n/index.ts`:
   - `LOCALES` — add `'it'` to the end of the list (the list order is the order in the switcher);
   - `LOCALE_NAMES` — the self-name in the language itself: `it: 'Italiano'`;
   - `ZOD_LOCALES` — the built-in zod messages: `it: z.locales.it` (the name is in `z.locales`; if the language has none of its own, the closest one or `z.locales.en`).
2. **Matching browser languages** (`resolveLocale`) is built from `LOCALES` by itself: the exact tag, then the primary subtag. If the primary subtag already has a language (for example, `pt-PT` is added while `pt-BR` exists), the one that is last in `LOCALES` is chosen by the primary subtag — check that the order is what you need and add cases to `packages/shared/src/i18n/index.test.ts`.
3. **Catalogs:**
   - copy `packages/shared/src/i18n/ru/` to `packages/shared/src/i18n/it/` and translate all files by the glossary;
   - plural forms — by `Intl.PluralRules('it').resolvedOptions().pluralCategories` (remove the extra `ru` forms, add the missing ones);
   - `packages/shared/src/i18n/resources.ts` — an import of eleven files and an `it: { … }` block;
   - the glossary in this document — a column for the new language (and a row in the “Language status” table).
4. **Web:**
   - `apps/web/src/i18n/instance.ts` — add the language to every line of the `LAZY` list: `{en,es,pt-BR,fr,de,zh-CN,it}/<ns>.json`. Without this the language's catalogs do not get into the build, and switching the language ends with a “no catalog” error;
   - `apps/web/src/i18n/index.ts` — `DATE_LOCALES`: the dayjs locale name for `@gravity-ui/date-utils` (`it`);
   - uikit knows only `ru` and `en`; for a new language it stays `en` — nothing needs to be changed (`changeLocale` and `apps/web/src/app/App.tsx`).
5. **API:**
   - `DEFAULT_LOCALE` is checked against `LOCALES` by itself (`apps/api/src/config.ts`), but the list of languages is also spelled out in Helm (`charts/carbone-reports/templates/_validate.tpl`, a comment in `values.yaml`, the test `charts/carbone-reports/tests/validate_test.yaml`) and in a comment in `.env.example`.
6. **Reports** (section “Report language”), everything in `packages/shared/src/i18n/index.ts` except the catalog and the font:
   - `CARBONE_LANGS` — Carbone `options.lang` (`it-it`). The key must be in `packages/carbone/formatters/_locale.js` (otherwise Carbone uses `en`); `currency.code` is there too — the default `formatC` currency for the language, which is worth adding to the table in the section “Report language”;
   - `OFFICE_REGIONS` — the OnlyOffice region (`it-IT`): used both by the document editor and by the report conversion;
   - `localeTag` — the BCP 47 tag for the stamp dates; currently it matches `OFFICE_REGIONS`; check that `Intl.DateTimeFormat` gives the needed format with it;
   - `report.json` — the stamp lines (the catalog is copied from `ru` in step 3; the `{{…}}` parameters are the same);
   - `PAGE_FORMATS` — the default numbering format (`Pagina {page} di {pages}`), the `{page}`/`{pages}` braces are single;
   - the font — if the language's script is not covered by Noto Sans and Noto Sans SC, one more font is needed in `packages/carbone/assets/fonts` (with a license file and a line in `NOTICE.md`) and its selection in `apps/api/src/modules/pdf/font.ts`.
7. **Template help** — the module `apps/web/src/pages/admin/help/content/it.ts`, the line `it: () => import('./it')` in `HELP_MODULES` and the results through `pnpm help:check -- --locale it` (details in “How to translate the help into a new language”). Without the line in `HELP_MODULES`, `pnpm typecheck` fails (the table is a full `Record` over the languages except `ru`).
8. **Types and tests:** `pnpm typecheck` shows all `Record<Locale, …>` dictionaries that lack the language, including `HELP_MODULES` (the help). A missing help module is caught precisely by it: `HELP_MODULES` is a full `Record` over the languages except `ru` (`help:check` and the structure test go only over the table entries). The test `packages/shared/src/i18n/index.test.ts` compares the whole `LOCALES`, and the list of languages is also in `scripts/i18n-check.test.mjs`.
9. **Verification:** `pnpm i18n:check`, `pnpm test:scripts`, `pnpm help:check -- --locale it`, `pnpm --filter @carbone-reports/shared test`, `pnpm --filter @carbone-reports/web test`, `pnpm --filter @carbone-reports/web build`.
10. **Screenshot review.** The new language in the interface at 1280 and 375 px width: reports, report generation, templates, template editor (the “Document” and “PDF” tabs), the user dialog, the sign-in page. Look for truncated or overlapping labels, Cyrillic (except data from the database, see below), wrong quotes and punctuation. It is convenient to set the language before signing in: `localStorage['cr.locale'] = 'it'`.
11. **Native speaker review.** Until it is done, the language is marked in the table below as “reviewed by a native speaker: no”.

### How to add a namespace

1. `NAMESPACES` in `packages/shared/src/i18n/index.ts`.
2. A `<ns>.json` file in all languages and an import in `packages/shared/src/i18n/resources.ts`.
3. If the web app needs the texts — a line in the `RU` list and a line in the `LAZY` list in `apps/web/src/i18n/instance.ts`. Namespaces needed only by the API are not added to these lists.

## How to check completeness

`pnpm i18n:check` (`scripts/i18n-check.ts`; in CI it is in the “Checks” job). The check fails if:

- a language lacks a key that is in `ru`, or has an extra one; a namespace file is missing or extra;
- the `{{…}}` parameters in a translation do not match `ru` (compared as sets);
- the plural forms that CLDR requires for the language are missing, or there are extra ones;
- a string is empty or a key is nested deeper than two levels;
- in `apps/web/src` a string literal, template string or JSX text contains Cyrillic — an untranslated string. Not checked: comments, `*.test.*` files, the Russian help module `pages/admin/help/content/ru.ts` and the test helpers `test/**`;
- in `apps/api/src`, text with Cyrillic is passed to `new AppError(…)`, `badRequest(…)`, `notFound(…)`, `conflict(…)`, `forbidden(…)` instead of a key.

A check on a different set of files (this is how the tests `scripts/i18n-check.test.mjs` run it): `pnpm i18n:check <directory> --web-src=<directory>`.

What the check does not see: translation quality, term consistency, label length in the interface. These are covered by the glossary, the screenshot review and the native speaker review.

## Language status

| Language | Code | Interface and reports reviewed by a native speaker | Template help reviewed by a native speaker |
| --- | --- | --- | --- |
| Русский | `ru` | source language | source language |
| English | `en` | no | no |
| Español | `es` | no | no |
| Português (Brasil) | `pt-BR` | no | no |
| Français | `fr` | no | no |
| Deutsch | `de` | no | no |
| 简体中文 | `zh-CN` | no | no |

The translations were made by the glossary and accepted by the project owner, but native speakers have not reviewed them yet. The help (2.15.0) is reviewed separately: its text is much larger than the catalogs.

### How to submit corrections

A pull request with a change to the catalog `packages/shared/src/i18n/<language>/<namespace>.json` or to the help module `apps/web/src/pages/admin/help/content/<language>.ts`:

- only values change; the keys and the `{{…}}` parameters stay;
- if a change alters a term, in the same pull request fix the glossary in this document and all places in the catalogs where the term occurs;
- in a help module only texts change: tags, field names, SQL, data keys and `id`s stay (the structure test compares them); if you changed the data or a formatter's string argument, update `result` from `pnpm help:check -- --locale <language>`;
- if a language has been reviewed in full, change its row in the “Language status” table to “yes” (the interface and the help are separate columns);
- before submitting — `pnpm i18n:check` (and for the help — `pnpm help:check -- --locale <language>`).

## What is not translated

Stays in Russian in all languages:

- **Texts for the operator:** the server log, configuration errors at startup (`apps/api/src/config.ts`), messages of CLI scripts (`scripts/`).
- **Texts that are saved to the database at the moment of writing** (translating them would mean storing a key and parameters, which is outside stage 1):
  - the run error text in “History”;
  - the OnlyOffice document save error (`lastSaveError`) in the template editor;
  - the “(копия)” suffix in the name of a copied template.
- **Backup agent responses** that the API passes on as they are.
- **Carbone engine error texts** in a template (charts, html, images): the API passes them as `{{message}}` inside the generation error message.
- **The GOST key algorithm label** (“ГОСТ Р 34.10-2012 (256)”): it is stored in the database in Russian and shown on the “My signature” page in all languages.
- **User data:** names of templates, categories, groups, sources, descriptions.

In reports (2.14.0) the following are not localized:

- **The text of the template itself:** the report language changes formats, the stamp and numbering, but not the words in the document. Translation inside a template (`{t()}` and Carbone dictionaries) is not supported.
- **Chinese text in charts:** charts are drawn only with the Noto Sans font, which has no Chinese characters. Noto Sans SC is used only by PDF post-processing.

Stage 1 limitations:

- The date in the report parameters form is entered as DD.MM.YYYY in all languages: the `@gravity-ui/date-components` calendar knows only `ru` and `en`.
- At a width of 375 px the application shell does not adapt to the screen; this was so before localization too, in all languages.

Stage 4 (documentation) — section [“Documentation”](#documentation).

## Documentation

Documents for those who install and maintain the system exist in Russian and English (specification, §48, in Russian). Russian is the source; the English version lies next to it with the `.en.md` suffix:

| Russian | English |
| --- | --- |
| `README.md` | `README.en.md` |
| `docs/localization.md` | `docs/localization.en.md` |
| `docs/operations/gost-signature.md` | `docs/operations/gost-signature.en.md` |
| `docs/operations/keycloak.md` | `docs/operations/keycloak.en.md` |

`CHANGELOG.md`, `docs/superpowers/` and the README of the test fixtures are not translated. A new document for administrators is added to `DOC_PAIRS` (`scripts/docs-check.mjs`) together with its English version.

Translation rules:

- the first line is the language switcher: `**Русский** · [English](<name>.en.md)` in Russian, `[Русский](<name>.md) · **English**` in English;
- in code blocks only comments and `<…>` placeholders are translated; commands, file names, variable names, keys and values are not changed;
- interface labels are taken verbatim from the `en` catalogs (`packages/shared/src/i18n/en/*.json`);
- links from an English document lead to the English pairs; links to documents without a pair are marked “(in Russian)”;
- sections, heading levels, tables and code blocks follow the same order as in the Russian document.

A change to the Russian document is accompanied by a change to the English one in the same PR. `pnpm docs:check` (the “Checks” CI step) compares the pairs: the switcher, heading levels, code blocks up to comments and placeholders, and the existence of files and anchors of relative links in both versions.
