// Только для тестов: PDF с подписанными страницами и текст страниц (unpdf, pdf.js).
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { extractText, getDocumentProxy } from 'unpdf';

export interface TestPage {
  label: string;
  size?: [number, number];
  rotate?: 0 | 90 | 180 | 270;
  /** CropBox [x, y, ширина, высота]. */
  crop?: [number, number, number, number];
}

export async function makePdf(pages: TestPage[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage(p.size ?? [595, 842]);
    if (p.crop) page.setCropBox(...p.crop);
    if (p.rotate) page.setRotation(degrees(p.rotate));
    const [x, y] = p.crop ? [p.crop[0] + 40, p.crop[1] + 300] : [40, 300];
    page.drawText(p.label, { x, y, size: 14, font });
  }
  return doc.save();
}

/** Текст каждой страницы; `password` — для зашифрованного PDF. */
export async function pageTexts(pdf: Uint8Array, password?: string): Promise<string[]> {
  const proxy = await getDocumentProxy(new Uint8Array(pdf), password ? { password } : undefined);
  const { text } = await extractText(proxy, { mergePages: false });
  return text as string[];
}
