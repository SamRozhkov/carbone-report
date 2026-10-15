import { decodePDFRawStream, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

/** Файл не подходит как приложение: текст — для пользователя. */
export class PdfInputError extends Error {}

const PDFAID_RE = /pdfaid:part\s*(?:=\s*["']\s*[1-4]|>\s*[1-4]\s*<)/;

/** XMP каталога (без фильтра или с FlateDecode); нет — null. */
export function readXmp(doc: PDFDocument): string | null {
  const ref = doc.catalog.get(PDFName.of('Metadata'));
  const stream = ref ? doc.context.lookup(ref) : undefined;
  if (!(stream instanceof PDFRawStream)) return null;
  return new TextDecoder().decode(decodePDFRawStream(stream).decode());
}

/** Проверка приложенного файла (§36.3): PDF, не повреждён, без шифрования; страницы и заявленный PDF/A. */
export async function inspectPdf(data: Uint8Array): Promise<{ pages: number; pdfa: boolean }> {
  if (Buffer.from(data.subarray(0, 5)).toString('latin1') !== '%PDF-') {
    throw new PdfInputError('файл не PDF');
  }
  let doc: PDFDocument;
  let pages: number;
  try {
    doc = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
    if (doc.isEncrypted) throw new PdfInputError('PDF защищён паролем');
    pages = doc.getPageCount();
  } catch (e) {
    if (e instanceof PdfInputError) throw e;
    throw new PdfInputError('PDF повреждён');
  }
  if (pages === 0) throw new PdfInputError('PDF повреждён');
  let xmp: string | null;
  try {
    xmp = readXmp(doc);
  } catch {
    xmp = null;
  }
  return { pages, pdfa: xmp !== null && PDFAID_RE.test(xmp) };
}
