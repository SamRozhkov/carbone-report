import { describe, expect, it } from 'vitest';
import { HELP_SECTIONS } from '../help/content/ru';
import { SNIPPETS, SNIPPET_WORDS, snippetText } from './snippets';

const examples = new Map(HELP_SECTIONS.flatMap((s) => s.examples).map((e) => [e.id, e]));

/** Обозначение — имя данных примера: идентификатор для поля и массива, текст в кавычках для значений. */
const WILDCARD: Record<(typeof SNIPPET_WORDS)[number], string> = {
  field: '\\w+',
  array: '\\w+',
  value: "[^']*",
  yes: "[^']*",
  no: "[^']*",
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = (template: string) =>
  new RegExp(
    template
      .split(/(\{(?:field|array|value|yes|no)\})/)
      .map((p, i) => (i % 2 ? WILDCARD[p.slice(1, -1) as keyof typeof WILDCARD] : escape(p)))
      .join(''),
  );

describe('Конструкции сверены со справкой (§38.5)', () => {
  it.each(SNIPPETS.map((s) => [s.id, s] as const))('%s', (_id, s) => {
    const ex = examples.get(s.helpId);
    expect(ex, `пример ${s.helpId}`).toBeDefined();
    expect(ex!.template).toMatch(pattern(s.template));
    const text = snippetText(s);
    expect(text).toMatch(/^\{[^{}]+\}$/);
    expect(text).toMatch(/поле|массив/);
  });

  it('тексты фрагментов', () => {
    expect(SNIPPETS.map(snippetText)).toEqual([
      "{d.поле:ifEQ('значение'):show('да'):elseShow('нет')}",
      '{d.поле:ifEQ(true):hideBegin}',
      '{d.поле:hideEnd}',
      "{d.поле:formatD('DD.MM.YYYY')}",
      '{d.поле:formatN(2)}',
      '{d.поле:formatC()}',
      '{d.массив[i].поле}',
      '{d.массив[i+1].поле}',
      '{d.массив[i].поле:count()}',
      '{d.массив[].поле:aggSum}',
    ]);
  });
});
