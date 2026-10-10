import { describe, expect, it } from 'vitest';
import { communityErrorMessage } from './community';

const msg = (name: string) =>
  `в шаблоне используется ${name} — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»`;

describe('communityErrorMessage', () => {
  it('имя форматтера берётся из ответа Carbone', () => {
    expect(
      communityErrorMessage(
        'Unable to generate the document. Error: Formatter "html" is disabled in the Community Edition. Source: "{d.cars[].note:html}"',
      ),
    ).toBe(msg('html'));
  });

  it('count() Carbone называет cumCount — так и пишем', () => {
    expect(
      communityErrorMessage(
        'Unable to generate the document. Error: Formatter "cumCount" is disabled in the Community Edition. Source: "{d.cars[i].brand:cumCount}"',
      ),
    ).toBe(msg('cumCount'));
  });

  it('имя берётся из фразы «… is disabled …», а не из Source', () => {
    expect(
      communityErrorMessage(
        'Error: Formatter "html" is disabled in the Community Edition. Source: "{d.x:print(\'Formatter "y"\')}"',
      ),
    ).toBe(msg('html'));
  });

  it('имя не разобрать → «форматтер»', () => {
    expect(communityErrorMessage('Error: Formatter is disabled in the Community Edition')).toBe(
      msg('форматтер'),
    );
    expect(
      communityErrorMessage('Error: Formatter "a<b> c" is disabled in the Community Edition'),
    ).toBe(msg('форматтер'));
  });

  it('другие ошибки Carbone — не Community', () => {
    for (const e of [
      'Unable to generate the document. Error: Formatter "fooBar" does not exist. Do you mean "mod"?',
      'Unable to generate the document. Error: The marker {d.cars[i].brand} has no corresponding [i+1] for array "cars".',
      'Template not found',
      'HTTP 500',
    ]) {
      expect(communityErrorMessage(e)).toBeNull();
    }
  });
});
