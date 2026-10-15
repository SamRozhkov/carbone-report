import { describe, expect, it } from 'vitest';
import { hasGlyph, sanitizePdfText, unsupportedChars } from './font';

describe('шрифт PDF (Noto Sans Regular)', () => {
  it('кириллица, латиница, знаки — есть; эмодзи и иероглифы — нет', () => {
    for (const ch of ['Ж', 'ё', 'A', '№', '«', '»', '—', '₽', '%'])
      expect(hasGlyph(ch), ch).toBe(true);
    expect(hasGlyph('😀')).toBe(false);
    expect(hasGlyph('中')).toBe(false);
  });
  it('sanitizePdfText: управляющие → пробел, вне шрифта → ?', () => {
    expect(sanitizePdfText('ЧЕРНОВИК\n😀 中\tX')).toBe('ЧЕРНОВИК ? ? X');
  });
  it('unsupportedChars — без повторов, управляющие не считаются', () => {
    expect(unsupportedChars('a😀b😀\n中')).toEqual(['😀', '中']);
    expect(unsupportedChars('Счёт № 1')).toEqual([]);
  });
});
