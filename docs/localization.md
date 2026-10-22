# Локализация интерфейса и отчётов

Языки интерфейса и отчётов: `ru` (основной и исходный), `en`, `es`, `pt-BR`, `fr`, `de`, `zh-CN` (спецификация, §44 и §45). Языков с письмом справа налево нет.

Локализация идёт по этапам:

1. Интерфейс, ошибки API, форматы дат в интерфейсе и этот документ — 2.13.0.
2. Отчёты: язык форматов Carbone, штампа подписи и нумерации страниц PDF — 2.14.0 (раздел «Язык отчёта»).
3. Справка по шаблонам — 2.15.0 (раздел «Справка по шаблонам»).
4. Документация (README, `docs/`).

## Каталоги и пространства имён

Каталоги лежат в `packages/shared/src/i18n/<язык>/<пространство имён>.json`, формат — i18next JSON v4. Источник — `ru`; в остальных языках те же ключи. Список пространств имён — `NAMESPACES` в `packages/shared/src/i18n/index.ts`.

| Пространство имён | Что в нём | Где используется |
| --- | --- | --- |
| `common` | Роли, меню и оболочка, вход, переключатель языка, общие кнопки и состояния, режим обслуживания, фазы бэкапа, длительность, размеры файлов, подписи параметров | веб |
| `reports` | Список отчётов и построение отчёта | веб |
| `history` | История запусков | веб |
| `signature` | «Моя подпись», окна подписи `.p12` и ГОСТ, проверка плагина КриптоПро | веб |
| `templates` | Список шаблонов, создание, выгрузка и загрузка из архива, доступ | веб |
| `editor` | Редактор шаблона: вкладки, документ, данные, диаграммы, параметры, PDF, настройки | веб |
| `help` | Подписи страницы «Справка по шаблонам» (содержимое справки — модули `content/<язык>.ts`, раздел «Справка по шаблонам») | веб |
| `admin` | Пользователи, группы, категории, источники данных, доступ к отчётам, бэкапы и восстановление | веб |
| `errors` | Тексты ошибок API (`AppError`, коды Fastify `FST_*`) | только API |
| `validation` | Собственные сообщения схем shared (ключи `v:…`) | только API |
| `report` | Тексты внутри отчёта: строки штампа подписи PDF (`report:stamp.*`) | только API |

Как каталоги попадают в приложения:

- **API** берёт все языки и пространства имён сразу: `packages/shared/src/i18n/resources.ts` (импорт каждого файла) и `createTranslator(locale)` из `packages/shared/src/i18n/server.ts`.
- **Веб** (`apps/web/src/i18n/instance.ts`):
  - каталоги `ru` входят в основной бандл (`import.meta.glob` с `eager: true`, список `RU`);
  - остальные языки — отдельные чанки, по одному на язык и пространство имён (список `LAZY`). Они загружаются при выборе языка вместе с запасным `en`.
  - В оба списка пространства имён вписаны явно, по строке на каждое. `errors`, `validation` и `report` в списки не входят: эти тексты переводит API, и в бандл веба они попадать не должны.
  - Исключения вида `!…/errors.json` в шаблонах `import.meta.glob` не используйте: Vitest не применяет их к путям вне пакета веба, и тесты со сборкой видят разные наборы каталогов; поэтому нужные файлы перечисляются явно.
- Запасная цепочка при отсутствии ключа: `<язык>` → `en` → `ru`. В рабочем выпуске до неё не доходит: недостающий ключ ловит `pnpm i18n:check`.

## Выбор языка

Язык интерфейса (веб, `apps/web/src/i18n/index.ts`, функция `pickLocale`) выбирается в таком порядке:

1. `me.locale` — язык, который пользователь выбрал в меню (хранится в `users.locale`, `PUT /api/me/locale`).
2. Выбор на странице входа — `localStorage`, ключ `cr.locale`. Он продолжает действовать и после входа, пока `me.locale` пустой.
3. Язык браузера: первый из `navigator.languages`, у которого есть каталог. Сравнение идёт по точному тегу без учёта регистра, затем по основному подтегу: `pt-PT` → `pt-BR`, `zh-TW`/`zh-HK` → `zh-CN`, `en-GB` → `en`, `de-AT` → `de` (`resolveLocale` в `packages/shared/src/i18n/index.ts`).
4. `DEFAULT_LOCALE` сервера (публичный `GET /api/i18n` → `{ defaultLocale }`; по умолчанию `ru`, в Helm — `config.defaultLocale`).

Переключатель (`apps/web/src/i18n/LocaleSwitcher.tsx`):

- в нижнем меню боковой панели («Язык»): выбор сразу меняет язык и сохраняется через `PUT /api/me/locale`;
- на странице входа: выбор хранится только в `localStorage` (`cr.locale`);
- пункт «Как в браузере» в меню сбрасывает `me.locale` в `null` и удаляет `cr.locale`; язык снова берётся из браузера или `DEFAULT_LOCALE`.

