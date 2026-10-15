import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';

// Шрифт PDF — тот же Noto Sans, что у графиков (packages/carbone/assets/fonts, OFL): в образе API он уже есть.
const require = createRequire(import.meta.url);
const FONT_FILE = join(
  dirname(require.resolve('@carbone-reports/carbone/package.json')),
  'assets',
  'fonts',
  'NotoSans-Regular.ttf',
);

let bytes: Buffer | undefined;
let font: ReturnType<typeof fontkit.create> | undefined;

export function pdfFontBytes(): Buffer {
  return (bytes ??= readFileSync(FONT_FILE));
}

export function hasGlyph(ch: string): boolean {
  font ??= fontkit.create(pdfFontBytes());
  return font.hasGlyphForCodePoint(ch.codePointAt(0)!);
}

// eslint-disable-next-line no-control-regex -- управляющие символы и есть предмет проверки
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Управляющие символы → пробел, символы вне шрифта → «?» (R2). */
export function sanitizePdfText(s: string): string {
  let out = '';
  for (const ch of s.replace(CONTROL, ' ')) out += ch === ' ' || hasGlyph(ch) ? ch : '?';
  return out;
}

/** Символы вне шрифта — для ошибки у поля при сохранении. */
export function unsupportedChars(s: string): string[] {
  const bad = new Set<string>();
  for (const ch of s.replace(CONTROL, ' ')) if (ch !== ' ' && !hasGlyph(ch)) bad.add(ch);
  return [...bad];
}
