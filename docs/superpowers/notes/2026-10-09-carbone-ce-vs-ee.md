# Carbone Community (open source) и Carbone EE: сравнение и план своей сборки для carbone-reports

Дата исследования: 2026-10-09.

Пометки:
- **[П]** — проверено по первоисточнику: GitHub API, исходный код, npm, документация carbone.io или локальный запуск.
- **[В]** — вывод или предположение, первоисточником не подтверждено.

---

## 0. Главное (TL;DR)

1. **Проект сейчас не использует ни одной платной функции.** [П] `carbone/carbone-ee:full-5.15.3-fonts` запущен без лицензии: в compose и Helm нет `CARBONE_LICENSE` или `CARBONE_EE_LICENSE`. В журнале запуска стоит `templating: Basic (Community Edition)`, `studio: disabled` (`docs/superpowers/notes/2026-10-13-carbone-community-matrix.md`). API обрабатывает ошибку `Formatter "X" is disabled in the Community Edition` (`apps/api/src/modules/carbone/community.ts`), а «Справка по шаблонам» прямо пишет, что aggSum, html, chart, barcode, color, drop/keep и другие в нашей версии недоступны. То есть сейчас проект — это «**бесплатный режим Carbone v5 с HTTP-сервером и LibreOffice**».
2. **Новее 3.8.2 открытой версии нет.** [П] npm `latest` = 3.8.2 (3 апреля 2026). Открытые теги: …, 3.2.3, 3.5.5, 3.5.6, 3.8.2. Версий v4 и v5 с открытым кодом нет. README: «This open-source edition … is always one major version behind. We will update it to v4 as soon as possible». CHANGELOG 3.8.2: «Align the version published on npm with the Enterprise Edition version. All fixes between v3.5.6 and v3.8.2 do not affect the npm version». Код по сути равен 3.5.6 плюс защита от zip-бомб и исправление безопасности.
3. **Лицензия.** [П] До коммита `6eeb07cc` (13.02.2023, «switch license from Apache v2.0 to Carbone Community License») код распространялся под Apache-2.0. Последний коммит под Apache — `24a8ad7f` (8.12.2021, код v3.4.1). Последний релиз на npm под Apache — 3.2.3. Начиная с 3.5.5 действует **Carbone Community License (CCL)**. Модифицировать код можно, использовать внутри своего продукта тоже, нельзя предлагать его как «генератор документов как сервис». Подробности — в разделе 3.
4. **Форк SamRozhkov/carbone** [П]: `master` идентичен `carboneio:master` (`compare` → `identical`, 1df45b5e = 3.8.2, лицензия CCL). Ветки `v2.0` (2020), `error_message` (2017), `greatcare-windows-support` (2018) и `manage-whitespace-in-tags` (PoC от 13.06.2024) — старые, функций EE в них нет.
5. **Чего не хватает при переходе на 3.8.2.** Платные функции проекту не нужны. Нужно другое: (а) **HTTP-сервер**, совместимый с `/template` и `/render`: в 3.8.2 его нет, есть только Node-библиотека и CLI `translate`/`find`; (б) **синтаксис v4/v5 из бесплатного режима**, на который опирается «Справка»: `:set` и группировка, `print(.i)`, циклы по массиву строк, `ellipsis`, lookup и др. Их в 3.8.2 нет, это проверено локально. Платные функции EE (графики, изображения, HTML, штрихкоды) — отдельный вопрос развития, а не условие замены.

---

## 1. Что проект использует от Carbone [П]

Источники: `apps/api/src/modules/carbone/client.ts`, `community.ts`, `template-cache.ts`, `packages/shared/src/index.ts`, `docker-compose.yml`, `charts/carbone-reports/*`, `apps/web/src/pages/admin/help/content.ts`, спецификация `docs/superpowers/specs/2026-10-02-carbone-reports-design.md` (§3, §23.x, §27), заметка-матрица `docs/superpowers/notes/2026-10-13-carbone-community-matrix.md`.

