import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { postprocessPdf } from '../postprocess';
import { makePdf } from '../test-pdf';
import { fillByteRange } from './embed';
import { prepareSignaturePdf, STAMP, stampText, type SignPrepareJob } from './prepare';

const lines: SignPrepareJob['lines'] = [
  'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
  'Сертификат: 1001',
  'Владелец: Иванов Иван Иванович',
  'Действителен: с 01.01.2026 по 01.01.2126',
  'Подписан: 19.10.2026 14:32',
];
const job = (over: Partial<SignPrepareJob> = {}): SignPrepareJob => ({
  position: 'bottom-right',
  lines,
  contentsBytes: 4000,
  signedAt: '2026-10-19T11:32:00.000Z',
  ...over,
});

async function widgetOf(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPages().at(-1)!;
  const annots = page.node.Annots()!;
  const dicts = annots.asArray().map((r) => doc.context.lookup(r, PDFDict));
  const widget = dicts.find((d) => d.get(PDFName.of('FT')) === PDFName.of('Sig'))!;
  const rect = widget
    .lookup(PDFName.of('Rect'), PDFArray)
    .asArray()
    .map((n) => (n as PDFNumber).asNumber());
  return { doc, page, dicts, widget, rect };
}

describe('prepareSignaturePdf (§39.4, §39.5)', () => {
  it('поле подписи на последней странице, AcroForm SigFlags 3, виджет печатается', async () => {
    const out = await prepareSignaturePdf(await makePdf([{ label: 'a' }, { label: 'b' }]), job());
    const { doc, widget } = await widgetOf(out);
    expect(doc.getPages()[0]!.node.Annots()?.size() ?? 0).toBe(0);
    expect(widget.lookup(PDFName.of('F'), PDFNumber).asNumber()).toBe(4);
    const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acro.lookup(PDFName.of('SigFlags'), PDFNumber).asNumber()).toBe(3);
    const v = widget.lookup(PDFName.of('V'), PDFDict);
    expect(v.get(PDFName.of('Filter'))).toBe(PDFName.of('Adobe.PPKLite'));
    expect(v.get(PDFName.of('SubFilter'))).toBe(PDFName.of('ETSI.CAdES.detached'));
    expect(v.lookup(PDFName.of('M'), PDFString).decodeDate().toISOString()).toBe(
      '2026-10-19T11:32:00.000Z',
    );
  });

  it('заглушки находятся, /Contents нужного размера', async () => {
    const out = Buffer.from(
      await prepareSignaturePdf(await makePdf([{ label: 'a' }]), job({ contentsBytes: 5000 })),
    );
    const hole = fillByteRange(out, 5000);
    expect(hole.end - hole.start).toBe(5000 * 2 + 2);
  });

  it.each([
    ['bottom-left', (c: number[]) => [c[0]! + 24, c[1]! + 24]],
    ['bottom-center', (c: number[]) => [c[0]! + (c[2]! - 250) / 2, c[1]! + 24]],
    ['bottom-right', (c: number[]) => [c[0]! + c[2]! - 24 - 250, c[1]! + 24]],
  ] as const)('положение %s — от видимой области (CropBox)', async (position, corner) => {
    const crop = [10, 20, 500, 700];
    const src = await makePdf([{ label: 'a', crop: crop as [number, number, number, number] }]);
    const { rect } = await widgetOf(await prepareSignaturePdf(src, job({ position })));
    const [x, y] = corner(crop);
    expect(rect[0]).toBeCloseTo(x!, 3);
    expect(rect[1]).toBeCloseTo(y!, 3);
    expect(rect[2]! - rect[0]!).toBeCloseTo(STAMP.width, 3);
    expect(rect[3]! - rect[1]!).toBeCloseTo(STAMP.height, 3);
  });

  it('страница /Rotate 90: штамп в правом нижнем углу видимой страницы, внешний вид повёрнут', async () => {
    const src = await makePdf([{ label: 'a', rotate: 90 }]);
    const { rect, widget, doc } = await widgetOf(await prepareSignaturePdf(src, job()));
    // 595 × 842, поворот 90: видимая страница 842 × 595; низ видимой — правый край страницы.
    expect(rect).toEqual([491, 568, 571, 818].map((n) => expect.closeTo(n, 3)));
    const ap = widget.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')) as PDFRef;
    const stream = doc.context.lookup(ap) as PDFRawStream;
    const m = stream.dict
      .lookup(PDFName.of('Matrix'), PDFArray)
      .asArray()
      .map((n) => (n as PDFNumber).asNumber());
    expect(m).toEqual([0, 1, -1, 0, 0, 0]);
  });

  it('прежние аннотации последней страницы сохраняются', async () => {
    const doc = await PDFDocument.load(await makePdf([{ label: 'a' }]));
    const link = doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], Border: [0, 0, 0] }),
    );
    doc.getPages()[0]!.node.addAnnot(link);
    const { dicts } = await widgetOf(await prepareSignaturePdf(await doc.save(), job()));
    expect(dicts.map((d) => d.get(PDFName.of('Subtype')))).toEqual([
      PDFName.of('Link'),
      PDFName.of('Widget'),
    ]);
  });

  it('Info и XMP не меняются (PDF/A, §39.4)', async () => {
    const base = await postprocessPdf(await makePdf([{ label: 'a' }]), {
      pdfa: true,
      watermark: null,
      pageNumbers: null,
      metadata: { title: 'Отчёт', author: 'А', subject: '', keywords: '' },
      attachments: [],
      now: '2026-10-01T10:00:00.000Z',
    });
    const before = await PDFDocument.load(base, { updateMetadata: false });
    const after = await PDFDocument.load(await prepareSignaturePdf(base, job()), {
      updateMetadata: false,
    });
    expect(after.getTitle()).toBe(before.getTitle());
    expect(after.getModificationDate()).toEqual(before.getModificationDate());
    const xmp = (d: PDFDocument) =>
      Buffer.from(
        (d.context.lookup(d.catalog.get(PDFName.of('Metadata'))) as PDFRawStream).contents,
      ).toString('utf8');
    expect(xmp(after)).toBe(xmp(before));
  });

  it('stampText: управляющие символы и символы вне шрифта, обрезка длинной строки', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit((await import('@pdf-lib/fontkit')).default);
    const font = await doc.embedFont((await import('../font')).pdfFontBytes(), { subset: true });
    expect(stampText('Владелец:\u0001Иванов 😀', font, 7)).toBe('Владелец: Иванов ?');
    const long = stampText(`Владелец: ${'Константинопольский '.repeat(10)}`, font, 7);
    expect(long.endsWith('…')).toBe(true);
    expect(font.widthOfTextAtSize(long, 7)).toBeLessThanOrEqual(STAMP.width - 12);
  });
});