Вместе с языком (`changeLocale`) меняются:

- `<html lang>`;
- язык uikit: `ThemeProvider lang` и `configure({ lang })`. uikit знает только `ru` и `en`, поэтому для всех языков, кроме `ru`, ставится `en`;
- локаль `@gravity-ui/date-utils` (`DATE_LOCALES`: `ru`, `en`, `es`, `pt-br`, `fr`, `de`, `zh-cn`);
- `Intl.*` и `localeCompare` в `apps/web/src/lib/format.ts`, `ReportsPage`, `DocumentTab` — по текущему языку;
- заголовок `X-Locale: <язык>` у каждого запроса `api/*` (`setRequestLocale` в `apps/web/src/api/client.ts`).

Язык ответа API (`req.locale`, `apps/api/src/lib/locale.ts`):

1. `X-Locale`, если значение есть в `LOCALES`;
2. иначе лучший язык из `Accept-Language` (по убыванию `q`) по тому же правилу `resolveLocale`;
3. иначе `DEFAULT_LOCALE`.

Для текстов ответа сервер `users.locale` не читает: выбор пользователя веб уже учёл в `X-Locale`. Исключение — язык отчёта «Как у пользователя» (`'user'`), см. «Язык отчёта». Внутренние маршруты (`/internal/…`) всегда работают на `DEFAULT_LOCALE`. На языке запроса API отдаёт тексты ошибок и язык редактора OnlyOffice (`editorConfig.lang` и `region`, `apps/api/src/modules/onlyoffice/editor-config.ts`).

## Язык отчёта

С 2.14.0 у шаблона есть свой язык отчёта (спецификация, §45), независимый от языка интерфейса. Он задаёт формат дат и чисел Carbone, валюту `formatC` по умолчанию, регион конвертации OnlyOffice, строки штампа подписи и формат нумерации страниц PDF. Текст самого шаблона не переводится.

### Настройка шаблона

- Поле «Язык отчёта» во вкладке «Настройки» редактора шаблона (`apps/web/src/pages/admin/template-editor/SettingsTab.tsx`): семь языков (самоназвания из `LOCALE_NAMES`) и «Как у пользователя». Менять может тот, у кого есть право правки шаблона.
- Хранится в `templates.report_locale`: язык из `LOCALES` или `'user'`. Тип `ReportLocale`, схема `zodReportLocale` (`packages/shared/src/i18n/index.ts`); в API — поле `reportLocale` в `TemplateAdminDetails` и в теле `PATCH /api/templates/:id`.
- Миграция 0017 (`apps/api/drizzle/0017_report_locale.sql`) записывает всем существующим шаблонам `'ru'`: прежние отчёты строятся по-русски при любом `DEFAULT_LOCALE`.
- Новый шаблон получает `DEFAULT_LOCALE`, копия («Дублировать») — язык исходного шаблона.
- Выгрузка шаблонов несёт `reportLocale`. При загрузке из архива нет значения (выгрузки до 2.14.0) — `'ru'`; неизвестное значение — `400 IMPORT_INVALID`, как прочие ошибки манифеста.

### Какой язык у построения

`resolveReportLocale` в `apps/api/src/modules/reports/report-locale.ts`:

1. язык шаблона, если это не `'user'`;
2. для `'user'` — язык профиля строящего (`users.locale`), если он задан и есть в `LOCALES`;
3. иначе язык запроса (`X-Locale` → `Accept-Language`, см. «Выбор языка»);
4. иначе `DEFAULT_LOCALE`.

Язык определяется один раз на построение (превью в редакторе и построение отчёта — по одному правилу) и передаётся дальше: в Carbone, конвертацию OnlyOffice и постобработку PDF.

Запуск хранит определённый язык в `report_runs.report_locale`. Подпись запуска (`.p12` и ГОСТ, в том числе позже, из «Истории») и сборка другого формата из снимка берут язык запуска (`runLocale`), а не текущую настройку шаблона. У запусков до 2.14.0 значения нет — они считаются `'ru'`.

### Что зависит от языка

Таблицы — в `packages/shared/src/i18n/index.ts`:

| Язык | `CARBONE_LANGS` (`options.lang` Carbone) | Валюта `formatC` по умолчанию | `OFFICE_REGIONS` (регион OnlyOffice) | `PAGE_FORMATS` (нумерация по умолчанию) |
| --- | --- | --- | --- | --- |
| `ru` | `ru` | RUB | `ru-RU` | `Стр. {page} из {pages}` |
| `en` | `en-us` | USD | `en-US` | `Page {page} of {pages}` |
| `es` | `es-es` | EUR | `es-ES` | `Pág. {page} de {pages}` |
| `pt-BR` | `pt-br` | BRL | `pt-BR` | `Pág. {page} de {pages}` |
| `fr` | `fr-fr` | EUR | `fr-FR` | `Page {page} sur {pages}` |
| `de` | `de-de` | EUR | `de-DE` | `Seite {page} von {pages}` |
| `zh-CN` | `zh-cn` | CNY | `zh-CN` | `第 {page} 页，共 {pages} 页` |