### 1.1 HTTP-контракт (то, что должна реализовать замена)
| Что | Детали |
|---|---|
| `POST /template` | multipart, поле `template`, имя `template.<ext>`; заголовок `carbone-version: 5`; ответ `{success:true, data:{templateId}}`; при ошибке `{success:false, error}` |
| `POST /render/{templateId}?download=true` | JSON `{data, convertTo:'pdf'\|'docx'\|…(строка), lang:'ru', timezone:TZ}`; успех — бинарный файл с не-JSON `content-type`; ошибка — JSON `{error}` |
| «Шаблон не найден» | HTTP 404 или текст `/template not found/i` → клиент загружает шаблон заново |
| Отключённый форматтер | текст `Formatter "X" is disabled in the Community Edition` → 400 `CARBONE_COMMUNITY` |
| Хранилище шаблонов | том `/app/template` (compose) или emptyDir (Helm) — только кэш, восстанавливается сам |
| Порт и пробы | 4000; в Helm `tcpSocket`-пробы; `/status` не используется |
| Не используются | вебхуки, Studio, `GET /render/{renderId}`, хранилище и версии шаблонов EE, аутентификация (Bearer), `complement`, `translations`, `currency*`, PDF-опции (`convertTo` всегда строка), `converter` (O/C/I), пакетная генерация |

### 1.2 Форматы
- Шаблоны: `docx, xlsx, odt, ods, pptx`.
- Вывод: `pdf, docx, xlsx, odt, ods, pptx`. docx → pdf/docx/odt, xlsx → pdf/xlsx/ods, pptx → pdf/pptx.
- Значит, нужна конвертация LibreOffice (docx↔odt, xlsx↔ods, всё → pdf) с кириллицей и шрифтами. Сейчас используется тег `-fonts`, внутри есть Google Fonts.

### 1.3 Шаблоны и форматтеры
- Готовых шаблонов (`*.docx/xlsx/odt/pptx`) в репозитории нет [П]. Шаблоны создают администраторы в OnlyOffice и хранят в S3. Проверочные DOCX собирают на лету `scripts/help-check.ts` и Python-харнесс матрицы.
- «Справка по шаблонам» — фактически контракт синтаксиса, который обещан пользователям. Используемые там форматтеры и конструкции [П]: `formatD, ifEQ, show, elseShow, set (группировка c.g[id=.key].rows[]), add (с выражением .b*2-1), formatC, formatN, convCurr, len, ifEmpty, ifEM, hideBegin/End, showBegin/End, ucWords, print(.i):add(1), or/and, ifGT, ellipsis, arrayJoin, arrayMap, convCRLF`; фильтры `[i, ok=true]`, `[i, qty > 1]`; distinct `[brand]`; `{c.now}`; алиасы.
- Раздел «Недоступно» ожидает именно **ошибку** `disabled in the Community Edition` для `aggSum…cumCountD, count(), drop/keep, html, color, barcode, chart, formatR, defaultURL, autoOrient`. `pnpm help:check` проверяет это поведение.

