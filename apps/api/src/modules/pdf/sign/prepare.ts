import fontkit from '@pdf-lib/fontkit';
import type { PdfSignaturePosition } from '@carbone-reports/shared';
import {
  beginText,
  concatTransformationMatrix,
  drawObject,
  endText,
  fill,
  moveText,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingRgbColor,
  setFontAndSize,
  setLineWidth,
  setStrokingRgbColor,
  showText,
  stroke,
  type PDFFont,
  type PDFOperator,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import { pdfBoldFontBytes, pdfFontBytes, sanitizePdfText } from '../font';
import { toPage, visualView } from '../postprocess';

export type StampLines = [string, string, string, string, string];

/** Видимый штамп: положение на последней странице и строки (уже в часовом поясе config.tz). */
export interface StampJob {
  position: PdfSignaturePosition;
  lines: StampLines;
}

/** Задача пула рендера `kind: 'sign'` (R3): строки штампа уже отформатированы в часовом поясе config.tz. */
export interface SignPrepareJob {
  position: PdfSignaturePosition;
  lines: StampLines;
  /** Байт под CMS; /Contents — вдвое больше шестнадцатеричных знаков (R4). */
  contentsBytes: number;
  /** Время подписи, ISO — /M. */
  signedAt: string;
}

export const STAMP = { width: 250, height: 80, margin: 24 } as const;
const PAD = 6;
const TITLE_SIZE = 8;
const LINE_SIZE = 7;
const LINE_STEP = 13;
const BLUE = [0x1f / 255, 0x4e / 255, 0x9a / 255] as const;
const PLACEHOLDER = PDFName.of('**********');
/** Матрица внешнего вида: текст поворачивается вместе со страницей, как нумерация (§36.4). */
const MATRIX: Record<0 | 90 | 180 | 270, number[]> = {
  0: [1, 0, 0, 1, 0, 0],
  90: [0, 1, -1, 0, 0, 0],
  180: [-1, 0, 0, -1, 0, 0],
  270: [0, -1, 1, 0, 0, 0],
};

/** Очищает строку (как §36.2) и обрезает с «…» по ширине штампа. */
export function stampText(text: string, font: PDFFont, size: number): string {
  const max = STAMP.width - 2 * PAD;
  const clean = sanitizePdfText(text);
  if (font.widthOfTextAtSize(clean, size) <= max) return clean;
  let t = clean;
  while (t && font.widthOfTextAtSize(`${t}…`, size) > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function stampOperators(lines: StampLines, regular: PDFFont, bold: PDFFont): PDFOperator[] {
  const { width: w, height: h } = STAMP;
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    setFillingRgbColor(1, 1, 1),
    rectangle(0, 0, w, h),
    fill(),
    setStrokingRgbColor(...BLUE),
    setLineWidth(1),
    rectangle(0.5, 0.5, w - 1, h - 1),
    stroke(),
    setFillingRgbColor(...BLUE),
    beginText(),
  ];
  ops.push(
    setFontAndSize('F2', TITLE_SIZE),
    moveText(PAD, h - PAD - TITLE_SIZE),
    showText(bold.encodeText(stampText(lines[0], bold, TITLE_SIZE))),
    setFontAndSize('F1', LINE_SIZE),
  );
  for (const line of lines.slice(1)) {
    ops.push(
      moveText(0, -LINE_STEP),
      showText(regular.encodeText(stampText(line, regular, LINE_SIZE))),
    );
  }
  ops.push(endText(), popGraphicsState());
  return ops;
}

type Matrix = [number, number, number, number, number, number];

interface Stamp {
  page: PDFPage;
  /** Form XObject внешнего вида штампа (BBox 0 0 w h, Matrix — по повороту страницы). */
  xobject: PDFRef;
  /** Прямоугольник штампа на странице (координаты страницы). */
  rect: [number, number, number, number];
  /** cm для вывода xobject содержимым страницы: переносит повёрнутый BBox в rect. */
  matrix: Matrix;
}

/** Штамп на последней странице: шрифты, внешний вид и его место — общее для поля подписи и §42. */
async function buildStamp(doc: PDFDocument, job: StampJob): Promise<Stamp> {
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(pdfFontBytes(), { subset: true });
  const bold = await doc.embedFont(pdfBoldFontBytes(), { subset: true });
  const page = doc.getPages().at(-1)!;
  const v = visualView(page);
  const { width: w, height: h, margin } = STAMP;
  const u =
    job.position === 'bottom-left'
      ? margin
      : job.position === 'bottom-center'
        ? (v.w - w) / 2
        : v.w - margin - w;
  const a = toPage(v, u, margin);
  const b = toPage(v, u + w, margin + h);
  const rect: Stamp['rect'] = [
    Math.min(a.x, b.x),
    Math.min(a.y, b.y),
    Math.max(a.x, b.x),
    Math.max(a.y, b.y),
  ];
  const m = MATRIX[v.rot];
  const xobject = doc.context.register(
    doc.context.formXObject(stampOperators(job.lines, regular, bold), {
      BBox: [0, 0, w, h],
      Matrix: m,
      Resources: { Font: { F1: regular.ref, F2: bold.ref } },
    }),
  );
  // Угол BBox, повёрнутого Matrix формы, — в левый нижний угол rect.
  const corners = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ].map(([x, y]) => [m[0]! * x! + m[2]! * y! + m[4]!, m[1]! * x! + m[3]! * y! + m[5]!]);
  const minX = Math.min(...corners.map((c) => c[0]!));
  const minY = Math.min(...corners.map((c) => c[1]!));
  return { page, xobject, rect, matrix: [1, 0, 0, 1, rect[0] - minX, rect[1] - minY] };
}

/**
 * Поле подписи со штампом на последней странице и заглушки ByteRange и /Contents (§39.4).
 * Документ сохраняется целиком без изменения Info и XMP (PDF/A остаётся действительным).
 */
export async function prepareSignaturePdf(
  pdf: Uint8Array,
  job: SignPrepareJob,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const { page, xobject: appearance, rect } = await buildStamp(doc, job);
  const signature = doc.context.register(
    doc.context.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'ETSI.CAdES.detached',
      ByteRange: [0, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER],
      Contents: PDFHexString.of('0'.repeat(job.contentsBytes * 2)),
      M: PDFString.fromDate(new Date(job.signedAt)),
    }),
  );
  const widget = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of('Signature1'),
      Rect: rect,
      F: 4,
      P: page.ref,
      V: signature,
      AP: { N: appearance },
    }),
  );
  page.node.addAnnot(widget);
  const form = doc.catalog.getOrCreateAcroForm();
  form.addField(widget);
  form.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/**
 * Видимый штамп без поля подписи (§42): содержимое последней страницы дополняется выводом
 * XObject штампа. Info и XMP не меняются; одинаковые входы дают одинаковые байты — хеш документа,
 * подписанного в браузере, совпадает с хешем повторной подготовки.
 */
export async function prepareStampPdf(pdf: Uint8Array, job: StampJob): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const { page, xobject, matrix } = await buildStamp(doc, job);
  // Имя — первое свободное St1, St2, … (не случайное: результат детерминирован).
  const resources = page.node.normalizedEntries().XObject;
  let n = 1;
  while (resources.has(PDFName.of(`St${n}`))) n++;
  const name = `St${n}`;
  page.node.setXObject(PDFName.of(name), xobject);
  // pushOperators обрамляет прежнее содержимое q … Q: его cm не сдвинет штамп.
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...matrix),
    drawObject(name),
    popGraphicsState(),
  );
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
