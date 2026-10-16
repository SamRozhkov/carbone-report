import { describe, expect, it } from 'vitest';
import { HELP_SECTIONS } from '../help/content';
import { SNIPPETS, snippetText } from './snippets';

const examples = new Map(HELP_SECTIONS.flatMap((s) => s.examples).map((e) => [e.id, e]));

describe('Конструкции сверены со справкой (§38.5)', () => {
  it.each(SNIPPETS.map((s) => [s.title, s] as const))('%s', (_title, s) => {
    const ex = examples.get(s.helpId);
    expect(ex, `пример ${s.helpId}`).toBeDefined();
    expect(ex!.template).toContain(s.source);
    expect(s.source).toMatch(/^\{[^{}]+\}$/);
    const text = snippetText(s);
    for (const [from] of s.replace) expect(text).not.toContain(from);
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