- **Carbone.** `renderReport` (`apps/api/src/modules/reports/service.ts`) передаёт `lang: CARBONE_LANGS[язык]`. Для `ru` — `ru`, а не `ru-ru`: так Carbone даёт русские разделители и рубли в `formatC`, как до 2.14.0.
- **Валюта следует за языком.** `currencySource`/`currencyTarget` не задаются, поэтому `formatC()` без аргументов печатает валюту языка (столбец таблицы), а `formatC(…,'USD')`/`convCurr` пересчитывают из неё. При смене языка шаблона суммы меняют валюту: проверьте отчёт или задайте валюту в метке. На `zh-CN` `formatC` печатает «¥» (символ CNY в Carbone).
- **OnlyOffice.** `region` конвертации (`apps/api/src/modules/render/onlyoffice-convert.ts`) — `OFFICE_REGIONS[язык]`. Та же таблица задаёт `editorConfig.region` редактора документа, но там — по языку интерфейса.
- **Нумерация страниц PDF.** `PdfPageNumbers.format` необязателен. Формат не задан — `buildPdfJob` (`apps/api/src/modules/pdf/finish.ts`) подставляет `PAGE_FORMATS[язык]`; заданный формат не меняется. Миграция 0017 удалила формат у шаблонов, где он был равен прежнему умолчанию «Стр. {page} из {pages}», — у русских отчётов результат тот же. `{page}` и `{pages}` — одинарные фигурные скобки: их подставляет постобработка PDF, а не i18next.
- **Редактор шаблона, вкладка «PDF»** (`PdfTab.tsx`): поле формата нумерации пустое, а формат языка отчёта показан подсказкой (placeholder). Подсказка следует за сохранённым языком шаблона (для «Как у пользователя» — за языком интерфейса). Пустое поле уходит на сервер без `format`. До 2.14.0 поле предзаполнялось из каталога (`editor:pdf.pageFormatDefault`) — ключ удалён, `PDF_PAGE_FORMAT_DEFAULT` тоже.
- **Штамп подписи.** `stampLines` (`apps/api/src/modules/pdf/sign/sign-pdf.ts`): тексты — ключи `report:stamp.title|certificate|owner|valid|signed`, дата и время — `Intl.DateTimeFormat(localeTag(язык))` в часовом поясе `TZ` сервера. `localeTag` — тег BCP 47, совпадает с `OFFICE_REGIONS`. Для `ru` строки и формат дат — дословно как до 2.14.0.

Каталог `report` — только для API (как `errors` и `validation`): веб его не загружает. Поэтому формат нумерации по умолчанию лежит не в каталоге, а в таблице `PAGE_FORMATS` — её читают и API, и редактор шаблона.

### Шрифт PDF и китайский текст

Тексты, которые рисует постобработка PDF (штамп подписи, нумерация страниц, водяной знак), рисуются шрифтами из `packages/carbone/assets/fonts`: Noto Sans (Regular и Bold) и, с 2.14.0, Noto Sans SC Regular (`NotoSansSC-Regular.ttf`, OFL, лицензия — `NotoSansSC-OFL.txt`). Код — `apps/api/src/modules/pdf/font.ts`.

- **Шрифт выбирается на строку** (`pickPdfFont`): все символы есть в Noto Sans — Noto Sans (Bold для заголовка штампа); иначе Noto Sans SC Regular, если в нём есть недостающие символы (заголовок штампа тогда тоже Regular). Символы, которых нет ни в одном из двух шрифтов (например, эмодзи), заменяются на «?» (`sanitizePdfText`).
- **Известное ограничение: строка с иероглифами рисуется целиком шрифтом Noto Sans SC.** Символы, которых в нём нет, а в Noto Sans есть, в такой строке тоже печатаются как «?»: например, «₽», украинские «і», «ї», «є», «ґ», польская «Ł» и многие другие латинские буквы с диакритикой, а также эмодзи. Пример: в штампе на `zh-CN` строка владельца начинается с «所有者：», поэтому «Łukasz» печатается как «?ukasz». Сохранение настроек PDF такие символы не отклоняет: они есть в одном из шрифтов.
- В PDF встраивается подмножество использованных символов. Noto Sans SC читается с диска при первом символе, которого нет в Noto Sans, а встраивается в PDF, только если в документе есть строка с его символами. Перед встраиванием `alignGlyphs` в памяти выравнивает таблицу глифов файла с Google Fonts, иначе pdf-lib/fontkit портит подмножество; файл на диске не меняется.
- Проверка символов при сохранении настроек PDF (`unsupportedChars`, `apps/api/src/modules/templates/pdf.ts`) отклоняет только символы, которых нет ни в одном из двух шрифтов: китайский водяной знак или формат нумерации сохраняются, эмодзи — по-прежнему `400`.
- Метаданные PDF (название, автор, тема, ключевые слова) шрифта не требуют: строки Info PDF — Юникод, иероглифы и эмодзи сохраняются как есть. Одиночные суррогаты и U+FFFE/U+FFFF, недопустимые в XML (XMP), заменяются на «?» (`cleanPdfMeta`).
- Цена: образ API больше примерно на 10,5 МБ; поток рендера, которому встретилась строка с иероглифами, загружает шрифт — около 100 МБ памяти процесса.

