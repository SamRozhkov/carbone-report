# Справочник поведения Carbone EE: изображения, штрихкоды, цвета, ссылки

Источник: только публичная документация carbone.io (clean-room). Страницы читались через WebFetch, который пересказывает страницу малой моделью, а не отдаёт дословный текст. Поэтому детали, которых нет на странице, помечены [неуверенно] или «в документации не сказано».

Страницы:
- P = https://carbone.io/documentation/design/advanced-features/pictures.md
- B = https://carbone.io/documentation/design/advanced-features/barcode.md
- C = https://carbone.io/documentation/design/advanced-features/colors.md
- H = https://carbone.io/documentation/design/advanced-features/hyperlinks.md

## Бейджи EE и версии

| Функция | Статус | Версия | Источник |
|---|---|---|---|
| Динамические изображения | Enterprise (Cloud и On-premise; не в Embedded JS v3.0+) | v3+ | P |
| `:imageFit` | часть изображений, EE | версия не указана | P |
| `:autoOrient` (только DOCX) | EE | v5.6.0+ | P |
| `failOn: ["IMAGE_URL_ERROR"]` | параметр запроса рендера | v5.15.0+ | P |
| `:barcode` | Enterprise (не в Embedded JS) | v3.4.6+ | B |
| `:color` | Enterprise | v4.17.0+; полная поддержка PPTX с v5.6.0 | C |
| `bindColor` | устарел, «не рекомендуется» | не указана | C |
| Динамические гиперлинки | Enterprise (не в Embedded JS) | v3.0+ | H |
| `:defaultURL` | EE | в H версия не указана; в нашей матрице v3+ [неуверенно] | H |

## 1. Динамические изображения (P)

- Заглушка: во временный (placeholder) рисунок шаблона вставляется тег `{d.img}` в «альтернативный текст». Carbone при рендере заменяет заглушку на изображение из данных.
- Где ставить тег по форматам (P):
  - ODT: alt text или description (LibreOffice: ПКМ, Свойства, «Альтернативный текст»).
  - ODS, ODP, ODG: title изображения.
  - DOCX, XLSX (и PPTX): title, description или alt text.
- Данные: публичный URL или base64 Data URI вида `data:image/[type];base64,...`.
- Форматы изображений: JPEG, PNG, GIF, SVG.
- Форматы документов: PDF, ODT, ODS, ODP, ODG, PPTX, XLSX, DOCX.
- `:imageFit(mode)`:
  - `fillWidth` (по умолчанию): по ширине элемента с сохранением пропорций.
  - `contain`: вписать в контейнер с сохранением пропорций.
  - `fill`: растянуть на весь контейнер (пропорции не сохраняются).
- `:autoOrient` (v5.6.0+, только DOCX): поворот JPEG по EXIF; нельзя сочетать с `imageFit(fill)`.
- Циклы: для нескольких изображений в цикле привязка (ODT: anchor «As Character»; DOCX: wrapping «In Line with Text») должна быть «в строке». Если изображения позиционированы абсолютно, цикл с несколькими изображениями даёт неверный документ в PPTX, XLSX, ODP, ODG (обходной путь через Transform «coming soon»). В ODT ограничения нет.
- Ошибка (не скачалось, тип не поддержан): подставляется «replacement error image»; как она выглядит, в документации не сказано. С v5.15.0 `failOn: ["IMAGE_URL_ERROR"]` вместо подстановки останавливает рендер.
- В документации не сказано: тайм-ауты, лимиты размера, allowlist хостов, DPI, поведение при пустом или null значении, точные правила размеров по типам документов [неуверенно: возможно, есть на HTML-версии].

## 2. Штрихкоды (B)

- Два способа:
  1. Как изображение (рекомендуется): заглушка-картинка, в alt text, description или title тег `{d.code:barcode(qrcode)}`. Поддерживает все типы. Работает в PDF, ODT, ODS, ODP, ODG, PPTX, XLSX, DOCX и HTML (в HTML тег в `src`: `<img src="{d.code:barcode(qrcode)}">`).
  2. Как шрифт (legacy): только `ean8`, `ean13`, `ean128`, `code39`, нужны шрифты `ean13.ttf` (ean8, ean13), `code128.ttf` (ean128), `code39.ttf` (code39). Шрифт штрихкода применяется к открывающей фигурной скобке тега.
