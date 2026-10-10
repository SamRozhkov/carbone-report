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
  /** Показан как «так нельзя»: кнопки «Копировать» нет. */
  antiPattern?: true;
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
        note: "Параметры отчёта лежат в `d.params` под своими именами. Теги `{c.…}` система сама не заполняет, кроме `{c.now}` — момента формирования: `{c.now:formatD('DD.MM.YYYY')}`. Свои значения в `c` можно записать только через `:set` (см. раздел «Итоги и группировка»).",
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
        result: L(
          '| Марка | Кол-во |',
          '| Лада | 3 |',
          '| Тесла | 1 |',
          '| Лада | 2 |',
          '| БМВ | 5 |',
        ),
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
          '| {d.cars[i].brand:count()} | {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| № | Марка |', '| 1 | Лада |', '| 2 | Тесла |', '| 3 | Лада |', '| 4 | БМВ |'),
        note: 'Номера идут 1, 2, 3… по выводимым строкам, в том числе в цикле с фильтром — без пропусков. Тег `{d.cars[i].i}` ничего не печатает. Старый способ `{d.cars[i].brand:print(.i):add(1)}` тоже работает, но `.i` — номер в исходном массиве, при фильтре в цикле номера идут с пропусками. Число в начале скобок, как в старой версии Carbone (`count(0)`), не учитывается: нумерация всегда с 1. Фильтр и сортировку цикла повторите в самом теге с `count()` (`{d.cars[i, ok=true].brand:count()}`), иначе строка нумерует свой набор. Строки, удалённые `drop(row)`, номер получают — нумерация пойдёт с пропусками; отбирайте строки фильтром цикла. Нумерация, итоги и подытоги — раздел «Итоги и нумерация».',
      },
      {
        id: 'tables-filter',
        title: 'Отбор строк',
        template: L('| {d.cars[i, ok=true].brand} |', '| {d.cars[i+1, ok=true].brand} |'),
        data: j({ cars: CARS }),
        result: L('| Лада |', '| Лада |', '| БМВ |'),
        note: "Так же работают сравнения `[i, qty > 1]`, строки `[i, brand='Лада']` и несколько условий через запятую — они соединяются через И; ИЛИ нет, заведите флаг в SQL. Скрыть строку таблицы можно так или тегом `drop(row)`; `hideBegin`/`hideEnd` в таблице оставляют пустую строку (раздел «Условия»).",
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
      'Абзацы и части текста скрывают `showBegin`/`showEnd` и `hideBegin`/`hideEnd`. Строку таблицы скрывают фильтром цикла (раздел «Таблицы») или `drop(row)`; абзац, таблицу, рисунок целиком удаляют `drop`/`keep`.',
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
        id: 'cond-drop-p',
        title: 'Удалить абзац (drop)',
        template: L('до', '{d.f:ifEQ(true):drop(p)}удалить абзац', 'после'),
        data: j({ f: true }),
        result: L('до', 'после'),
        note: 'Тег ставьте в самом абзаце и последним в цепочке форматтеров. Условие — результат `ifEQ`, `ifGT` и других. Без условия решает само значение: удаляют `true`, ненулевое число, непустой текст, кроме `"0"` и `"false"`, непустой список; не удаляют `false`, `0`, пустой текст, `"0"`, `"false"`, пустое или отсутствующее значение — флаги 0/1 из БД работают как есть. Работает в DOCX, ODT, PPTX, ODP; в XLSX и ODS абзацев нет.',
      },
      {
        id: 'cond-keep-p',
        title: 'Оставить абзац только при условии (keep)',
        template: L('до', '{d.f:ifEQ(true):keep(p)}оставить абзац', 'после'),
        data: j({ f: false }),
        result: L('до', 'после'),
        note: '`keep` — обратный `drop`: абзац остаётся, только если условие истинно. Так же работают `drop(table)`, `drop(img)`, `drop(shape)`, `drop(chart)`; в ODS — `drop(sheet)`, в ODP — `drop(slide)`.',
      },
      {
        id: 'cond-drop-row',
        title: 'Удалить строку таблицы (drop(row))',
        template: L(
          '| Марка | Кол-во |',
          '| {d.cars[i].ok:ifEQ(false):drop(row)}{d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Марка | Кол-во |', '| Лада | 3 |', '| Лада | 2 |', '| БМВ | 5 |'),
        note: 'Строка «Тесла» удалена целиком, оформление таблицы не ломается. В отличие от `hideBegin`, `drop(row)` работает в цикле. Если удалены все строки таблицы, исчезает и таблица. `drop(col)` убирает столбец; в XLSX объединённые ячейки и автофильтр при этом не пересчитываются, а на листе с форматированной таблицей («Форматировать как таблицу») `drop(col)` недоступен. Флаг без условия тоже работает: `{d.cars[i].archived:drop(row)}` удалит строки с `archived` = 1 и оставит с 0. Нарастающие итоги, `:count()` и итоги `aggSum` по `[]` учитывают и удалённые строки — чтобы строка не попала ни в таблицу, ни в итог, отбирайте строки фильтром цикла и тем же фильтром в итоге (`[ok=true]`).',
      },
      {
        id: 'cond-table-row',
        antiPattern: true,
        title: 'hideBegin в строке таблицы (так нельзя)',
        template: L(
          '| Марка | Кол-во |',
          '| {d.cars[i].ok:ifEQ(false):hideBegin}{d.cars[i].brand} | {d.cars[i].qty}{d.cars[i].ok:hideEnd} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Марка | Кол-во |', '| Лада | 3 |', '| |', '| Лада | 2 |', '| БМВ | 5 |'),
        note: 'Вместо строки «Тесла» остаётся пустая строка из одной ячейки, оформление таблицы ломается. Скрывайте строки фильтром цикла (`{d.cars[i, ok=true].brand}`) или `drop(row)`.',
      },
    ],
  },
  {
    id: 'aggregates',
    title: 'Итоги и нумерация',
    intro: [
      'Агрегаторы считают по всему набору: `aggSum` — сумма, `aggAvg` — среднее, `aggMin`/`aggMax` — наименьшее и наибольшее, `aggCount` — число элементов, `aggCountD` — число разных значений, `aggStr`/`aggStrD` — значения через запятую (`D` — без повторов). Версии `cum…` (`cumSum`, `cumCount`, `cumCountD`) дают нарастающий итог по строкам цикла, `:count()` — номер строки.',
      'Скобки в пути выбирают режим. `[]` — один итог по всему массиву (можно в любом месте документа, в том числе после таблицы), `[sort>1]` или `[ok=true]` — итог только по отобранным. `[i]` в цикле — значение для каждой строки; именно `[i]` нужен для нарастающих итогов, `:count()` и группировки `aggSum(.brand)`.',
      'Результат — число без округления: оформляйте форматтером после агрегатора, например `:aggAvg:formatN(2)`. Нечисловые значения (текст, пустые, `null`) в суммах пропускаются; число в строке (`"2"`) считается числом. Пустой массив или отсутствующий ключ — без ошибки: `aggSum`, `aggCount`, `aggCountD`, `cumSum` дают 0, `aggAvg`, `aggMin`, `aggMax`, `aggStr`, `aggStrD` — пусто.',
    ],
    examples: [
      {
        id: 'agg-sum',
        title: 'Итог вне цикла',
        template: 'Всего: {d.cars[].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Всего: 11',
        note: 'Итог не зависит от того, где в документе стоит тег и выводится ли этот же массив циклом.',
      },
      {
        id: 'agg-filter',
        title: 'Итог с отбором',
        template: 'Оплачено: {d.cars[ok=true].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Оплачено: 10',
        note: "Условия в скобках те же, что в цикле: `[qty>1]`, `[brand='Лада']`, несколько через запятую. Фильтр цикла в документе на итог не влияет, а фильтр в самом теге — влияет.",
      },
      {
        id: 'agg-others',
        title: 'Среднее, наибольшее, количество',
        template: L(
          'Позиций: {d.cars[].qty:aggCount}, среднее {d.cars[].qty:aggAvg:formatN(2)}',
          'Наибольшее {d.cars[].qty:aggMax}, наименьшее {d.cars[].qty:aggMin}',
          'Разных марок: {d.cars[].brand:aggCountD}',
        ),
        data: j({ cars: CARS }),
        result: L('Позиций: 4, среднее 2,75', 'Наибольшее 5, наименьшее 1', 'Разных марок: 3'),
        note: '`aggCount` считает все элементы, а `aggCountD` — разные значения. Форматтер можно поставить и перед агрегатором: `{d.cars[].qty:mul(2):aggSum}` суммирует удвоенные значения.',
      },
      {
        id: 'agg-str',
        title: 'Значения в строку',
        template: L("Марки: {d.cars[].brand:aggStrD(', ')}", "Все: {d.cars[].brand:aggStr(' | ')}"),
        data: j({ cars: CARS }),
        result: L('Марки: Тесла, Лада, БМВ', 'Все: Лада | Тесла | Лада | БМВ'),
        note: 'Без аргумента разделитель — запятая с пробелом. Порядок у `aggStrD` — по последнему вхождению значения.',
      },
      {
        id: 'agg-total-row',
        title: 'Строка «Итого» под таблицей',
        template: L(
          '| Марка | Кол-во |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
          '| Итого | {d.cars[].qty:aggSum} |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Марка | Кол-во |',
          '| Лада | 3 |',
          '| Тесла | 1 |',
          '| Лада | 2 |',
          '| БМВ | 5 |',
          '| Итого | 11 |',
        ),
        note: 'Строку «Итого» оформляйте в Word обычной строкой под строкой `[i+1]`. Если в строке цикла написать `{d.cars[i].qty:aggSum}`, на каждой строке будет тот же общий итог: `[i]` по всему набору, а не по строкам выше.',
      },
      {
        id: 'agg-cum',
        title: 'Нарастающий итог',
        template: L(
          '| Марка | Кол-во | Всего |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:cumSum} |',
          '| {d.cars[i+1].brand} | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Марка | Кол-во | Всего |',
          '| Лада | 3 | 3 |',
          '| Тесла | 1 | 4 |',
          '| Лада | 2 | 6 |',
          '| БМВ | 5 | 11 |',
        ),
        note: 'Нарастающий итог идёт в порядке и по набору строк, заданных скобками самого тега `cumSum`. Если цикл отфильтрован или отсортирован (`[i, ok=true]`, `[qty, i]`), те же условия, включая сортировку, повторите в скобках тега нарастающего итога: сортировка цикла на него не действует. С `[]` вместо `[i]` — ошибка шаблона.',
      },
      {
        id: 'agg-partition',
        title: 'Итог по группе в строке',
        template: L(
          '| Марка | Кол-во | По марке | Номер в марке |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:aggSum(.brand)} | {d.cars[i].qty:cumCount(.brand)} |',
          '| {d.cars[i+1].brand} | | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Марка | Кол-во | По марке | Номер в марке |',
          '| Лада | 3 | 5 | 1 |',
          '| Тесла | 1 | 1 | 1 |',
          '| Лада | 2 | 5 | 2 |',
          '| БМВ | 5 | 5 | 1 |',
        ),
        note: 'Аргумент `(.brand)` — путь от элемента цикла: агрегатор считает отдельно по каждому значению. Он работает только в цикле `[i]`; значения сравниваются строго: число 1 и строка "1" — разные группы. Аргумент должен быть путём с точкой, `aggSum(brand)` — ошибка.',
      },
      {
        id: 'agg-nested',
        title: 'Подытог по вложенному массиву',
        template: L(
          '{d.groups[i].name}: {d.groups[i].items[].qty:aggSum}',
          '- {d.groups[i].items[i].x} {d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
          'Всего: {d.groups[].items[].qty:aggSum}',
        ),
        data: j({
          groups: [
            {
              name: 'Г1',
              items: [
                { x: 'a', qty: 2 },
                { x: 'b', qty: 3 },
              ],
            },
            { name: 'Г2', items: [{ x: 'c', qty: 4 }] },
            { name: 'Г3', items: [] },
          ],
        }),
        result: L('Г1: 5', '- a 2', '- b 3', 'Г2: 4', '- c 4', 'Г3: 0', 'Всего: 9'),
        note: '`[i]` у внешнего массива и `[]` у вложенного дают подытог внутри каждой группы; пустая группа даёт 0. Два `[]` подряд — общий итог по всем группам. Группировать для подытогов внешним циклом по полю вроде `[brand]` нельзя — сгруппируйте через `:set` и считайте `aggSum` по группе (пример «Подытоги по группам (:set)» в разделе «Итоги и группировка») или в SQL. Если вложенный путь проходит через объект (`{d.items[].sub.qty:aggSum}`), под `[]` будет ошибка: подставьте нужное поле через `print(.sub.qty)` или `[i]`.',
      },
    ],
  },
  {
    id: 'totals',
    title: 'Итоги и группировка',
    intro: [
      'Итоги, подытоги и нумерацию можно получить и в шаблоне — раздел «Итоги и нумерация». Группы с подытогами тоже собираются в шаблоне (`:set` + `aggSum`). SQL нужен там, где шаблон не справляется: отбор с условием ИЛИ и сортировка по убыванию; на очень больших наборах (десятки тысяч строк) итоги с фильтром в скобках быстрее считать в SQL.',
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
        note: 'Группы идут в порядке первого появления, тег с `:set` ничего не печатает. Сохраняйте объект целиком (`d.cars[]:set(…rows[])`), а не отдельные поля. Подытог группы — `aggSum` по её строкам, следующий пример.',
      },
      {
        id: 'totals-set-subtotal',
        title: 'Подытоги по группам (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}: {c.g[i].rows[].qty:aggSum} шт.',
          '{c.g[i+1].id}',
          'Всего: {d.cars[].qty:aggSum} шт.',
        ),
        data: j({ cars: CARS }),
        result: L('Лада: 5 шт.', 'Тесла: 1 шт.', 'БМВ: 5 шт.', 'Всего: 11 шт.'),
        note: '`:set` собирает строки по марке, `{c.g[i].rows[].qty:aggSum}` — подытог внутри каждой группы. Так же работают `aggCount`, `aggAvg` и остальные агрегаторы, а строки группы можно вывести вложенным циклом, как в примере выше.',
      },
      {
        id: 'totals-set-sum',
        antiPattern: true,
        title: 'Сумма через :set (неверно)',
        template: '{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}Итого: {c.total}',
        data: j({ zero: 0, cars: CARS }),
        result: 'Итого: 14',
        note: 'Правильный итог — 11: первый элемент учитывается дважды. Суммы считайте агрегатором `aggSum` (раздел «Итоги и нумерация») или в SQL.',
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
        instead:
          'Отключён, шаблон с ним не формируется. Поворачивайте изображение в самом шаблоне.',
      },
      {
        id: 'na-sort-desc',
        title: 'Сортировка по убыванию',
        instead:
          '`[-qty, i]` молча оставляет исходный порядок: в Carbone такой возможности пока нет. Сортируйте в SQL: `order by qty desc`.',
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
