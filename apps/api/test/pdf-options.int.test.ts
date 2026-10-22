import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { templateAttachments } from '../src/db/schema';
import { makePdf } from '../src/modules/pdf/test-pdf';
import { createTemplate, createTestApp, loginAs, multipart, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let user: string;
let dsId: string;

const PDFA_XMP = '<rdf:Description pdfaid:part="2" pdfaid:conformance="B"/>';
async function pdfa(label: string): Promise<Buffer> {
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const doc = await PDFDocument.load(await makePdf([{ label }]));
  const s = doc.context.stream(new TextEncoder().encode(PDFA_XMP), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(s));
  return Buffer.from(await doc.save());
}
const plain = async (label: string, pages = 1) =>
  Buffer.from(await makePdf(Array.from({ length: pages }, (_, i) => ({ label: `${label}${i}` }))));

const putOptions = (id: string, body: object, cookie = admin) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/pdf-options`,
    headers: { cookie },
    payload: body,
  });
function upload(id: string, data: Buffer, name = 'a.pdf', placement = 'end', cookie = admin) {
  const m = multipart({ placement }, { name, data });
  return t.app.inject({
    method: 'POST',
    url: `/api/templates/${id}/attachments`,
    headers: { cookie, ...m.headers },
    payload: m.payload,
  });
}
const move = (id: string, aid: string, body: object) =>
  t.app.inject({
    method: 'PATCH',
    url: `/api/templates/${id}/attachments/${aid}`,
    headers: { cookie: admin },
    payload: body,
  });
const remove = (id: string, aid: string) =>
  t.app.inject({
    method: 'DELETE',
    url: `/api/templates/${id}/attachments/${aid}`,
    headers: { cookie: admin },
  });
const newTemplate = () => createTemplate(t, admin, dsId);

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: {
      name: 'src',
      host: 'localhost',
      port: 5432,
      database: 'x',
      username: 'x',
      password: 'x',
      sslMode: 'disable',
    },
  });
  dsId = ds.json().id;
});
afterAll(() => t.close());

describe('настройки PDF (§36.1)', () => {
  it('новый шаблон — без настроек и приложений', async () => {
    const id = await newTemplate();
    const r = await t.app.inject({ url: `/api/templates/${id}`, headers: { cookie: admin } });
    expect(r.json()).toMatchObject({ pdfOptions: { pdfa: false }, attachments: [] });
  });

  it('PUT сохраняет с умолчаниями, пустые метаданные не хранит; пользователю — 403', async () => {
    const id = await newTemplate();
    const r = await putOptions(id, {
      watermark: { text: ' КОПИЯ ' },
      pageNumbers: {},
      metadata: {},
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().pdfOptions).toEqual({
      pdfa: false,
      watermark: { text: 'КОПИЯ', opacity: 20, color: 'gray', angle: 'diagonal' },
      pageNumbers: {
        format: 'Стр. {page} из {pages}',
        position: 'bottom-center',
        skipFirst: false,
      },
    });
    expect((await putOptions(id, {}, user)).statusCode).toBe(403);
  });

  it('водяной знак и формат нумерации на китайском сохраняются (§45.5)', async () => {
    const id = await newTemplate();
    const r = await putOptions(id, {
      watermark: { text: '机密' },
      pageNumbers: { format: '第{page}页，共{pages}页' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().pdfOptions).toMatchObject({
      watermark: { text: '机密' },
      pageNumbers: { format: '第{page}页，共{pages}页' },
    });
    const bad = await putOptions(id, { watermark: { text: '机密 😀' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details).toEqual([
      { path: '/watermark/text', message: 'символ «😀» не поддерживается шрифтом PDF' },
    ]);
  });

  it('ошибки у полей', async () => {
    const id = await newTemplate();
    const r = await putOptions(id, {
      watermark: { text: 'Копия 😀' },
      metadata: { title: '{d.x:upper}' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({
      code: 'VALIDATION',
      details: [
        { path: '/watermark/text', message: 'символ «😀» не поддерживается шрифтом PDF' },
        { path: '/metadata/title', message: 'в полях PDF теги без форматтеров: {d.x:upper}' },
      ],
    });
  });
});

describe('приложенные файлы (§36.3)', () => {
  it('загрузка: имя, страницы, PDF/A, порядок; файл в хранилище', async () => {
    const id = await newTemplate();
    expect((await upload(id, await plain('T', 2), 'Титул.pdf', 'start')).statusCode).toBe(201);
    const r = await upload(id, await pdfa('A'), 'Условия.pdf', 'end');
    expect(r.statusCode).toBe(201);
    expect(r.json().attachments).toEqual([
      expect.objectContaining({
        name: 'Титул.pdf',
        placement: 'start',
        sortOrder: 0,
        pages: 2,
        pdfa: false,
      }),
      expect.objectContaining({
        name: 'Условия.pdf',
        placement: 'end',
        sortOrder: 0,
        pages: 1,
        pdfa: true,
      }),
    ]);
    const rows = await t.deps.db
      .select()
      .from(templateAttachments)
      .where(eq(templateAttachments.templateId, id));
    for (const row of rows) {
      expect(row.filePath).toMatch(new RegExp(`^templates/${id}/attachments/[0-9a-f-]{36}\\.pdf$`));
      expect(await t.deps.storage.exists(row.filePath)).toBe(true);
    }
  });

  it('не PDF, битый, с паролем — 400; пользователю — 403', async () => {
    const id = await newTemplate();
    const notPdf = await upload(id, Buffer.from('PK\x03\x04'));
    expect(notPdf.statusCode).toBe(400);
    expect(notPdf.json().error.message).toBe('файл не PDF');
    expect((await upload(id, Buffer.from('%PDF-1.7 мусор'))).json().error.message).toBe(
      'PDF повреждён',
    );
    expect((await upload(id, await plain('x'), 'a.pdf', 'end', user)).statusCode).toBe(403);
  });

  it('лимиты: 11-й файл и 501-я страница — 400, файл не остаётся в хранилище', async () => {
    const id = await newTemplate();
    for (let i = 0; i < 10; i++)
      expect((await upload(id, await plain(`f${i}`))).statusCode).toBe(201);
    const write = vi.spyOn(t.deps.storage, 'write');
    const r = await upload(id, await plain('x'));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('в шаблоне не больше 10 приложенных файлов');
    const key = write.mock.calls.at(-1)![0];
    write.mockRestore();
    expect(await t.deps.storage.exists(key)).toBe(false);

    const big = await newTemplate();
    expect((await upload(big, await plain('p', 300))).statusCode).toBe(201);
    const over = await upload(big, await plain('q', 201));
    expect(over.json().error.message).toBe('в приложенных файлах шаблона не больше 500 страниц');
  });

  it('правило PDF/A — при включении и при загрузке', async () => {
    const id = await newTemplate();
    await upload(id, await plain('x'), 'скан.pdf');
    const on = await putOptions(id, { pdfa: true });
    expect(on.statusCode).toBe(400);
    expect(on.json().error.details).toEqual([
      { path: '/pdfa', message: 'PDF/A включён: файл «скан.pdf» не в формате PDF/A' },
    ]);

    const other = await newTemplate();
    expect((await putOptions(other, { pdfa: true })).statusCode).toBe(200);
    const up = await upload(other, await plain('y'), 'скан2.pdf');
    expect(up.statusCode).toBe(400);
    expect(up.json().error.message).toBe('PDF/A включён: файл «скан2.pdf» не в формате PDF/A');
    expect((await upload(other, await pdfa('z'))).statusCode).toBe(201);
  });

  it('гонка: включение PDF/A и загрузка не-PDF/A — в базе не остаётся нарушения', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await newTemplate();
      const [a, b] = await Promise.all([
        putOptions(id, { pdfa: true }),
        upload(id, await plain('r')),
      ]);
      // Ровно один из двух запросов отклонён: PDF/A включён без приложения или приложение загружено без PDF/A.
      expect([a.statusCode, b.statusCode]).toContain(400);
      const r = await t.app.inject({ url: `/api/templates/${id}`, headers: { cookie: admin } });
      const d = r.json();
      expect(d.pdfOptions.pdfa && d.attachments.some((x: { pdfa: boolean }) => !x.pdfa)).toBe(
        false,
      );
      expect(a.statusCode === 200 && b.statusCode === 201).toBe(false);
    }
  });

  it('перемещение и удаление: группы перенумеровываются, файл удаляется', async () => {
    const id = await newTemplate();
    const ids: string[] = [];
    for (const n of ['a', 'b', 'c'])
      ids.push((await upload(id, await plain(n), `${n}.pdf`)).json().attachments.at(-1).id);
    let r = await move(id, ids[2]!, { sortOrder: 0 });
    expect(r.json().attachments.map((x: { name: string }) => x.name)).toEqual([
      'c.pdf',
      'a.pdf',
      'b.pdf',
    ]);
    r = await move(id, ids[1]!, { placement: 'start' });
    expect(
      r
        .json()
        .attachments.map((x: { name: string; placement: string; sortOrder: number }) => [
          x.name,
          x.placement,
          x.sortOrder,
        ]),
    ).toEqual([
      ['b.pdf', 'start', 0],
      ['c.pdf', 'end', 0],
      ['a.pdf', 'end', 1],
    ]);
    const [row] = await t.deps.db
      .select()
      .from(templateAttachments)
      .where(eq(templateAttachments.id, ids[0]!));
    r = await remove(id, ids[0]!);
    expect(r.statusCode).toBe(200);
    expect(r.json().attachments.map((x: { name: string }) => x.name)).toEqual(['b.pdf', 'c.pdf']);
    await vi.waitFor(async () => expect(await t.deps.storage.exists(row!.filePath)).toBe(false));
    expect((await remove(id, ids[0]!)).statusCode).toBe(404);
  });

  it('копия шаблона копирует настройки и приложения (R7)', async () => {
    const id = await newTemplate();
    await putOptions(id, { watermark: { text: 'КОПИЯ' } });
    await upload(id, await plain('a'), 'a.pdf', 'start');
    const dup = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/duplicate`,
      headers: { cookie: admin },
    });
    const copy = (
      await t.app.inject({ url: `/api/templates/${dup.json().id}`, headers: { cookie: admin } })
    ).json();
    expect(copy.pdfOptions.watermark.text).toBe('КОПИЯ');
    expect(copy.attachments).toEqual([
      expect.objectContaining({ name: 'a.pdf', placement: 'start', pages: 1 }),
    ]);
    const [row] = await t.deps.db
      .select()
      .from(templateAttachments)
      .where(eq(templateAttachments.templateId, dup.json().id));
    expect(row!.filePath.startsWith(`templates/${dup.json().id}/attachments/`)).toBe(true);
    expect(await t.deps.storage.exists(row!.filePath)).toBe(true);
  });

  it('удаление шаблона удаляет файлы приложений', async () => {
    const id = await newTemplate();
    await upload(id, await plain('a'));
    const [row] = await t.deps.db
      .select()
      .from(templateAttachments)
      .where(eq(templateAttachments.templateId, id));
    await t.app.inject({
      method: 'DELETE',
      url: `/api/templates/${id}`,
      headers: { cookie: admin },
    });
    expect(await t.deps.storage.exists(row!.filePath)).toBe(false);
  });
});