- Типов: 107. Идентификаторы по странице B:
  - 1D: ean5, ean2, ean13, ean8, upca, upce, isbn, ismn, issn, code128, gs1-128, ean14, sscc18, code39, code39ext, code32, pzn, code93, code93ext, interleaved2of5, itf14, identcode, leitcode, databaromni, databarstacked, databarstackedomni, databartruncated, databarlimited, databarexpanded, databarexpandedstacked, gs1northamericancoupon, pharmacode, pharmacode2, code2of5, industrial2of5, iata2of5, matrix2of5, coop2of5, datalogic2of5, code11, bc412, rationalizedCodabar, onecode, postnet, planet, royalmail, auspost, kix, japanpost, msi, plessey, telepen, telepennumeric, posicode, codablockf, code16k, code49, channelcode, flattermarken, raw, daft, symbol.
  - 2D: pdf417, pdf417compact, micropdf417, datamatrix, datamatrixrectangular, datamatrixrectangularextension, mailmark, qrcode, swissqrcode, microqrcode, rectangularmicroqrcode, maxicode, azteccode, azteccodecompact, aztecrune, codeone, hanxin, dotcode, ultracode.
  - Composite и GS1: gs1-cc, ean13composite, ean8composite, upcacomposite, upcecomposite, databaromnicomposite, databarstackedcomposite, databarstackedomnicomposite, databartruncatedcomposite, databarlimitedcomposite, databarexpandedcomposite, databarexpandedstackedcomposite, gs1-128composite, gs1datamatrix, gs1datamatrixrectangular, gs1qrcode, gs1dotcode.
  - HIBC: hibccode39, hibccode128, hibcdatamatrix, hibcdatamatrixrectangular, hibcpdf417, hibcmicropdf417, hibcqrcode, hibccodablockf, hibcazteccode.
  - Число и набор имён похожи на BWIPP (bwip-js) [неуверенно: догадка по именам, не из документации].
- Синтаксис опций: `:barcode(type, optionName:value, ...)` (формат «optionName:value» по B; точные примеры с запятыми в пересказе не подтверждены) [неуверенно].
- Опции (B):

| Опция | Тип | По умолчанию | Примечание |
|---|---|---|---|
| svg | bool | не указано | векторный вывод вместо растра |
| width, height | int | не указано | миллиметры; сочетаемо с `:imageFit` |
| scale | int 1..10 | не указано | множитель качества |
| includetext | bool | не указано | печатать данные текстом |
| textsize | int | не указано | |
| textxalign | left, center, right, justify | center | |
| textyalign | below, center, above | below | |
| rotate | N, R, L, I | не указано | R 90 вправо, L 90 влево, I 180 |
| barcolor, textcolor, backgroundcolor | `#RRGGBB` | не указано | |
| eclevel | L, M, Q, H | M | только QR |

- Ошибки: обработка ошибок, недопустимых символов и пр. в документации не описана (по пересказу) [неуверенно]. Вероятно, действует общий механизм подстановки replacement image как у изображений [неуверенно].

## 3. Цвета (C)

- `:color(scope, type)`:
  - scope: `p` (абзац, по умолчанию), `cell`, `row`, `shape`, `part` (фрагмент текста; только ODT).
  - type: `text` (по умолчанию), `highlight`, `background` (ячейка, строка, фигура), `border` (только фигуры).
- Формат цвета: 6-значный hex с `#` или без, регистр любой. Неверное значение заменяется светло-серым `#888888`. Имена, rgb и hsl для `:color` не заявлены.
- Матрица по типам документов (C): 
  - PDF, ODT, ODP, HTML: text, highlight, background; border нет.
  - DOCX: text и background; highlight не поддерживается; border нет.
  - PPTX: все, border только для фигур (полностью с v5.6.0).
  - XLSX, ODS в списке `:color` отсутствуют (то есть не поддерживаются) [неуверенно: вывод по отсутствию в списке].
  - HTML: только inline style.