## Справка по шаблонам

С 2.15.0 «Справка по шаблонам» (`/admin/help`) — на семи языках (спецификация, §46). Она показывается на языке интерфейса и переключается вместе с ним без перезагрузки страницы; якоря примеров (`#fmt-money`) не зависят от языка. Результаты примеров — те, что даст отчёт с языком отчёта того же языка (даты, числа и валюта `formatC` — по таблице раздела «Язык отчёта»); над разделами об этом есть пояснение (`help:resultsFor`).

### Где что лежит

- **Содержимое** — по модулю на язык: `apps/web/src/pages/admin/help/content/<язык>.ts` (`ru.ts`, `en.ts`, `es.ts`, `pt-BR.ts`, `fr.ts`, `de.ts`, `zh-CN.ts`). Модуль экспортирует `HELP_INTRO` и `HELP_SECTIONS`, типы — `content/types.ts`. `ru.ts` — исходный модуль, он же запасной.
- **Загрузка** — `loadHelpContent` в `content/index.ts`. `ru` входит в чанк страницы справки; остальные языки — отдельные чанки по строке в таблице `HELP_MODULES` (`en: () => import('./en')`), загружаются только при открытии справки на этом языке. Языка нет в `HELP_MODULES` — справка на `ru` без сообщения; чанк не загрузился (например, после обновления версии) — справка на `ru` и сообщение `help:loadFailed`.
- **Подписи самой страницы** («Тег в шаблоне», «Данные», режимы SQL «Список строк»/«Одна строка», «Копировать», «Внимание», подсказка о таблицах Word) — пространство имён каталога `help`, как остальной интерфейс.

### Что переводится

- Переводятся: заголовки, вводные абзацы (`intro`), заметки (`note`), ограничения (`limits[].title`, `limits[].instead`), постоянный текст внутри шаблонов, значения в данных примеров (ключи JSON те же), результаты (`result`); у примеров с картинкой и HTML (`picture`, `rich`) результат — описание словами.
- Не переводятся: теги Carbone, имена полей (`d.…`, `c.…`), имена форматтеров и их порядок, SQL-запросы (`sql.key`, `sql.mode`, `sql.text`), `id` примеров и ограничений, флаги (`unavailable`, `antiPattern`, `picture`, `rich`).
- Строковые аргументы форматтеров можно заменить на привычные для языка (`formatD('MM/DD/YYYY')` в `en`, `formatD('YYYY-MM-DD')` в `zh-CN`), если `help:check` для этого языка подтверждает результат.
- Заметки с русской спецификой (рубль и `formatC`, `convCurr` по встроенным курсам, названия меню Word, Госуслуги) переписаны по смыслу: факт тот же, пример — для валюты и окружения языка. Утверждения о поведении системы во всех языках одинаковые.
- Справка во всех языках предупреждает, что тексты ошибок самого движка Carbone (изображения, штрихкоды, цвета, диаграммы, HTML) показываются на русском — они не переводятся (раздел «Что не переводится»).
- Термины — по глоссарию, кавычки и пунктуация — по «Правилам перевода».

### Проверки

- **Результаты** — `pnpm help:check`: каждый пример каждого языка рендерится встроенным Carbone с `lang: CARBONE_LANGS[язык]` и сверяется с `result` модуля этого языка; сообщение о недоступном в бесплатной версии форматтере — `errors:` на том же языке. `pnpm help:check -- --locale de` — только один язык; `pnpm help:check -- --self-test` — только сборка DOCX и разбор текста (всех языков). При расхождении скрипт печатает «ожидалось» и «получено» и выходит с кодом 1.
- **Структура** — `apps/web/src/pages/admin/help/content/structure.test.ts`: каждый модуль из `HELP_MODULES` сравнивается с `ru` — те же разделы, примеры и `limits[].id` в том же порядке, те же флаги и `sql`, тот же набор путей данных в тегах, те же форматтеры в том же порядке, `data` — корректный JSON с теми же ключами. Язык, добавленный в `HELP_MODULES`, попадает в тест сам. Прежние проверки содержимого (`content.test.ts`, в том числе каноничность строк таблиц Word «| ячейка |») выполняются для каждого модуля.
- **Кириллица** — `pnpm i18n:check` проверяет справку так же, как остальной веб: исключение — только `pages/admin/help/content/ru.ts`. В других модулях и в `HelpPage.tsx` кириллицы быть не должно.

