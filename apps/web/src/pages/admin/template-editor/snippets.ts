import { i18n } from '../../../i18n';

/**
 * «Конструкции» панели тегов (§38.5): один тег из проверенного примера справки, где имена данных примера
 * заменены обозначениями {field}, {array}, {value}, {yes}, {no}. Обозначения — слова каталога на языке
 * интерфейса (`editor:snippet.word_*`; в ru — «поле», «массив», «значение», «да», «нет»), сами теги Carbone
 * не переводятся. snippets.test.ts сверяет со справкой.
 */
export const SNIPPET_GROUPS = ['conditions', 'format', 'tables'] as const;

/** Подпись конструкции — ключ `editor:snippet.<id>`, группы — `editor:snippet.group_<группа>`. */
export interface Snippet {
  id: string;
  helpId: string;
  group: (typeof SNIPPET_GROUPS)[number];
  template: string;
}

export const SNIPPET_WORDS = ['field', 'array', 'value', 'yes', 'no'] as const;

export const SNIPPETS: Snippet[] = [
  {
    id: 'condText',
    helpId: 'cond-if',
    group: 'conditions',
    template: "{d.{field}:ifEQ('{value}'):show('{yes}'):elseShow('{no}')}",
  },
  {
    id: 'hideBegin',
    helpId: 'cond-paragraphs',
    group: 'conditions',
    template: '{d.{field}:ifEQ(true):hideBegin}',
  },
  {
    id: 'hideEnd',
    helpId: 'cond-paragraphs',
    group: 'conditions',
    template: '{d.{field}:hideEnd}',
  },
  {
    id: 'dateDigits',
    helpId: 'fmt-date-short',
    group: 'format',
    template: "{d.{field}:formatD('DD.MM.YYYY')}",
  },
  {
    id: 'number',
    helpId: 'fmt-number',
    group: 'format',
    template: '{d.{field}:formatN(2)}',
  },
  {
    id: 'money',
    helpId: 'fmt-money',
    group: 'format',
    template: '{d.{field}:formatC()}',
  },
  {
    id: 'loopRow',
    helpId: 'tables-rows',
    group: 'tables',
    template: '{d.{array}[i].{field}}',
  },
  {
    id: 'loopEnd',
    helpId: 'tables-rows',
    group: 'tables',
    template: '{d.{array}[i+1].{field}}',
  },
  {
    id: 'rowNumber',
    helpId: 'tables-numbering',
    group: 'tables',
    template: '{d.{array}[i].{field}:count()}',
  },
  {
    id: 'arraySum',
    helpId: 'agg-sum',
    group: 'tables',
    template: '{d.{array}[].{field}:aggSum}',
  },
];

/** Текст конструкции: обозначения — слова каталога текущего языка. */
export const snippetText = (s: Snippet): string =>
  SNIPPET_WORDS.reduce(
    (text, w) => text.split(`{${w}}`).join(i18n.t(`editor:snippet.word_${w}`)),
    s.template,
  );
