import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { readXmp } from './inspect';
import {
  infoDict,
  PDF_PRODUCER,
  postprocessPdf,
  toPage,
  visualView,
  type PdfPostJob,
} from './postprocess';
import { makePdf, pageTexts } from './test-pdf';

const NOW = '2026-10-15T09:30:00.000Z';
const job = (over: Partial<PdfPostJob> = {}): PdfPostJob => ({
  pdfa: false,
  watermark: null,
  pageNumbers: null,
  metadata: null,
  attachments: [],
  now: NOW,
  ...over,
});
const numbers = {
  format: 'Стр. {page} из {pages}',
  position: 'bottom-center',
  skipFirst: false,
} as const;

describe('postprocessPdf', () => {
  it('приложения: start по порядку, отчёт, end', async () => {
    const report = await makePdf([{ label: 'R1' }, { label: 'R2' }]);
    const out = await postprocessPdf(
      report,
      job({
        attachments: [
          { placement: 'start', data: await makePdf([{ label: 'A1' }]) },
          { placement: 'start', data: await makePdf([{ label: 'B1' }, { label: 'B2' }]) },
          { placement: 'end', data: await makePdf([{ label: 'C1' }]) },
        ],
      }),
    );
    expect((await pageTexts(out)).map((t) => t.trim())).toEqual([
      'A1',
      'B1',
      'B2',
      'R1',
      'R2',
      'C1',
    ]);
  });

  it('сквозная нумерация по итоговому документу и skipFirst', async () => {
    const report = await makePdf([{ label: 'R1' }, { label: 'R2' }]);
    const title = await makePdf([{ label: 'T' }]);
    const out = await postprocessPdf(
      report,
      job({
        attachments: [{ placement: 'start', data: title }],
        pageNumbers: { ...numbers, skipFirst: true },
      }),
    );
    const texts = await pageTexts(out);
    expect(texts[0]).not.toContain('Стр.');
    expect(texts[1]).toContain('Стр. 2 из 3');
    expect(texts[2]).toContain('Стр. 3 из 3');
  });

  it('водяной знак с кириллицей на каждой странице, прозрачность ExtGState', async () => {
    const out = await postprocessPdf(
      await makePdf([{ label: 'R1' }, { label: 'R2', size: [842, 595] }]),
      job({ watermark: { text: 'ЧЕРНОВИК', opacity: 30, color: 'red', angle: 'diagonal' } }),
    );
    for (const t of await pageTexts(out)) expect(t).toContain('ЧЕРНОВИК');
    const doc = await PDFDocument.load(out);
    const gs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict);
    const alphas = gs
      .values()
      .map((v) => doc.context.lookup(v, PDFDict).get(PDFName.of('ca')))
      .filter((v): v is PDFNumber => v instanceof PDFNumber)
      .map((n) => n.asNumber());
    expect(alphas).toContain(0.3);
  });

  it('символы вне шрифта и пустой после очистки водяной знак', async () => {
    const a = await postprocessPdf(
      await makePdf([{ label: 'R1' }]),
      job({ watermark: { text: '😀 КОПИЯ', opacity: 20, color: 'gray', angle: 'horizontal' } }),
    );
    expect((await pageTexts(a))[0]).toContain('? КОПИЯ');
    const b = await postprocessPdf(
      await makePdf([{ label: 'R1' }]),
      job({ watermark: { text: '\n\t', opacity: 20, color: 'gray', angle: 'horizontal' } }),
    );
    expect((await pageTexts(b))[0]!.trim()).toBe('R1');
  });

  it('повёрнутые страницы и CropBox: текст на месте, без ошибок', async () => {
    const report = await makePdf([
      { label: 'P0' },
      { label: 'P90', rotate: 90 },
      { label: 'P180', rotate: 180 },
      { label: 'P270', rotate: 270 },
      { label: 'PC', crop: [50, 60, 400, 500] },
    ]);
    const out = await postprocessPdf(
      report,
      job({
        watermark: { text: 'КОПИЯ', opacity: 20, color: 'gray', angle: 'diagonal' },
        pageNumbers: { ...numbers, position: 'top-right' },
      }),
    );
    const texts = await pageTexts(out);
    texts.forEach((t, i) => {
      expect(t).toContain('КОПИЯ');
      expect(t).toContain(`Стр. ${i + 1} из 5`);
    });
  });

  it('PDF/A: пустые строки Info исходного PDF удаляются, остальное Info присутствует в XMP', async () => {
    const base = await PDFDocument.load(await makePdf([{ label: 'R1' }]), {
      updateMetadata: false,
    });
    const info = infoDict(base)!;
    for (const k of ['Title', 'Author', 'Subject', 'Keywords'])
      info.set(PDFName.of(k), PDFHexString.fromText(''));
    info.set(PDFName.of('Creator'), PDFHexString.fromText('Word'));
    const out = await postprocessPdf(
      await base.save(),
      job({
        pdfa: true,
        watermark: { text: 'КОПИЯ', opacity: 20, color: 'gray', angle: 'diagonal' },
        metadata: null,
      }),
    );
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    const keys = infoDict(doc)!
      .keys()
      .map((k) => k.decodeText());
    for (const k of ['Title', 'Author', 'Subject', 'Keywords']) expect(keys).not.toContain(k);
    const xmp = readXmp(doc)!;
    expect(doc.getCreator()).toBe('Word');
    expect(xmp).toContain('<xmp:CreatorTool>Word</xmp:CreatorTool>');
    // Каждому текстовому ключу Info соответствует значение в XMP (PDF/A-2, 6.6.2.3.1).
    const xmpOf: Record<string, string> = {
      Creator: '<xmp:CreatorTool>',
      Producer: '<pdf:Producer>',
    };
    for (const k of keys.filter((k) => !/Date$/.test(k))) expect(xmp).toContain(xmpOf[k]!);
  });

  it('метаданные: Info и XMP совпадают; PDF/A — pdfaid; ID и OutputIntents сохраняются', async () => {
    const base = await PDFDocument.load(await makePdf([{ label: 'R1' }]));
    base.context.trailerInfo.ID = base.context.obj([
      PDFHexString.of('00AA11BB'),
      PDFHexString.of('00AA11BB'),
    ]);
    base.catalog.set(
      PDFName.of('OutputIntents'),
      base.context.obj([base.context.obj({ S: 'GTS_PDFA1' })]),
    );
    const out = await postprocessPdf(
      await base.save(),
      job({
        pdfa: true,
        metadata: {
          title: 'Счёт № 42 <&>',
          author: 'Отдел продаж',
          subject: 'Оплата',
          keywords: 'счёт оплата',
        },
      }),
    );
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    expect(doc.getTitle()).toBe('Счёт № 42 <&>');
    expect(doc.getAuthor()).toBe('Отдел продаж');
    expect(doc.getSubject()).toBe('Оплата');
    expect(doc.getKeywords()).toBe('счёт оплата');
    expect(doc.getProducer()).toBe(PDF_PRODUCER);
    expect(doc.getCreationDate()?.toISOString()).toBe(NOW);
    expect(doc.getModificationDate()?.toISOString()).toBe(NOW);
    const xmp = readXmp(doc)!;
    expect(xmp).toContain('<rdf:li xml:lang="x-default">Счёт № 42 &lt;&amp;&gt;</rdf:li>');
    expect(xmp).toContain('<rdf:li>Отдел продаж</rdf:li>');
    expect(xmp).toContain('<pdf:Keywords>счёт оплата</pdf:Keywords>');
    expect(xmp).toContain(`<pdf:Producer>${PDF_PRODUCER}</pdf:Producer>`);
    expect(xmp).toContain('<xmp:CreateDate>2026-10-15T09:30:00Z</xmp:CreateDate>');
    expect(xmp).toContain('<pdfaid:part>2</pdfaid:part>');
    expect(xmp).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
    const meta = doc.context.lookup(doc.catalog.get(PDFName.of('Metadata')));
    expect((meta as unknown as { dict: PDFDict }).dict.get(PDFName.of('Filter'))).toBeUndefined();
    expect(doc.context.trailerInfo.ID).toBeDefined();
    expect(doc.catalog.lookup(PDFName.of('OutputIntents'), PDFArray).size()).toBe(1);
  });

  it('без PDF/A — XMP без pdfaid', async () => {
    const out = await postprocessPdf(
      await makePdf([{ label: 'R1' }]),
      job({ metadata: { title: 'Отчёт', author: '', subject: '', keywords: '' } }),
    );
    const xmp = readXmp(await PDFDocument.load(out))!;
    expect(xmp).toContain('Отчёт');
    expect(xmp).not.toContain('pdfaid');
  });
});