### Как перевести справку на новый язык

Пример — `it` (сначала — шаги 1–6 «Как добавить язык»: без `CARBONE_LANGS` и каталога `help` справку не проверить).

1. Скопировать `content/en.ts` (или `content/ru.ts`) в `content/it.ts` и перевести по правилам выше. Структуру не менять: разделы, примеры, теги, SQL и ключи данных остаются как в `ru.ts`.
2. Добавить строку в `HELP_MODULES` (`content/index.ts`): `it: () => import('./it')`.
3. Получить результаты: вписать в `result` ожидаемый текст и запустить `pnpm help:check -- --locale it`. Для каждого расхождения скрипт показывает, что дал Carbone с языком отчёта `it`; проверьте, что это ожидаемый результат (а не ошибка в шаблоне или данных), и перенесите его в `result`. Затем — `pnpm help:check -- --self-test`.
4. Тесты справки: `pnpm --filter @carbone-reports/web exec vitest run src/pages/admin/help` (структура, содержимое, страница) и `pnpm i18n:check` (кириллица).
5. Строка языка в таблице «Состояние языков» — справка «вычитана носителем: нет».

## Ключи

- **Имена.** Ключ — `пространство:раздел.ключ`, латиницей в camelCase, по смыслу, а не по русскому тексту: `reports:run.sign`, `admin:users.block`. Вложенность — не глубже двух уровней. Ключи `errors` в коде API передаются без префикса пространства имён: `badRequest('sign.tooManyPasswords', { count })`, `notFound('template')` → `errors:notFound.template`.
- **Ключи схем shared.** Сообщение схемы — ключ каталога `validation` с префиксом `v:`: `z.uuid('v:invalidId')`. Перед переводом API заменяет `v:` на `validation:` (`apps/api/src/lib/errors.ts`). Сообщения схем переводит только API: веб схемы shared не проверяет. Встроенные сообщения zod API переводит через `zodLocale(locale)`.
- **Параметры.** `{{name}}`, в переводе — те же параметры, что в `ru`: нельзя переименовывать, удалять или добавлять. Повторить параметр можно. Значения параметров не экранируются (React экранирует сам).
- **Множественное число** — суффиксами CLDR, набор форм для языка даёт `Intl.PluralRules(locale).resolvedOptions().pluralCategories`. Ключ вызывается без суффикса, с параметром `count`.

  `ru` — `_one/_few/_many/_other`:

  ```json
  "tooManyPasswords_one": "слишком много неверных паролей — попробуйте через {{count}} минуту",
  "tooManyPasswords_few": "слишком много неверных паролей — попробуйте через {{count}} минуты",
  "tooManyPasswords_many": "слишком много неверных паролей — попробуйте через {{count}} минут",
  "tooManyPasswords_other": "слишком много неверных паролей — попробуйте через {{count}} минуты"
  ```

  `en` и `de` — `_one/_other`:

  ```json
  "tooManyPasswords_one": "too many wrong passwords — try again in {{count}} minute",
  "tooManyPasswords_other": "too many wrong passwords — try again in {{count}} minutes"
  ```

  `es`, `pt-BR` и `fr` — `_one/_many/_other` (форма `_many` — для больших круглых чисел вроде 1 000 000, текст обычно как у `_other`).

  `zh-CN` — только `_other`:

  ```json
  "tooManyPasswords_other": "密码错误次数过多——请 {{count}} 分钟后重试"
  ```

  (`errors:sign.tooManyPasswords`.)

- **Фразы не склеиваются из кусков.** Каждая фраза — один ключ с параметрами, порядок слов задаёт перевод. Нельзя собирать текст как `t('a') + name + t('b')`.
- **Ссылки и разметка внутри фразы** — компонент `Trans` с именованными тегами: `"Загрузите сертификат на странице «<page>Моя подпись</page>»"` (`reports:run.uploadCertificate`). Не называйте тег `<link>`: i18next считает его пустым элементом HTML (как `<br>`), ссылка выходит пустой, а её текст оказывается после неё. Подходят `<page>`, `<a1>` и т. п.
- **Вложенные ссылки на ключ** `$t(пространство:ключ)` — чтобы не дублировать одну и ту же формулировку. Например, в `admin:roleInTable` у языков, кроме `ru`, стоит `"$t(common:role.admin)"`: в `ru` в таблице пользователей роль пишется со строчной буквы, а в остальных языках совпадает с названием роли.
- **Добавить текст в интерфейс:** ключ сначала в `ru`, затем во все остальные языки (по глоссарию); в коде — `t('ns:key', params)` из `useTranslation()`. Русский текст прямо в коде веба не проходит `pnpm i18n:check`.