- ODT и ODP: на целевом элементе уже должен быть применён нестандартный стиль (например, свой цвет текста), иначе формат не сработает.
- Не поддерживается: сложные вложенные таблицы с цветами во вложенных; использование в алиасах и с агрегаторами; `part` вне ODT; в Word фон текста принимает только имена из 17 предопределённых цветов (hex работает для текста и фона ячеек).
- `bindColor`: `{bindColor(цветВШаблоне, формат) = d.var}`. Формат: `#hexa`, `hexa`, `color` (имя, например red), `rgb` (объект {r,g,b}), `hsl` (объект {h,s,l}; s и l 0..100 или 0..1). Устарел в пользу `:color`.

## 4. Гиперлинки и defaultURL (H)

- Динамические ссылки: DOCX, XLSX, PPTX, ODT, ODS, ODP, ODG. На тексте, картинке, таблице или списке ПКМ, Hyperlink, в поле адреса вписывается тег `{d.url}`.
- Автозамена символов редактором (кодирование скобок) не мешает.
- XLSX: внешние скобки не нужны: `d.url`, а не `{d.url}`.
- Смесь статической и динамической частей URL не поддерживается: сохраняется только динамическая часть.
- Валидация URL: протокол необязателен (`http://` или `https://`; без него подставляется `https://`), корневой домен 2..256 символов, TLD (.com, .org...). Не прошёл: подставляется `https://carbone.io/documentation.html#hyperlink-validation`. Это единственная санитизация, о которой говорит документация (запрет схем вроде `javascript:` не упомянут) [неуверенно].
- `:defaultURL`: `{d.url:defaultURL('https://carbone.io')}` или динамический аргумент `{d.url:defaultURL(.urlOnError)}`; вместе с html: `{d.content:defaultURL(.urlOnError):html}` (defaultURL перед `:html`). Когда именно срабатывает (пустое значение, невалидное, оба) страница в пересказе не уточняет [неуверенно]; логично предположить: вместо дефолта carbone.io при провале валидации.

## 5. Текущее поведение в нашем проекте

- `packages/carbone/lib/community.js`: набор DISABLED = html, color, barcode, chart, formatR, defaultURL, autoOrient; ошибка `Formatter "X" is disabled in the Community Edition.` Эталоны Community 5.15.3 из test/golden.
- Матрица (`docs/superpowers/notes/2026-10-13-carbone-community-matrix.md`, строки 150, 222-229):
  - `defaultURL`, `color`, `barcode`: ошибка disabled.
  - `bindColor`: тег удаляется, цвет не меняется (тихо игнорируется).
  - Динамические изображения: заглушка остаётся, alt-текст заменяется на data URI, ошибки нет (тихо игнорируется).
  - `imageFit`: `Formatter "imageFit" does not exist`.
  - Адрес динамической гиперлинки из данных работает уже в Community.
- Справка (`apps/web/src/pages/admin/help/content.ts`, секция «Недоступно в бесплатной версии»): примеры na-color, na-barcode, na-default-url с `unavailable: true`; разделы про изображения (na-images и др. в limits) говорят подставлять иначе.

## Главные неопределённости

1. Документация читалась через пересказ WebFetch: точный синтаксис аргументов `:barcode(type, opt:value)` и `:defaultURL`, а также условия срабатывания defaultURL не подтверждены дословно.
2. Replacement error image и поведение при пустых, null или невалидных данных (изображение, штрихкод) не описаны; тайм-ауты, лимиты размера и allowlist URL не указаны.
3. Версия для `imageFit` и `defaultURL` не названа; поддержка `:color` в XLSX и ODS выведена из отсутствия в матрице.
4. Правила размеров по типам документов (DOCX, XLSX, PPTX, ODT) документация не конкретизирует, кроме imageFit и ограничений циклов.
5. Нет сведений о фильтрации опасных схем URL (`javascript:`), кроме regex-валидации домена и фолбэка.
