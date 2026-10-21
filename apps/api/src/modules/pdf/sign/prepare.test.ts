import {
  decodePDFRawStream,
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
import { makePdf, pageTexts } from '../test-pdf';
import { fillByteRange } from './embed';
import {
  prepareSignaturePdf,
  prepareStampPdf,
  STAMP,
  stampText,
  type SignPrepareJob,
} from './prepare';

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

const nums = (a: PDFArray) => a.asArray().map((n) => (n as PDFNumber).asNumber());

/** Штамп из последнего потока содержимого последней страницы: `q <cm> /StN Do Q`. */
async function stampOf(pdf: Uint8Array) {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = doc.getPages().at(-1)!;
  const contents = page.node.Contents() as PDFArray;
  const last = doc.context.lookup(contents.get(contents.size() - 1)) as PDFRawStream;
  const ops = Buffer.from(decodePDFRawStream(last).decode()).toString('latin1');
  const m = /^\s*q\s+((?:-?[\d.]+\s+){6})cm\s+\/(\S+)\s+Do\s+Q\s*$/.exec(ops);
  expect(m, ops).not.toBeNull();
  const cm = m![1]!.trim().split(/\s+/).map(Number);
  const xobj = page.node
    .Resources()!
    .lookup(PDFName.of('XObject'), PDFDict)
    .lookup(PDFName.of(m![2]!)) as PDFRawStream;
  const matrix = nums(xobj.dict.lookup(PDFName.of('Matrix'), PDFArray));
  const [x0, y0, x1, y1] = nums(xobj.dict.lookup(PDFName.of('BBox'), PDFArray)) as [
    number,
    number,
    number,
    number,
  ];
  // Точка формы → Matrix формы → cm страницы.
  const at = ([a, b, c, d, e, f]: number[], x: number, y: number) => [
    a! * x + c! * y + e!,
    b! * x + d! * y + f!,
  ];
  const pts = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => {
    const [u, v] = at(matrix, x!, y!);
    return at(cm, u!, v!);
  });
  const xs = pts.map((p) => p[0]!);
  const ys = pts.map((p) => p[1]!);
  const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return { doc, page, rect, matrix, name: m![2]! };
}

/** PDF/A-подобный документ: OutputIntent с профилем, Info и XMP. */
async function pdfaBase(): Promise<Uint8Array> {
  const base = await postprocessPdf(await makePdf([{ label: 'a' }, { label: 'b' }]), {
    pdfa: true,
    watermark: null,
    pageNumbers: null,
    metadata: { title: 'Отчёт', author: 'А', subject: '', keywords: '' },
    attachments: [],
    now: '2026-10-01T10:00:00.000Z',
  });
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  const profile = doc.context.register(doc.context.stream(new Uint8Array([1, 2, 3]), { N: 3 }));
  const intent = doc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB'),
    DestOutputProfile: profile,
  });
  doc.catalog.set(PDFName.of('OutputIntents'), doc.context.obj([intent]));
  return doc.save({ useObjectStreams: false });
}

describe('prepareStampPdf: штамп без поля подписи (§42)', () => {
  const sjob = (position: SignPrepareJob['position'] = 'bottom-right') => ({ position, lines });

  it.each([
    ['bottom-left', (c: number[]) => [c[0]! + 24, c[1]! + 24]],
    ['bottom-center', (c: number[]) => [c[0]! + (c[2]! - 250) / 2, c[1]! + 24]],
    ['bottom-right', (c: number[]) => [c[0]! + c[2]! - 24 - 250, c[1]! + 24]],
  ] as const)('положение %s — от видимой области (CropBox)', async (position, corner) => {
    const crop = [10, 20, 500, 700];
    const src = await makePdf([{ label: 'a', crop: crop as [number, number, number, number] }]);
    const { rect } = await stampOf(await prepareStampPdf(src, sjob(position)));
    const [x, y] = corner(crop);
    expect(rect[0]).toBeCloseTo(x!, 3);
    expect(rect[1]).toBeCloseTo(y!, 3);
    expect(rect[2]! - rect[0]!).toBeCloseTo(STAMP.width, 3);
    expect(rect[3]! - rect[1]!).toBeCloseTo(STAMP.height, 3);
  });

  it('страница /Rotate 90: штамп в правом нижнем углу видимой страницы, повёрнут', async () => {
    const src = await makePdf([{ label: 'a', rotate: 90 }]);
    const { rect, matrix } = await stampOf(await prepareStampPdf(src, sjob()));
    expect(rect).toEqual([491, 568, 571, 818].map((n) => expect.closeTo(n, 3)));
    expect(matrix).toEqual([0, 1, -1, 0, 0, 0]);
  });

  it('штамп только на последней странице, текст страницы и штампа читается', async () => {
    const out = await prepareStampPdf(await makePdf([{ label: 'R1' }, { label: 'R2' }]), sjob());
    const texts = await pageTexts(out);
    expect(texts[0]).toContain('R1');
    expect(texts[0]).not.toContain('Владелец');
    expect(texts[1]).toContain('R2');
    expect(texts[1]).toContain('Владелец: Иванов Иван Иванович');
  });

  it('нет /AcroForm, /Sig и аннотаций', async () => {
    const out = await prepareStampPdf(await makePdf([{ label: 'a' }]), sjob());
    const { doc, page } = await stampOf(out);
    expect(doc.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    expect(page.node.Annots()?.size() ?? 0).toBe(0);
    expect(Buffer.from(out).toString('latin1')).not.toMatch(/\/(Sig|AcroForm)\b/);
  });

  it('имя XObject не занимает существующее', async () => {
    const once = await prepareStampPdf(await makePdf([{ label: 'a' }]), sjob());
    const twice = await prepareStampPdf(once, sjob());
    const a = await stampOf(once);
    const b = await stampOf(twice);
    expect(b.name).not.toBe(a.name);
    const xo = b.page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    expect(xo.keys().map(String)).toEqual(expect.arrayContaining([`/${a.name}`, `/${b.name}`]));
  });

  it('Info, XMP и OutputIntent PDF/A не меняются', async () => {
    const base = await pdfaBase();
    const before = await PDFDocument.load(base, { updateMetadata: false });
    const after = await PDFDocument.load(await prepareStampPdf(base, sjob()), {
      updateMetadata: false,
    });
    expect(after.getTitle()).toBe(before.getTitle());
    expect(after.getProducer()).toBe(before.getProducer());
    expect(after.getModificationDate()).toEqual(before.getModificationDate());
    const xmp = (d: PDFDocument) =>
      Buffer.from(
        (d.context.lookup(d.catalog.get(PDFName.of('Metadata'))) as PDFRawStream).contents,
      ).toString('utf8');
    expect(xmp(after)).toBe(xmp(before));
    const intent = (d: PDFDocument) => {
      const i = d.catalog.lookup(PDFName.of('OutputIntents'), PDFArray).lookup(0, PDFDict);
      const profile = i.lookup(PDFName.of('DestOutputProfile')) as PDFRawStream;
      return { s: String(i.get(PDFName.of('S'))), profile: Buffer.from(profile.contents) };
    };
    expect(intent(after)).toEqual(intent(before));
  });

  it('детерминирован: одинаковые входы — одинаковые байты', async () => {
    const base = await pdfaBase();
    const a = await prepareStampPdf(base, sjob());
    const b = await prepareStampPdf(base, sjob());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const c = await prepareStampPdf(base, sjob('bottom-left'));
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });
});