## Глоссарий

Термины переводятся только так, как указано в таблице, во всех каталогах и во всех разделах интерфейса. Роли пишутся с прописной буквы, как названия (в интерфейсе они стоят отдельно: в таблице пользователей, в меню).

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

Уточнения к таблице:

- `zh-CN`: блокировка пользователя — 禁用/启用 («отключить/включить»), а не 锁定: 锁定 занято блокировкой правки (编辑锁定).
- `de`: «тег» — „das Tag“ (средний род), не „der Tag“ (день).
- Единицы размера файлов (`common:size.*`): `ru` — Б, КБ, МБ, ГБ, ТБ; `fr` — o, Ko, Mo, Go, To; остальные языки — B, KB, MB, GB, TB. Число форматирует `Intl.NumberFormat` текущего языка (в `ru` и `fr` — десятичная запятая).

Общие кнопки и состояния (`common:action.*`, `common:status.*`):

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

Подписи интерфейса, на которые ссылаются ошибки API (`errors`, `validation`): веб переводит эти разделы, кнопки и режимы так же.

| Русский | English | Español | Português (Brasil) | Français | Deutsch | 简体中文 |
| --- | --- | --- | --- | --- | --- | --- |
| Выйти везде | Sign out everywhere | Cerrar sesión en todas partes | Sair de todos os lugares | Se déconnecter partout | Überall abmelden | 在所有设备上退出 |
| Моя подпись | My signature | Mi firma | Minha assinatura | Ma signature | Meine Signatur | 我的签名 |
| Справка по шаблонам | Template help | Ayuda sobre plantillas | Ajuda sobre modelos | Aide sur les modèles | Hilfe zu Vorlagen | 模板帮助 |
| Список строк (режим запроса) | List of rows | Lista de filas | Lista de linhas | Liste de lignes | Liste von Zeilen | 行列表 |
| SQL-список (тип параметра) | SQL list | Lista SQL | Lista SQL | Liste SQL | SQL-Liste | SQL 列表 |
| SSL с проверкой | SSL with verification | SSL con verificación | SSL com verificação | SSL avec vérification | SSL mit Prüfung | SSL（验证证书） |
| обновить / копия / пропустить (загрузка из архива) | update / copy / skip | actualizar / copia / omitir | atualizar / cópia / ignorar | mettre à jour / copie / ignorer | aktualisieren / Kopie / überspringen | 更新 / 副本 / 跳过 |

## Правила перевода

- Источник текстов — `ru`. Русские тексты при переносе в каталог не меняются.
- Термины — строго по глоссарию. Новый термин сначала добавляется в глоссарий, потом в каталоги.
- Тон нейтральный, деловой. Обращение на «вы» там, где язык различает формы: `de` — «Sie», `fr` — «vous», `es` и `pt-BR` — нейтральные формы без «tú»/«tu».
- Кавычки и пробелы — по нормам языка:
  - `ru` — «ёлочки»;
  - `en` — “…”;
  - `es` — «…»; `pt-BR` — “…”;
  - `fr` — « … » с неразрывными пробелами внутри и неразрывный пробел перед `: ; ! ?`;
  - `de` — „…“;
  - `zh-CN` — полноширинная пунктуация `，。：；！？` и кавычки “…”.
- Термины интерфейса в кавычках (названия разделов, кнопок) совпадают с переводом самих разделов и кнопок.
- Параметры `{{name}}` в переводе те же, что в `ru`: их нельзя переименовывать, удалять или добавлять.
- Множественное число — суффиксами CLDR (`Intl.PluralRules(locale).resolvedOptions().pluralCategories`): `ru` — `_one/_few/_many/_other`, `en` и `de` — `_one/_other`, `es`, `pt-BR` и `fr` — `_one/_many/_other`, `zh-CN` — только `_other`.
- Фразы не склеиваются из кусков: каждая фраза — один ключ с параметрами, порядок слов задаёт перевод.
- Что не переводится — в разделе «Что не переводится» ниже.

## Как добавить язык

Пример — итальянский, `it`. Тег — как у браузера (`navigator.languages`): основной подтег, а регион — только если он важен (`pt-BR`, `zh-CN`).

1. **Код и самоназвание** — `packages/shared/src/i18n/index.ts`:
   - `LOCALES` — добавить `'it'` в конец списка (порядок списка — порядок в переключателе);
   - `LOCALE_NAMES` — самоназвание на самом языке: `it: 'Italiano'`;
   - `ZOD_LOCALES` — встроенные сообщения zod: `it: z.locales.it` (имя — в `z.locales`; если для языка нет своих, ближайшее или `z.locales.en`).
