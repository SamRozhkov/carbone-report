import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { inspectPdf, PdfInputError } from './inspect';
import { makePdf } from './test-pdf';

async function withXmp(xmp: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await makePdf([{ label: 'a' }]));
  const stream = doc.context.stream(new TextEncoder().encode(xmp), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  return doc.save();
}

describe('inspectPdf', () => {
  it('страницы и признак PDF/A (атрибут и элемент)', async () => {
    expect(await inspectPdf(await makePdf([{ label: 'a' }, { label: 'b' }]))).toEqual({
      pages: 2,
      pdfa: false,
    });
    const attr = await withXmp('<rdf:Description pdfaid:part="2" pdfaid:conformance="B"/>');
    expect((await inspectPdf(attr)).pdfa).toBe(true);
    const elem = await withXmp('<pdfaid:part>1</pdfaid:part>');
    expect((await inspectPdf(elem)).pdfa).toBe(true);
  });

  it('не PDF, битый и с паролем — PdfInputError с текстом', async () => {
    await expect(inspectPdf(Buffer.from('PK\x03\x04 zip'))).rejects.toThrow(
      new PdfInputError('pdf.notPdf'),
    );
    await expect(inspectPdf(Buffer.from('%PDF-1.7\nмусор'))).rejects.toThrow('PDF повреждён');
    const doc = await PDFDocument.load(await makePdf([{ label: 'a' }]));
    doc.context.trailerInfo.Encrypt = doc.context.register(
      doc.context.obj({
        Filter: 'Standard',
        V: 1,
        R: 2,
        O: PDFString.of('o'),
        U: PDFString.of('u'),
        P: -4,
      }),
    );
    await expect(inspectPdf(await doc.save())).rejects.toThrow('PDF защищён паролем');
  });
});
