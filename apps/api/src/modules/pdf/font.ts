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

const BOLD_FONT_FILE = join(dirname(FONT_FILE), 'NotoSans-Bold.ttf');
/** Noto Sans SC Regular (OFL) — строки с китайскими иероглифами (§45.5). */
const CJK_FONT_FILE = join(dirname(FONT_FILE), 'NotoSansSC-Regular.ttf');

/** base — Noto Sans (Regular/Bold), cjk — Noto Sans SC Regular. */
export type PdfFontKind = 'base' | 'cjk';

let boldBytes: Buffer | undefined;

/** Noto Sans Bold — заголовок штампа подписи (§39.5); набор символов тот же, что у Regular. */
export function pdfBoldFontBytes(): Buffer {
  return (boldBytes ??= readFileSync(BOLD_FONT_FILE));
}

let bytes: Buffer | undefined;
let cjkBytes: Buffer | undefined;
const fonts: Partial<Record<PdfFontKind, ReturnType<typeof fontkit.create>>> = {};

export function pdfFontBytes(): Buffer {
  return (bytes ??= readFileSync(FONT_FILE));
}

/** Noto Sans SC Regular; читается при первой строке с иероглифами. */
export function pdfCjkFontBytes(): Buffer {
  return (cjkBytes ??= alignGlyphs(readFileSync(CJK_FONT_FILE)));
}

const checksum = (b: Buffer): number => {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) sum = (sum + b.readUInt32BE(i)) >>> 0;
  return sum;
};
const pad4 = (n: number) => (n + 3) & ~3;

/**
 * Глифы Noto Sans SC с Google Fonts лежат в glyf без выравнивания (нечётные длины). fontkit
 * переносит их в подмножество как есть, а loca подмножества пишет коротким (смещение / 2) — со
 * второго нечётного глифа контуры съезжают и иероглифы не рисуются. Здесь glyf перекладывается
 * с выравниванием глифов по 4 байта (длинный loca); сами глифы и прочие таблицы не меняются.
 */
export function alignGlyphs(src: Buffer): Buffer {
  const numTables = src.readUInt16BE(4);
  const records = Array.from({ length: numTables }, (_, i) => {
    const r = 12 + 16 * i;
    return {
      tag: src.toString('latin1', r, r + 4),
      offset: src.readUInt32BE(r + 8),
      length: src.readUInt32BE(r + 12),
    };
  });
  const table = (tag: string) => records.find((t) => t.tag === tag)!;
  const head = table('head');
  const loca = table('loca');
  const glyf = table('glyf');
  // Короткий loca хранит смещение / 2 — нечётных длин в таком шрифте нет.
  if (src.readInt16BE(head.offset + 50) !== 1) return src;
  const n = src.readUInt16BE(table('maxp').offset + 4);
  const at = (i: number) => src.readUInt32BE(loca.offset + 4 * i);
  let aligned = true;
  for (let i = 0; i < n && aligned; i++) aligned = (at(i + 1) - at(i)) % 4 === 0;
  if (aligned) return src;

  const newLoca = Buffer.alloc(4 * (n + 1));
  const parts: Buffer[] = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    newLoca.writeUInt32BE(pos, 4 * i);
    const g = src.subarray(glyf.offset + at(i), glyf.offset + at(i + 1));
    const size = pad4(g.length);
    parts.push(g, Buffer.alloc(size - g.length));
    pos += size;
  }
  newLoca.writeUInt32BE(pos, 4 * n);
  const data = new Map<string, Buffer>([
    ['glyf', Buffer.concat(parts, pos)],
    ['loca', newLoca],
    ['head', Buffer.from(src.subarray(head.offset, head.offset + head.length))],
  ]);
  data.get('head')!.writeUInt32BE(0, 8); // checkSumAdjustment считается заново ниже

  const dirSize = 12 + 16 * numTables;
  const total = records.reduce((s, t) => s + pad4(data.get(t.tag)?.length ?? t.length), dirSize);
  const out = Buffer.alloc(total);
  src.copy(out, 0, 0, 12);
  let headAt = 0;
  let offset = dirSize;
  records.forEach((t, i) => {
    const body = data.get(t.tag) ?? src.subarray(t.offset, t.offset + t.length);
    body.copy(out, offset);
    if (t.tag === 'head') headAt = offset;
    const r = 12 + 16 * i;
    out.write(t.tag, r, 'latin1');
    out.writeUInt32BE(checksum(out.subarray(offset, offset + pad4(body.length))), r + 4);
    out.writeUInt32BE(offset, r + 8);
    out.writeUInt32BE(body.length, r + 12);
    offset += pad4(body.length);
  });
  out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headAt + 8);
  return out;
}

export function hasGlyph(ch: string, font: PdfFontKind = 'base'): boolean {
  const f = (fonts[font] ??= fontkit.create(font === 'cjk' ? pdfCjkFontBytes() : pdfFontBytes()));
  return f.hasGlyphForCodePoint(ch.codePointAt(0)!);
}

// eslint-disable-next-line no-control-regex -- управляющие символы и есть предмет проверки
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Управляющие символы → пробел; глифы не проверяются (строки Info PDF, текст до выбора шрифта). */
export function cleanPdfText(s: string): string {
  return s.replace(CONTROL, ' ');
}

/**
 * Шрифт строки (§45.5): все символы есть в Noto Sans — base; иначе cjk, если Noto Sans SC
 * рисует хотя бы один из недостающих символов. Символы, которых нет ни в одном шрифте, шрифт
 * не меняют — строка без иероглифов рисуется как до 2.14.0.
 */
export function pickPdfFont(text: string): PdfFontKind {
  for (const ch of cleanPdfText(text)) if (!hasGlyph(ch) && hasGlyph(ch, 'cjk')) return 'cjk';
  return 'base';
}

/** Управляющие символы → пробел, символы вне выбранного шрифта → «?» (R2). */
export function sanitizePdfText(s: string, font: PdfFontKind = 'base'): string {
  let out = '';
  for (const ch of cleanPdfText(s)) out += ch === ' ' || hasGlyph(ch, font) ? ch : '?';
  return out;
}

/** Символы вне шрифта — для ошибки у поля при сохранении. */
export function unsupportedChars(s: string): string[] {
  const bad = new Set<string>();
  for (const ch of cleanPdfText(s)) if (ch !== ' ' && !hasGlyph(ch)) bad.add(ch);
  return [...bad];
}