2. **Сопоставление языков браузера** (`resolveLocale`) строится из `LOCALES` само: точный тег, затем основной подтег. Если у основного подтега уже есть язык (например, добавляется `pt-PT` при существующем `pt-BR`), по основному подтегу выбирается тот, что стоит в `LOCALES` последним, — проверьте нужный порядок и добавьте случаи в `packages/shared/src/i18n/index.test.ts`.
3. **Каталоги:**
   - скопировать `packages/shared/src/i18n/ru/` в `packages/shared/src/i18n/it/` и перевести все файлы по глоссарию;
   - формы множественного числа — по `Intl.PluralRules('it').resolvedOptions().pluralCategories` (лишние формы `ru` удалить, недостающие добавить);
   - `packages/shared/src/i18n/resources.ts` — импорт одиннадцати файлов и блок `it: { … }`;
   - глоссарий в этом документе — колонка нового языка (и строка в таблице «Состояние языков»).
4. **Веб:**
   - `apps/web/src/i18n/instance.ts` — добавить язык в каждую строку списка `LAZY`: `{en,es,pt-BR,fr,de,zh-CN,it}/<ns>.json`. Без этого каталоги языка не попадут в сборку, и смена языка закончится ошибкой «no catalog»;
   - `apps/web/src/i18n/index.ts` — `DATE_LOCALES`: имя локали dayjs для `@gravity-ui/date-utils` (`it`);
   - uikit знает только `ru` и `en`, для нового языка остаётся `en` — менять ничего не нужно (`changeLocale` и `apps/web/src/app/App.tsx`).
5. **API:**
   - `DEFAULT_LOCALE` проверяется по `LOCALES` сам (`apps/api/src/config.ts`), но список языков перечислен ещё в Helm (`charts/carbone-reports/templates/_validate.tpl`, комментарий в `values.yaml`, тест `charts/carbone-reports/tests/validate_test.yaml`) и в комментарии `.env.example`.
6. **Отчёты** (раздел «Язык отчёта»), всё — в `packages/shared/src/i18n/index.ts`, кроме каталога и шрифта:
   - `CARBONE_LANGS` — `options.lang` Carbone (`it-it`). Ключ должен быть в `packages/carbone/formatters/_locale.js` (иначе Carbone берёт `en`); там же `currency.code` — валюта `formatC` по умолчанию для языка, её стоит указать в таблице раздела «Язык отчёта»;
   - `OFFICE_REGIONS` — регион OnlyOffice (`it-IT`): им пользуются и редактор документа, и конвертация отчёта;
   - `localeTag` — тег BCP 47 для дат штампа; сейчас совпадает с `OFFICE_REGIONS`, проверьте, что `Intl.DateTimeFormat` даёт с ним нужный формат;
   - `report.json` — строки штампа (каталог копируется из `ru` на шаге 3; параметры `{{…}}` те же);
   - `PAGE_FORMATS` — формат нумерации по умолчанию (`Pagina {page} di {pages}`), скобки `{page}`/`{pages}` одинарные;
   - шрифт — если письменность языка не покрыта Noto Sans и Noto Sans SC, нужен ещё один шрифт в `packages/carbone/assets/fonts` (с файлом лицензии и строкой в `NOTICE.md`) и его выбор в `apps/api/src/modules/pdf/font.ts`.
7. **Справка по шаблонам** — модуль `apps/web/src/pages/admin/help/content/it.ts`, строка `it: () => import('./it')` в `HELP_MODULES` и результаты через `pnpm help:check -- --locale it` (подробно — «Как перевести справку на новый язык»). Без модуля справка на этом языке показывается на русском.
8. **Типы и тесты:** `pnpm typecheck` покажет все словари `Record<Locale, …>`, где не хватает языка. Тест `packages/shared/src/i18n/index.test.ts` сверяет `LOCALES` целиком, список языков есть и в `scripts/i18n-check.test.mjs`.
9. **Проверка:** `pnpm i18n:check`, `pnpm test:scripts`, `pnpm help:check -- --locale it`, `pnpm --filter @carbone-reports/shared test`, `pnpm --filter @carbone-reports/web test`, `pnpm --filter @carbone-reports/web build`.
10. **Скриншоты-сверка.** Новый язык в интерфейсе на ширине 1280 и 375 px: отчёты, построение отчёта, шаблоны, редактор шаблона (вкладки «Документ», «PDF»), окно пользователя, страница входа. Ищем обрезанные и наползающие подписи, кириллицу (кроме данных из базы, см. ниже), неверные кавычки и пунктуацию. Язык удобно выставить до входа: `localStorage['cr.locale'] = 'it'`.
11. **Вычитка носителем.** До неё язык помечается в таблице ниже как «вычитан носителем: нет».

### Как добавить пространство имён

1. `NAMESPACES` в `packages/shared/src/i18n/index.ts`.
2. Файл `<ns>.json` во всех языках и импорт в `packages/shared/src/i18n/resources.ts`.
3. Если тексты нужны вебу — строка в списке `RU` и строка в списке `LAZY` в `apps/web/src/i18n/instance.ts`. Пространства имён, которые нужны только API, в эти списки не добавляются.