describe('геометрия видимой страницы', () => {
  const page = async (rotate: 0 | 90 | 180 | 270) =>
    (
      await PDFDocument.load(await makePdf([{ label: 'x', rotate, crop: [10, 20, 300, 400] }]))
    ).getPage(0);

  it('размер видимой области учитывает поворот', async () => {
    expect(visualView(await page(0))).toMatchObject({ rot: 0, w: 300, h: 400 });
    expect(visualView(await page(90))).toMatchObject({ rot: 90, w: 400, h: 300 });
    expect(visualView(await page(270))).toMatchObject({ rot: 270, w: 400, h: 300 });
  });

  it('левый нижний угол видимой страницы', async () => {
    expect(toPage(visualView(await page(0)), 0, 0)).toEqual({ x: 10, y: 20 });
    expect(toPage(visualView(await page(90)), 0, 0)).toEqual({ x: 310, y: 20 });
    expect(toPage(visualView(await page(180)), 0, 0)).toEqual({ x: 310, y: 420 });
    expect(toPage(visualView(await page(270)), 0, 0)).toEqual({ x: 10, y: 420 });
  });

  it('видимый правый нижний угол при повороте 90 — правый верхний угол страницы', async () => {
    const v = visualView(await page(90));
    expect(toPage(v, v.w, 0)).toEqual({ x: 310, y: 420 });
  });
});
