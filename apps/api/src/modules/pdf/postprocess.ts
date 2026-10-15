import fontkit from '@pdf-lib/fontkit';
import {
  PDF_COLORS,
  type PdfColor,
  type PdfPlacement,
  type PdfPosition,
} from '@carbone-reports/shared';
import { degrees, PDFDocument, PDFName, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { pdfFontBytes, sanitizePdfText } from './font';

export const PDF_PRODUCER = 'carbone-reports';

export interface PdfPostJob {
  pdfa: boolean;
  watermark: {
    text: string;
    opacity: number;
    color: PdfColor;
    angle: 'diagonal' | 'horizontal';
  } | null;
  pageNumbers: { format: string; position: PdfPosition; skipFirst: boolean } | null;
  /** Значения уже подставлены; пустая строка — поле не меняется (title пустым не бывает). */
  metadata: { title: string; author: string; subject: string; keywords: string } | null;
  /** В порядке итогового документа: start по порядку, затем end по порядку. */
  attachments: { placement: PdfPlacement; data: Uint8Array }[];
  /** Момент сборки, ISO — CreationDate/ModDate и даты XMP (R3). */
  now: string;
}

const WATERMARK_SHARE = 0.8;
const WATERMARK_MAX_SIZE = 120;
const WATERMARK_MIN_SIZE = 6;
const NUMBER_SIZE = 9;
const NUMBER_COLOR = '#404040';
const NUMBER_MARGIN = 24;

const hex = (h: string) =>
  rgb(
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  );

export interface VisualView {
  box: { x: number; y: number; width: number; height: number };
  rot: 0 | 90 | 180 | 270;
  /** Ширина и высота страницы так, как её видит читатель. */
  w: number;
  h: number;
}

/** Видимая область: CropBox (иначе MediaBox) с учётом /Rotate (по часовой стрелке). */
export function visualView(page: PDFPage): VisualView {
  const box = page.getCropBox();
  const rot = ((((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) %
    360) as VisualView['rot'];
  const turned = rot === 90 || rot === 270;
  return { box, rot, w: turned ? box.height : box.width, h: turned ? box.width : box.height };
}

/** Точка видимой страницы (u — вправо, v — вверх от левого нижнего угла) → координаты страницы. */
export function toPage(v: VisualView, u: number, w: number): { x: number; y: number } {
  const { x, y, width, height } = v.box;
  switch (v.rot) {
    case 90:
      return { x: x + width - w, y: y + u };
    case 180:
      return { x: x + width - u, y: y + height - w };
    case 270:
      return { x: x + w, y: y + height - u };
    default:
      return { x: x + u, y: y + w };
  }
}

function drawWatermark(
  page: PDFPage,
  font: PDFFont,
  text: string,
  wm: NonNullable<PdfPostJob['watermark']>,
) {
  const v = visualView(page);
  const phi = wm.angle === 'diagonal' ? Math.atan2(v.h, v.w) : 0;
  const span = wm.angle === 'diagonal' ? Math.hypot(v.w, v.h) : v.w;
  const size = Math.min(
    WATERMARK_MAX_SIZE,
    Math.max(WATERMARK_MIN_SIZE, (span * WATERMARK_SHARE) / font.widthOfTextAtSize(text, 1)),
  );
  const tw = font.widthOfTextAtSize(text, size);
  const th = font.heightAtSize(size, { descender: false });
  // Начало строки — так, чтобы центр строки совпал с центром видимой страницы.
  const u = v.w / 2 - (tw / 2) * Math.cos(phi) + (th / 2) * Math.sin(phi);
  const w = v.h / 2 - (tw / 2) * Math.sin(phi) - (th / 2) * Math.cos(phi);
  const p = toPage(v, u, w);
  page.drawText(text, {
    x: p.x,
    y: p.y,
    size,
    font,
    color: hex(PDF_COLORS[wm.color]),
    opacity: wm.opacity / 100,
    rotate: degrees((phi * 180) / Math.PI + v.rot),
  });
}

function drawPageNumber(page: PDFPage, font: PDFFont, text: string, position: PdfPosition) {
  const v = visualView(page);
  const tw = font.widthOfTextAtSize(text, NUMBER_SIZE);
  const th = font.heightAtSize(NUMBER_SIZE, { descender: false });
  const u = position === 'bottom-center' ? (v.w - tw) / 2 : v.w - NUMBER_MARGIN - tw;
  const w = position === 'top-right' ? v.h - NUMBER_MARGIN - th : NUMBER_MARGIN;
  const p = toPage(v, u, w);
  page.drawText(text, {
    x: p.x,
    y: p.y,
    size: NUMBER_SIZE,
    font,
    color: hex(NUMBER_COLOR),
    rotate: degrees(v.rot),
  });
}

function writeInfo(doc: PDFDocument, job: PdfPostJob): void {
  const m = job.metadata;
  if (m) {
    if (m.title) doc.setTitle(sanitizePdfText(m.title));
    if (m.author) doc.setAuthor(sanitizePdfText(m.author));
    if (m.subject) doc.setSubject(sanitizePdfText(m.subject));
    if (m.keywords) doc.setKeywords([sanitizePdfText(m.keywords)]);
  }
  const now = new Date(job.now);
  doc.setProducer(PDF_PRODUCER);
  doc.setCreationDate(now);
  doc.setModificationDate(now);
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Info хранит даты с точностью до секунды — XMP так же (R3). */
const xmpDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** XMP из итогового Info: при PDF/A значения Info и XMP обязаны совпадать (R3). */
function writeXmp(doc: PDFDocument, pdfa: boolean): void {
  const lines: string[] = ['<dc:format>application/pdf</dc:format>'];
  const title = doc.getTitle();
  const author = doc.getAuthor();
  const subject = doc.getSubject();
  const keywords = doc.getKeywords();
  const creator = doc.getCreator();
  const producer = doc.getProducer();
  const created = doc.getCreationDate();
  const modified = doc.getModificationDate();
  if (title)
    lines.push(
      `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(title)}</rdf:li></rdf:Alt></dc:title>`,
    );
  if (author)
    lines.push(`<dc:creator><rdf:Seq><rdf:li>${esc(author)}</rdf:li></rdf:Seq></dc:creator>`);
  if (subject)
    lines.push(
      `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(subject)}</rdf:li></rdf:Alt></dc:description>`,
    );
  if (keywords) lines.push(`<pdf:Keywords>${esc(keywords)}</pdf:Keywords>`);
  if (producer) lines.push(`<pdf:Producer>${esc(producer)}</pdf:Producer>`);
  if (creator) lines.push(`<xmp:CreatorTool>${esc(creator)}</xmp:CreatorTool>`);
  if (created) lines.push(`<xmp:CreateDate>${xmpDate(created)}</xmp:CreateDate>`);
  if (modified) lines.push(`<xmp:ModifyDate>${xmpDate(modified)}</xmp:ModifyDate>`);
  if (pdfa)
    lines.push('<pdfaid:part>2</pdfaid:part>', '<pdfaid:conformance>B</pdfaid:conformance>');
  const xml =
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '<rdf:Description rdf:about=""' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    ' xmlns:xmp="http://ns.adobe.com/xap/1.0/"' +
    ' xmlns:pdf="http://ns.adobe.com/pdf/1.3/"' +
    (pdfa ? ' xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"' : '') +
    '>\n' +
    lines.join('\n') +
    '\n</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>';
  // Без Filter: поток метаданных PDF/A-2 не сжимается. Строка — в UTF-8 (pdf-lib пишет строку побайтно).
  const stream = doc.context.stream(new TextEncoder().encode(xml), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
}

/**
 * Итоговый PDF (§36.4): приложения, водяной знак, нумерация, Info и XMP. База — документ отчёта:
 * его OutputIntents и /ID трейлера сохраняются (R4).
 */
export async function postprocessPdf(pdf: Uint8Array, job: PdfPostJob): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  let at = 0;
  for (const a of job.attachments) {
    const src = await PDFDocument.load(a.data, { updateMetadata: false });
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const p of pages) {
      if (a.placement === 'start') doc.insertPage(at++, p);
      else doc.addPage(p);
    }
  }
  const watermark = job.watermark ? sanitizePdfText(job.watermark.text).trim() : '';
  if (watermark || job.pageNumbers) {
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(pdfFontBytes(), { subset: true });
    const pages = doc.getPages();
    if (watermark) for (const p of pages) drawWatermark(p, font, watermark, job.watermark!);
    const pn = job.pageNumbers;
    if (pn) {
      pages.forEach((p, i) => {
        if (pn.skipFirst && i === 0) return;
        const text = sanitizePdfText(
          pn.format.replaceAll('{page}', String(i + 1)).replaceAll('{pages}', String(pages.length)),
        );
        drawPageNumber(p, font, text, pn.position);
      });
    }
  }
  writeInfo(doc, job);
  writeXmp(doc, job.pdfa);
  return doc.save({ useObjectStreams: false });
}