### 1.4 Проверка 3.8.2 на синтаксисе из «Справки» (локальный запуск `carbone.renderXML`, Node 16, `lang:'ru'`, `timezone:'Europe/Moscow'`) [П]
| Тег | 3.8.2 | EE 5.15.3 без лицензии (по матрице) |
|---|---|---|
| `formatD('DD MMMM YYYY')`, `formatN(2)`, `formatC()` | ✅ (`1 234 567,89 ₽`) | ✅ |
| `arrayJoin()`, `arrayMap`, `len()`, `ifEmpty`, `and/or`, `add(.b * 2 - 1)` | ✅ | ✅ |
| фильтры `[i, qty > 1]`, distinct `[brand]`, алиасы `{#a = …}{$a.x}`, `[id=2]` | ✅ | ✅ |
| цикл по ключам объекта `obj[i].att/.val` | ✅ | ✅ |
| `{t(…)}` с `translations` | ✅ | ✅ |
| `count()` | ✅ работает (1..4) | ❌ отключён (→ cumCount) |
| **`print(.i):add(1)`** (нумерация из «Справки») | ❌ `NaN` (итератор `.i` появился в v4) | ✅ |
| **`:set` / группировка `c.g[id=.brand].rows[]`** | ❌ молча пусто | ✅ |
| **цикл по массиву строк `{d.tags[i]}`** | ❌ пусто (v4.9+) | ✅ |
| **`ellipsis`, `append`, `replace`, `mod`, `abs`, `ifTE`, `formatI`, `diffD`** | ❌ «does not exist» | ✅ |
| `aggSum`, `cumSum`, `html` | ❌ «does not exist» (другой текст ошибки!) | ❌ «disabled in the Community Edition» |
| сортировка по убыванию `[-qty, i]` | исходный порядок | исходный порядок |
| дата без времени `2026-03-08` | зависит от **TZ процесса**: при TZ=UTC получается `08.03.2026 03:00`, как в EE | `08 марта` |
| наивный `'2026-03-08 23:30:00'` | при TZ=UTC `09.03 02:30`, как в EE | `09.03 02:30` |

Вывод [П+В]: «как есть» 3.8.2 ломает как минимум 4 примера «Справки» (`set`-группировка ×2, `print(.i)`, `ellipsis`) и все сообщения раздела «Недоступно». Перед переходом нужно перенести недостающий синтаксис v4/v5 и выдавать тот же текст ошибки для «платных» форматтеров. Либо придётся переписать «Справку».

---

## 2. Таблица: Community (open source 3.8.2) / carbone-ee 5.x без лицензии / carbone-ee 5.x с лицензией (EE, Cloud)

Колонка «Проекту» показывает, нужно ли это проекту: **да** — используется сейчас, **нет** — не используется, **буд.** — возможное развитие.