## Как проверить полноту

`pnpm i18n:check` (`scripts/i18n-check.ts`; в CI — в задаче «Проверки»). Проверка падает, если:

- в каком-то языке нет ключа, который есть в `ru`, или есть лишний; нет файла пространства имён или есть лишний;
- параметры `{{…}}` в переводе не совпадают с `ru` (сравниваются как множества);
- не хватает форм множественного числа, которых требует CLDR для языка, или есть лишние;
- строка пустая или ключ вложен глубже двух уровней;
- в `apps/web/src` в строковом литерале, шаблонной строке или тексте JSX есть кириллица — непереведённая строка. Не проверяются комментарии, файлы `*.test.*`, русский модуль справки `pages/admin/help/content/ru.ts` и помощники тестов `test/**`;
- в `apps/api/src` в `new AppError(…)`, `badRequest(…)`, `notFound(…)`, `conflict(…)`, `forbidden(…)` передан текст с кириллицей вместо ключа.

Проверка на другом наборе файлов (так её проверяют тесты `scripts/i18n-check.test.mjs`): `pnpm i18n:check <каталог> --web-src=<каталог>`.

Чего проверка не видит: качество перевода, единообразие терминов, длину подписей в интерфейсе. Это — глоссарий, скриншоты-сверка и вычитка.

## Состояние языков

| Язык | Код | Интерфейс и отчёты вычитаны носителем | Справка по шаблонам вычитана носителем |
| --- | --- | --- | --- |
| Русский | `ru` | исходный язык | исходный язык |
| English | `en` | нет | нет |
| Español | `es` | нет | нет |
| Português (Brasil) | `pt-BR` | нет | нет |
| Français | `fr` | нет | нет |
| Deutsch | `de` | нет | нет |
| 简体中文 | `zh-CN` | нет | нет |

Переводы сделаны по глоссарию и приняты владельцем проекта, но носители языка их ещё не вычитывали. Справка (2.15.0) вычитывается отдельно: её текст много больше каталогов.

### Как прислать исправления

Пулреквест с правкой каталога `packages/shared/src/i18n/<язык>/<пространство имён>.json` или модуля справки `apps/web/src/pages/admin/help/content/<язык>.ts`:

- меняются только значения, ключи и параметры `{{…}}` остаются;
- если правка меняет термин, в том же пулреквесте поправьте глоссарий в этом документе и все места каталогов, где термин встречается;
- в модуле справки меняются только тексты: теги, имена полей, SQL, ключи данных и `id` остаются (их сверяет тест структуры); изменили данные или строковый аргумент форматтера — обновите `result` по `pnpm help:check -- --locale <язык>`;
- если язык вычитан целиком, поменяйте его строку в таблице «Состояние языков» на «да» (интерфейс и справка — отдельные столбцы);
- перед отправкой — `pnpm i18n:check` (и для справки — `pnpm help:check -- --locale <язык>`).

## Что не переводится

Остаются на русском во всех языках:

- **Тексты для оператора:** журнал сервера, ошибки конфигурации при запуске (`apps/api/src/config.ts`), сообщения CLI-скриптов (`scripts/`).
- **Тексты, которые сохраняются в базу в момент записи** (переводить их значит хранить ключ и параметры, это вне этапа 1):
  - текст ошибки запуска в «Истории»;
  - ошибка сохранения документа в OnlyOffice (`lastSaveError`) в редакторе шаблона;
  - суффикс «(копия)» в имени скопированного шаблона.
- **Ответы агента бэкапа**, которые API передаёт как есть.
- **Тексты ошибок движка Carbone** в шаблоне (графики, html, изображения): API передаёт их как `{{message}}` внутри сообщения об ошибке генерации.
- **Метка алгоритма ключа ГОСТ** («ГОСТ Р 34.10-2012 (256)»): хранится в базе на русском и показывается на странице «Моя подпись» во всех языках.
- **Данные пользователей:** имена шаблонов, категорий, групп, источников, описания.

В отчётах (2.14.0) не локализуются:

- **Текст самого шаблона:** язык отчёта меняет форматы, штамп и нумерацию, но не слова в документе. Перевод внутри шаблона (`{t()}` и словари Carbone) не поддерживается.
- **Китайский текст в диаграммах:** графики рисуются только шрифтом Noto Sans, иероглифов в нём нет. Noto Sans SC используется только постобработкой PDF.

Ограничения этапа 1:

- Дата в форме параметров отчёта вводится как ДД.ММ.ГГГГ во всех языках: календарь `@gravity-ui/date-components` знает только `ru` и `en`.
- На ширине 375 px оболочка приложения не адаптируется к экрану; так было и до локализации, во всех языках.

Следующий этап — **этап 4**: документация (README и `docs/`, кроме этого документа).
