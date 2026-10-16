/**
 * «Конструкции» панели тегов (§38.5): один тег из проверенного примера справки (`source`) с заменой имён
 * данных примера на обозначения `поле`, `массив`, `значение`. snippets.test.ts сверяет со справкой.
 */
export const SNIPPET_GROUPS = ['Условия', 'Формат', 'Таблицы'] as const;

export interface Snippet {
  helpId: string;
  group: (typeof SNIPPET_GROUPS)[number];
  title: string;
  source: string;
  replace: [from: string, to: string][];
}

export const SNIPPETS: Snippet[] = [
  {
    helpId: 'cond-if',
    group: 'Условия',
    title: 'Текст по условию',
    source: "{d.status:ifEQ('paid'):show('Оплачен'):elseShow('Не оплачен')}",
    replace: [
      ['d.status', 'd.поле'],
      ["'paid'", "'значение'"],
      ["'Не оплачен'", "'нет'"],
      ["'Оплачен'", "'да'"],
    ],
  },
  {
    helpId: 'cond-paragraphs',
    group: 'Условия',
    title: 'Скрыть блок: начало',
    source: '{d.paid:ifEQ(true):hideBegin}',
    replace: [['d.paid', 'd.поле']],
  },
  {
    helpId: 'cond-paragraphs',
    group: 'Условия',
    title: 'Скрыть блок: конец',
    source: '{d.paid:hideEnd}',
    replace: [['d.paid', 'd.поле']],
  },
  {
    helpId: 'fmt-date-short',
    group: 'Формат',
    title: 'Дата цифрами',
    source: "{d.date:formatD('DD.MM.YYYY')}",
    replace: [['d.date', 'd.поле']],
  },
  {
    helpId: 'fmt-number',
    group: 'Формат',
    title: 'Число',
    source: '{d.n:formatN(2)}',
    replace: [['d.n:', 'd.поле:']],
  },
  {
    helpId: 'fmt-money',
    group: 'Формат',
    title: 'Сумма в рублях',
    source: '{d.sum:formatC()}',
    replace: [['d.sum', 'd.поле']],
  },
  {
    helpId: 'tables-rows',
    group: 'Таблицы',
    title: 'Строка цикла',
    source: '{d.cars[i].brand}',
    replace: [
      ['d.cars', 'd.массив'],
      ['brand', 'поле'],
    ],
  },
  {
    helpId: 'tables-rows',
    group: 'Таблицы',
    title: 'Следующая строка — конец цикла',
    source: '{d.cars[i+1].brand}',
    replace: [
      ['d.cars', 'd.массив'],
      ['brand', 'поле'],
    ],
  },
  {
    helpId: 'tables-numbering',
    group: 'Таблицы',
    title: 'Номер строки',
    source: '{d.cars[i].brand:count()}',
    replace: [
      ['d.cars', 'd.массив'],
      ['brand', 'поле'],
    ],
  },
  {
    helpId: 'agg-sum',
    group: 'Таблицы',
    title: 'Сумма по массиву',
    source: '{d.cars[].qty:aggSum}',
    replace: [
      ['d.cars', 'd.массив'],
      ['qty', 'поле'],
    ],
  },
];

export const snippetText = (s: Snippet): string =>
  s.replace.reduce((text, [from, to]) => text.split(from).join(to), s.source);