| Возможность | CE 3.8.2 (GitHub/npm, CCL) | carbone-ee 5.x без лицензии («Community» в Docker) | EE 5.x с лицензией / Cloud | Проекту |
|---|---|---|---|---|
| HTTP-сервер (`POST /template`, `POST /render/:id`, `GET /render/:renderId`, `GET /status`) | ❌ только библиотека Node + CLI `translate`/`find` [П код] | ✅ [П docs http-api, README «No license is required to start the On-Premise Docker Edition with the REST API»] | ✅ | **да** |
| Заголовок `carbone-version` (3/4/5) | — | ✅ [П docs] | ✅ | да (шлём `5`) |
| Аутентификация Bearer | — | ✅ (опционально) [П docs] | ✅ | нет |
| Хранилище шаблонов (ФС/S3, метаданные, версии, теги/категории) | ❌ (`renderPrefix`/tempdir) | ✅ ФС; S3 через `AWS_*`/`BUCKET_TEMPLATES` [П Docker Hub] | ✅ + управление шаблонами (v5.4 «Template metadata») [П changelog] | только ФС-кэш |
| Вебхуки, асинхронный рендер | ❌ | ✅ заголовок `carbone-webhook-url` [П docs]; балансировщик задач без лицензии выключен [П licensing] | ✅ + job balancer (v5.10) | нет |
| Studio (веб-редактор) | ❌ | ❌ `studio: disabled` [П матрица]; включается `CARBONE_EE_STUDIO=true` [П Docker Hub], по тарифам — платная [П pricing] | ✅ | нет (есть OnlyOffice) |
| Плагины (JS: storage, afterRender…) | ❌ (свои форматтеры через `addFormatters`) | ✅ «optional plugins (JS)» [П docs on-prem] | ✅ | нет |
| Подстановки, циклы, вложенные циклы, фильтры, distinct, сортировка | ✅ (база v3) [П] | ✅ + v4/v5: `.i`, массивы строк, lookup (`o.preReleaseFeatureIn`), `[i+1]` с фильтром один раз | ✅ | **да** |
| Алиасы `{#…}` | ✅ [П код parser.js] | ✅ | ✅ | да |
| Условия `ifXX/show/elseShow`, `showBegin/hideBegin` | ✅ | ✅ | ✅ | **да** |
| Умные условия `drop/keep` | ❌ (нет) | ❌ disabled [П матрица] | ✅ (ENTERPRISE v4+) | нет |
| Форматтеры дат/чисел/валют/текста v3 | ✅ | ✅ | ✅ | **да** |
| Форматтеры v4/v5: `ellipsis, append, replace, split, substr(слово), mod, abs, ceil, floor, formatI, diffD, ifTE, printJSON, t, len…` | частично (`len`, `substr`, `arrayJoin` есть; `ellipsis/append/replace/mod/abs/formatI/diffD/ifTE` нет) [П] | ✅ | ✅ | **да** (ellipsis в «Справке») |
| `:set` (store & transform), группировка | ❌ | ✅ (по докам ENTERPRISE, но работает без лицензии) [П матрица] | ✅ | **да** |
| Агрегаторы `aggSum/Avg/Min/Max/Count/CountD/Str/StrD`, `cumSum/cumCount/cumCountD` | ❌ (нет) | ❌ disabled [П матрица] | ✅ (Enterprise в таблице возможностей [П docs]) | нет (итоги в SQL) |
| `count()` | ✅ (своя реализация) | ❌ (→ cumCount, disabled) | ✅ | нет |
| Переводы `{t()}`, CLI `carbone translate` | ✅ | ✅ | ✅ | нет (`lang` только для форматов) |
| Простая арифметика с выражениями | ✅ (3.5.5+) | ✅ + `useHighPrecisionArithmetic` | ✅ | да |
| Изображения из данных, `imageFit`, `autoOrient` | ❌ | ❌ (картинка-заглушка остаётся; autoOrient disabled) [П матрица] | ✅ (Pictures — Enterprise [П docs]) | буд. |
| Цвета `:color`, `bindColor` | ❌ / bindColor разбирается | ❌ / bindColor молча игнорируется [П] | ✅ | буд. |
| Гиперссылки из данных | ✅ (замена Target) [В] | ✅; `defaultURL` disabled [П] | ✅ | возможно |
| HTML `:html` | ❌ | ❌ disabled [П] | ✅ (v5: заголовки, списки, таблицы, `sup/sub/code/pre/hr`…) [П changelog] | буд. |
| Графики `:chart` (DOCX/XLSX/PPTX/ODT; ECharts) | ❌ | ❌ disabled [П] | ✅ (v4+; в ICE — векторные bar/line/area/pie/doughnut) | буд. |
| Штрихкоды и QR `:barcode` | ❌ | ❌ disabled [П] | ✅ | буд. |
| `formatR` (названия регионов) | ❌ | ❌ disabled | ✅ | нет |
| Формы, электронные подписи, файловые операции, Transform | ❌ | ❌ | ✅ (Enterprise [П docs template-feature]) | нет |
| Конвертация LibreOffice (pdf, docx↔odt, xlsx↔ods…) | ✅ через `soffice` + `converter.py`, пул `factories`, `attempts`, авто-перезапуск [П код] | ✅ (тег `full`) [П Docker Hub] | ✅ | **да** |
| Конвертеры OnlyOffice (`O`), Chromium (`C`), Carbone ICE (`I`, v5.14, DOCX→PDF «up to 60x faster») | ❌ | [В] вероятно, есть в образе; доступность без лицензии не проверена | ✅ [П docs convert-reports, changelog] | нет (по умолчанию `L`) |
| PDF: пароль и шифрование (`formatOptions`) | ✅ через фильтры LibreOffice (`convertTo` как объект) [В по коду input.js] | ✅ `/Encrypt` в PDF [П матрица] | ✅ (AES-256 в v5.13) | нет |
| PDF: водяные знаки, PDF/A, PDF/UA, merge/append, подпись | PDF/A — через опции фильтра LO [В]; остальное ❌ | [В] не проверено; по тарифам — «PDF operations» в EE | ✅ [П pricing] | нет |
| Пакетная генерация (batch) | ❌ | [В] | ✅ (v5.14) [П changelog] | нет |
| Входные форматы шаблонов | docx, xlsx, pptx, odt, ods, odp, fodt, (x)html, xml [П код index.js] | + md, csv, txt, svg, odg, pdf (по докам) | то же | docx/xlsx/pptx/odt/ods |
| Шрифты | что установлено в ОС | `full-fonts`: все Google Fonts [П Docker Hub] | то же | **да** (кириллица) |
| Защита от zip-бомб | ✅ `maxTemplateUncompressedSize` 200 МБ (3.8.2) [П] | ✅ | ✅ | да |
| Исправления безопасности v5.14.4 / v4.27.0 (усиление LO, валидация, лимиты аргументов) | частично [В] | ✅ с 5.14.4 [П changelog] | ✅ | да |
| Поддержка и обновления | сообщество; «always one major version behind» | без поддержки («we do not provide support» [П Docker Hub]) | платная | — |

