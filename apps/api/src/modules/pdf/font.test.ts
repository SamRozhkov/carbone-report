import fontkit from '@pdf-lib/fontkit';
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  cleanPdfText,
  hasGlyph,
  pdfCjkFontBytes,
  pickPdfFont,
  sanitizePdfText,
  unsupportedChars,
} from './font';

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
  it('unsupportedChars — без повторов, управляющие не считаются; иероглифы есть в SC', () => {
    expect(unsupportedChars('a😀b😀\n中🙂')).toEqual(['😀', '🙂']);
    expect(unsupportedChars('第{page}页，共{pages}页 机密')).toEqual([]);
    expect(unsupportedChars('Счёт № 1')).toEqual([]);
  });
});

describe('выбор шрифта на строку (§45.5)', () => {
  it('pickPdfFont: всё есть в Noto Sans — base, иначе — cjk', () => {
    expect(pickPdfFont('Иван Petrov')).toBe('base');
    expect(pickPdfFont('李伟')).toBe('cjk');
    expect(pickPdfFont('Ли Вэй 李伟 😀')).toBe('cjk');
  });
  it('pickPdfFont: символов нет ни в одном шрифте — base, как до 2.14.0', () => {
    expect(pickPdfFont('Владелец: Иванов 😀')).toBe('base');
    expect(pickPdfFont('Стр.\n1')).toBe('base');
  });
  it('sanitizePdfText по выбранному шрифту', () => {
    expect(sanitizePdfText('李伟 😀', 'cjk')).toBe('李伟 ?');
    expect(sanitizePdfText('李伟')).toBe('??');
    expect(hasGlyph('李', 'cjk')).toBe(true);
    expect(hasGlyph('😀', 'cjk')).toBe(false);
  });
  it('cleanPdfText: только управляющие символы → пробел', () => {
    expect(cleanPdfText('李伟\n😀\u2028x')).toBe('李伟 😀 x');
  });
});

describe('Noto Sans SC встраивается подмножеством', () => {
  it('глифы подмножества читаются: контуры есть у каждого символа строки', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(pdfCjkFontBytes(), { subset: true });
    doc.addPage().drawText('签名 李伟 Иван 2026', { x: 40, y: 400, size: 14, font });
    const saved = await PDFDocument.load(await doc.save());
    const descriptor = saved.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .find(
        (o): o is PDFDict =>
          o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('FontDescriptor'),
      )!;
    const file = descriptor.lookup(PDFName.of('FontFile2')) as PDFRawStream;
    const sub = fontkit.create(Buffer.from(decodePDFRawStream(file).decode()));
    // Подмножество: .notdef и по глифу на символ; контуры — у каждого, кроме пробела.
    const drawn = Array.from({ length: sub.numGlyphs - 1 }, (_, i) => sub.getGlyph(i + 1)).filter(
      (g) => g.path.bbox.width > 0,
    );
    expect(drawn).toHaveLength(new Set('签名李伟Иван2026').size);
  });
});