Ссылки на документацию:
- Возможности Community и Enterprise: https://carbone.io/documentation/design/overview/template-feature.html — Community: Substitutions, Repetitions, Formatters, Translations, Conditions, Simple math. Enterprise: Aggregators, Pictures, Colors, HTML, Charts, Barcodes, Hyperlinks, Forms, Transform, File operations, Signatures.
- Лицензирование on-premise: https://carbone.io/documentation/developer/on-premise-installation/licensing.md — «Carbone On-Premise always starts, with or without a license. Without one it runs the Community Edition: document generation works, but Enterprise features are disabled, the job balancer is forced off».
- HTTP API: https://carbone.io/documentation/developer/http-api/introduction.html
- Конвертеры: https://carbone.io/documentation/developer/http-api/convert-reports.md — `L` (по умолчанию), `O`, `C`, `I`.
- Docker Hub: https://hub.docker.com/r/carbone/carbone-ee — «Carbone Enterprise Edition is commercial software that requires a license»; Community — «free of charge and without limits», но «advanced functions will not work, and we do not provide support»; теги `slim`/`full`/`full-fonts`.
- Тарифы: https://carbone.io/pricing.html — On-Premise Fit $1 500/год, Unlimited $2 940/год (lifetime license). [В] Строку про бесплатную on-premise версию модель-пересказчик прочитала неоднозначно; по смыслу соседних документов динамические изображения, цвета, штрихкоды, графики, HTML, агрегации и PDF-операции в бесплатную версию **не входят**.
- Changelog EE: https://carbone.io/changelog.html — последняя 5.15.4 (6.10.2026); 5.15.3 вышла 1.10.2026.
- GitHub: https://github.com/carboneio/carbone, npm: https://www.npmjs.com/package/carbone

**Какие функции carbone-ee 5.x проект использует** [П+В]: HTTP-сервер (`/template`, `/render?download=true`, ошибки), конвертацию LibreOffice с шрифтами, синтаксис v4/v5 бесплатного режима (`:set`, `.i`, массивы строк, `ellipsis` и др.), локализацию `lang:'ru'` и `timezone`, текст ошибки «disabled in the Community Edition». Платные функции не используются, лицензии нет.

---

## 3. Лицензия [П — текст LICENSE.md из carboneio/carbone@master и SamRozhkov/carbone@master]

### 3.1 История
| Версия / коммит | Лицензия |
|---|---|
| ≤ 3.2.3 (npm), до коммита `24a8ad7f` включительно (код v3.4.1, 8.12.2021) | **Apache-2.0** (`"license": "Apache-2.0"`, файл `LICENSE`) |
| коммит `6eeb07cc` (13.02.2023) и далее: 3.5.5, 3.5.6, 3.8.2 | **Carbone Community License (CCL)**, «Effective Date: February 14, 2023» |
| carbone-ee (Docker, v4/v5) | закрытое ПО; бесплатный режим без лицензии — по CCL и условиям carbone.io [В: отдельного EULA для образа в открытых документах не нашёл] |

### 3.2 Ключевые цитаты CCL
- Вступление: «Roughly speaking, as long as you are not offering Carbone Community Edition Software as a hosted Document-Generator-as-a-Service like Carbone Cloud, you can use all Community features for free». README добавляет: «you can use **and modify** all Community features for free».
- **2.1(a) Internal Use**: «copy, compile, install, and use the Carbone Community Edition Software and Derivative Works solely for Your own internal business purposes in a manner that does not expose or give access to, directly or indirectly (e.g., via a wrapper), the Carbone Community Edition Software feature to any person or entity other than You or Your employees and Contractors».
- **2.1(b) Value Added Products or Services**: разрешено использовать CE и Derivative Works «solely as incorporated into or utilized with Your Value Added Products or Services» и распространять бинарники или Derivative Works в их составе, «provided that You notify Your customers that use of such Carbone Community Edition Software or Derivative Works is subject to this CCL Agreement and You provide to each such customer a copy of the most current version of this CCL Agreement or a URL».
- **2.1(c)**: исходный код и бинарники CE можно распространять «solely in **unmodified standalone form**».
- **2.1(d) Derivative Works**: «(i) to prepare, compile, and test Derivative Works…; (ii) to use Derivative Works for Internal Use…; (iii) to utilize Derivative Works with Your Value Added Products or Services…; (iv) to distribute Derivative Works with Your Value Added Products or Services…».
- **2.2 Prohibitions**: запрещено «using any Carbone Community Edition Software to provide document-generator-as-a-service services, or to provide any form of software-as-a-service or service offering in which the Carbone Community Edition Software is offered or made available to third parties to provide Document Generator functions or operations, other than as part of Your Value Added Products or Services».
- **3.3 Derivative Work** — «any modification or enhancement made by You to the Carbone Community Edition Software».
- **3.9 Value Added Products or Services**: продукт «not primarily Document Generator products or services» и «add substantial value of a different nature to the Document Generator».
- **3.7**: «Carbone Community Edition» означает «those portions of the Carbone Enterprise Edition Software that CarboneIO makes publicly available … under the terms of this CCL Agreement».
- **7.2**: CarboneIO может менять CCL; новая редакция действует для новых релизов. **7.3**: право Франции. **4**: при нарушении лицензия прекращается автоматически.

### 3.3 Что это значит для пользователя [В — это не юридическая консультация]
- **Модифицировать форк и запускать у себя или внутри компании — можно** (2.1(a), 2.1(d)(i)–(ii)).
- **Поставлять своим клиентам в составе carbone-reports — скорее можно, но есть зона риска.** Это разрешено как «Value Added Product» (2.1(b), 2.1(d)(iii)–(iv)), если продукт «not primarily Document Generator». А carbone-reports — именно «генерация отчётов на базе Carbone» (README). Ценность в SQL-источниках, правах, истории, редакторе OnlyOffice, бэкапах. Но ядро продукта — генерация документов, поэтому толкование спорное. В таком случае нужно уведомлять клиентов и прикладывать текст CCL. **Публичный SaaS «отчёты по шаблонам» для третьих лиц — прямой риск по 2.2.**
- **Распространять изменённый форк отдельно (публичный npm-пакет или Docker-образ «carbone-free-ee») — нельзя.** 2.1(c) разрешает только «unmodified standalone form», 2.2 запрещает остальное. Публичный репозиторий форка на GitHub — серая зона [В]. Безопаснее держать форк приватным или как часть репозитория продукта.
- **Своя реализация функций EE (графики, изображения, HTML, штрихкоды, агрегаторы).** CCL не запрещает добавлять функции: «modification or enhancement» входит в Derivative Work. Запрета на конкурирующие функции в тексте нет. Но: (1) нельзя копировать закрытый код EE, например из образа carbone-ee: это не CCL-код, и это будет нарушением авторского права и, вероятно, условий использования образа [В]; (2) сам Derivative Work остаётся под CCL со всеми ограничениями выше.
- **Чистая альтернатива по лицензии** — форк от `24a8ad7f` (v3.4.1, Apache-2.0). Свои изменения можно лицензировать как угодно, ограничений SaaS и распространения нет. Цена — нет исправлений из 3.5.5–3.8.2: выражения в `add/mul/sub/div`, `isDebugActive`, повтор строк `i+1*qty`, исправление prototype pollution (3.5.6, CVSS H), защита от zip-бомб (3.8.2). Это сравнительно небольшие изменения, их можно **переписать самостоятельно** (не копируя CCL-код) [В].
- Сторонний пример: `rodewitsch/carbone` (npm `@rodewitsch/carbone`, «fork of the carbone module (version 3.5.6). Added support for images, improved work with tables, formulas, graphs») [П GitHub/npm]. Он под CCL и распространяется на npm в изменённом виде, что противоречит 2.1(c) [В]. Как образец для подражания по лицензии не годится, но как техническая подсказка полезен.

---

## 4. Состояние форка и апстрима [П, gh api]

- `carboneio/carbone`: default `master`, license `NOASSERTION` (CCL), последний push 7.04.2026 (`1df45b5e` «prepare for publication + bump to 3.8.2»). Перед этим: «add zip bomb DoS protection», «security_fix» (PR #1174).
- Теги: `3.8.2, 3.5.6, 3.5.5, 3.2.3, 3.1.0, 2.1.1, …`. GitHub Releases пусты. Ветка `update_icon_free_v4_docker` (22.02.2024) — правка README.
- `SamRozhkov/carbone`: fork, `master` = `1df45b5e` (идентичен апстриму). Другие ветки — копии старых веток апстрима (`v2.0` 2020, `error_message` 2017, `greatcare-windows-support` 2018, `manage-whitespace-in-tags` 2024 PoC, dependabot/snyk).
- Состав 3.8.2 [П]: `lib/` (index, builder, parser, extracter, preprocessor, converter.js + `converter.py` для LibreOffice UNO, format, input, translator…, около 5 000 строк), `formatters/` (array, condition, date, number, string, `_locale`, `_currency`), зависимости `dayjs, debug, which, yauzl, yazl`. Node ≥ 12 (в README «14.x+»), конвертация — `soffice` из ОС.
- В CHANGELOG 3.x про EE есть только: «On the Enterprise Edition, the global watchdog system is able to fix this bad behavior» (3.4.0) и выравнивание версий (3.8.2). Список функций EE в открытом репозитории не описан.

---

## 5. Рекомендация

### 5.1 От какой версии делать форк
- **Вариант A (рекомендуемый, если продукт не будет SaaS для третьих лиц): `master` = 3.8.2 (CCL).** Самый свежий код с исправлениями безопасности и защитой от zip-бомб; ваш форк уже на нём.
- **Вариант B (если нужна свобода лицензии или публичный SaaS): коммит `24a8ad7f` (v3.4.1, Apache-2.0)** и самостоятельная реализация исправлений 3.5.x–3.8.2.
- Новее (v4/v5) с открытым кодом базы нет.

### 5.2 Минимум, чтобы заменить carbone-ee в этом проекте
1. **HTTP-сервер-обёртка** на Node (Fastify/Express) поверх библиотеки:
   - `POST /template` (multipart → сохранить в `/app/template/<sha256>.<ext>` → `{success:true,data:{templateId}}`);
   - `POST /render/:id?download=true` (JSON `{data, convertTo, lang, timezone}` → бинарный файл; ошибка → `{success:false,error}`; нет шаблона → 404 `Template not found`);
   - `GET /status`; игнорировать заголовок `carbone-version`. Так `client.ts` останется без изменений.
2. **Конвертер:** образ с LibreOffice (headless) + python3-uno + шрифты (Liberation, DejaVu, PT Astra/Google Fonts для кириллицы), пул `factories` ≥ 2, таймауты. `TZ=UTC` в контейнере: проверено, что тогда разбор дат 3.8.2 совпадает с EE.
3. **Перенос синтаксиса v4/v5 из бесплатного режима, на который опирается «Справка»:** итератор `.i` (`print(.i)`), циклы по массиву строк, `:set` + группировка `c.x[id=.key].rows[]`, `ellipsis`, а также `append/replace/mod/abs/ceil/floor/formatI/diffD/ifTE` (документированы, пользователи могут их применять). По возможности — lookup `[id=.field]` и `o.preReleaseFeatureIn`/`useHighPrecisionArithmetic`.
4. **Совместимость ошибок:** для `aggSum…cumCountD, drop, keep, html, color, barcode, chart, formatR, defaultURL, autoOrient` выдавать `Formatter "X" is disabled in the Community Edition` (или поменять регэксп в `community.ts`). Решить судьбу `count()`: в 3.8.2 он работает, в EE-community отключён.
5. **Регрессия:** прогнать `pnpm help:check` и харнесс матрицы (около 200 проб из `docs/superpowers/notes/`) против нового сервиса; заменить образ в `docker-compose.yml` и `charts/carbone-reports/values.yaml`. Проверить вывод PDF/ODT/ODS и PPTX→PDF на шаблонах из OnlyOffice.
6. Функции EE (графики, изображения, HTML, штрихкоды, агрегаторы) — **отдельный этап**, для замены они не нужны. По соотношению ценности и сложности [В]: агрегаторы (`aggSum/cumSum` — чистый JS поверх циклов) → изображения из данных (замена `media/*` и rels в DOCX/XLSX/PPTX/ODT) → штрихкоды/QR (bwip-js → изображение) → `:html` (HTML → WordprocessingML/ODF — большой объём) → графики (нативные chart XML или SVG/PNG — самое трудоёмкое).

### 5.3 Главные риски
1. **Лицензия CCL** [П текст, В толкование]: продукт «генерации отчётов» может не подпасть под «not primarily Document Generator»; изменённый форк нельзя распространять отдельно; публичный SaaS запрещён. Нельзя заимствовать код из образа carbone-ee. Если это критично — вариант B (Apache 3.4.1).
2. **Разница поведения v3 и v5** [П частично]: шаблоны, которые уже есть у пользователей в S3, рассчитаны на парсер v5 (фильтры в `[i+1]` один раз, `.i`, `:set`, обработка XLSX в v5 «significantly improved»). Возможны тихие расхождения (пустые строки вместо ошибки). Нужна регрессия на реальных шаблонах из прод-хранилища.
3. **Объём переноса синтаксиса v4/v5** [В]: часть изменений сидит в ядре (`extracter/builder/parser`: итератор `.i`, массивы строк, `:set` с записью в `c.`), а не в форматтерах. Это самая сложная часть минимального набора.
4. **Конвертер и безопасность** [П changelog EE, В для 3.8.2]: в EE 5.14.4 есть усиление LibreOffice (валидация расширений, CSP, лимиты аргументов). В своей сборке это придётся повторить самим (лимиты `padl/formatN`, изоляция `soffice`, таймауты, перезапуск).
5. **Поддержка** [В]: апстрим 3.x обновляется раз в 1–2 года; все исправления и регрессии вам придётся вести самим.
6. **Образ** [В]: LibreOffice + шрифты — около 1–2 ГБ (диск у вас ограничен); сборка multi-arch.

Альтернатива без форка [В]: остаться на `carbone-ee` без лицензии. Это законно по условиям carbone.io для Community-функций; заменить нужно только то, ради чего затевается форк. Если цель — платные функции, лицензия On-Premise Fit ($1 500/год) может оказаться дешевле, чем писать графики, HTML и изображения самостоятельно.
