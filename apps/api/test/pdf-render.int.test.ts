import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CarboneRenderer, PdfPostprocessor, PdfProtector, RenderOptions } from '../src/deps';
import { AppError } from '../src/lib/errors';
import { inProcessPdfPostprocessor } from '../src/modules/pdf/postprocessor';
import { makePdf, pageTexts } from '../src/modules/pdf/test-pdf';
import { createTemplate, createTestApp, loginAs, multipart, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let dsId: string;
const seen: RenderOptions[] = [];
// Поддельный Carbone: PDF с одной подписанной страницей; прочие форматы — текст.
const carbone: CarboneRenderer = {
  async render(_tpl, _data, ro) {
    seen.push(ro);
    return ro.convertTo === 'pdf'
      ? Buffer.from(await makePdf([{ label: 'REPORT' }]))
      : Buffer.from('DOCX');
  },
};
const pdf = vi.fn<PdfPostprocessor>(inProcessPdfPostprocessor);
// Поддельное шифрование: дописывает метку, чтобы было видно, что файл прошёл через него.
const protect = vi.fn<PdfProtector>(async (b) => Buffer.concat([b, Buffer.from('\n%ENC')]));
const STATUS = {
  name: 'status',
  label: 'Статус',
  type: 'string',
  required: false,
  defaultValue: null,
  options: null,
};

const preview = (id: string, status = 'ЧЕРНОВИК') =>
  t.app.inject({
    method: 'POST',
    url: `/api/templates/${id}/preview`,
    headers: { cookie: admin },
    payload: { params: { status }, mode: 'pdf' },
  });
const putOptions = (id: string, body: object) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/pdf-options`,
    headers: { cookie: admin },
    payload: body,
  });
async function upload(id: string, label: string, placement: string) {
  const m = multipart(
    { placement },
    { name: `${label}.pdf`, data: Buffer.from(await makePdf([{ label }])) },
  );
  const r = await t.app.inject({
    method: 'POST',
    url: `/api/templates/${id}/attachments`,
    headers: { cookie: admin, ...m.headers },
    payload: m.payload,
  });
  expect(r.statusCode).toBe(201);
  return r.json();
}
const newTemplate = () => createTemplate(t, admin, dsId, { params: [STATUS as never] });

beforeAll(async () => {
  t = await createTestApp({ carbone, pdf, pdfProtect: protect });
  admin = (await loginAs(t, 'admin')).cookie;
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

describe('итоговый PDF (§36.4)', () => {
  it('без настроек и только PDF/A — без обработки, байт-в-байт от конвертера', async () => {
    const id = await newTemplate();
    pdf.mockClear();
    const a = await preview(id);
    expect(a.statusCode).toBe(200);
    expect(seen.at(-1)!.pdfa).toBeUndefined();
    await putOptions(id, { pdfa: true });
    const b = await preview(id);
    expect(seen.at(-1)!.pdfa).toBe(true);
    expect(pdf).not.toHaveBeenCalled();
    expect((await pageTexts(b.rawPayload)).map((s) => s.trim())).toEqual(['REPORT']);
  });

  it('водяной знак из параметра, нумерация, приложения, метаданные — в предпросмотре', async () => {
    const id = await newTemplate();
    await putOptions(id, {
      watermark: { text: 'Статус: {d.params.status}' },
      pageNumbers: { skipFirst: true },
      metadata: { author: 'Отдел' },
    });
    await upload(id, 'TITLE', 'start');
    await upload(id, 'TERMS', 'end');
    const r = await preview(id);
    expect(r.statusCode).toBe(200);
    const texts = await pageTexts(r.rawPayload);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('TITLE');
    expect(texts[0]).not.toContain('Стр.');
    expect(texts[1]).toContain('REPORT');
    expect(texts[1]).toContain('Стр. 2 из 3');
    expect(texts[2]).toContain('TERMS');
    for (const s of texts) expect(s).toContain('Статус: ЧЕРНОВИК');
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(r.rawPayload, { updateMetadata: false });
    expect(doc.getAuthor()).toBe('Отдел');
    const name = (
      await t.app.inject({ url: `/api/templates/${id}`, headers: { cookie: admin } })
    ).json().name;
    expect(doc.getTitle()).toBe(name);
  });

  it('пустой статус — водяного знака нет', async () => {
    const id = await newTemplate();
    await putOptions(id, { watermark: { text: '{d.params.status}' } });
    const texts = await pageTexts((await preview(id, '')).rawPayload);
    expect(texts[0]!.trim()).toBe('REPORT');
  });

  it('запуск: out.pdf обработан, настройки в снимке; изменение настроек не меняет PDF запуска (R8)', async () => {
    const id = await newTemplate();
    await putOptions(id, { watermark: { text: 'КОПИЯ' } });
    const run = await t.app.inject({
      method: 'POST',
      url: `/api/reports/${id}/render`,
      headers: { cookie: admin },
      payload: { params: { status: 'x' } },
    });
    expect(run.statusCode).toBe(201);
    const runId = run.json().runId as string;
    const file = () =>
      t.app.inject({ url: `/api/runs/${runId}/file?format=pdf`, headers: { cookie: admin } });
    const first = await file();
    expect((await pageTexts(first.rawPayload))[0]).toContain('КОПИЯ');
    expect(await t.deps.storage.exists(`reports/${runId}/pdf-options.json`)).toBe(true);
    const saved = JSON.parse(
      (await t.deps.storage.read(`reports/${runId}/pdf-options.json`)).toString(),
    );
    expect(saved.options.watermark.text).toBe('КОПИЯ');
    await putOptions(id, {});
    expect(Buffer.compare((await file()).rawPayload, first.rawPayload)).toBe(0);
  });

  it('файл приложения пропал из хранилища — 502 с именем', async () => {
    const id = await newTemplate();
    const d = await upload(id, 'GONE', 'end');
    const { templateAttachments } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const [row] = await t.deps.db
      .select()
      .from(templateAttachments)
      .where(eq(templateAttachments.id, d.attachments[0].id));
    await t.deps.storage.remove(row!.filePath);
    const r = await preview(id);
    expect(r.statusCode).toBe(502);
    expect(r.json().error.message).toBe('приложенный файл «GONE.pdf» недоступен');
  });

  it('другие форматы — без настроек PDF', async () => {
    const id = await newTemplate();
    await putOptions(id, { pdfa: true, watermark: { text: 'КОПИЯ' } });
    const run = await t.app.inject({
      method: 'POST',
      url: `/api/reports/${id}/render`,
      headers: { cookie: admin },
      payload: { params: {} },
    });
    pdf.mockClear();
    const docx = await t.app.inject({
      url: `/api/runs/${run.json().runId}/file?format=docx`,
      headers: { cookie: admin },
    });
    expect(docx.rawPayload.toString()).toBe('DOCX');
    expect(seen.at(-1)).toMatchObject({ convertTo: 'docx' });
    expect(seen.at(-1)!.pdfa).toBeUndefined();
    expect(pdf).not.toHaveBeenCalled();
  });
});

describe('пароль и запреты (§37.2)', () => {
  const render = (id: string) =>
    t.app.inject({
      method: 'POST',
      url: `/api/reports/${id}/render`,
      headers: { cookie: admin },
      payload: { params: { status: 'x' } },
    });

  it('запуск: out.pdf зашифрован, в снимке — passwordSet без пароля; предпросмотр — без защиты', async () => {
    const id = await newTemplate();
    await putOptions(id, { protection: { noCopy: true }, password: 'секрет1' });
    protect.mockClear();
    const run = await render(id);
    expect(run.statusCode).toBe(201);
    expect(protect).toHaveBeenCalledTimes(1);
    expect(protect.mock.calls[0]![1]).toEqual({
      userPassword: 'секрет1',
      noPrint: false,
      noCopy: true,
      noModify: false,
    });
    const runId = run.json().runId as string;
    const file = await t.app.inject({
      url: `/api/runs/${runId}/file?format=pdf`,
      headers: { cookie: admin },
    });
    expect(file.rawPayload.toString('latin1').endsWith('%ENC')).toBe(true);
    const saved = (await t.deps.storage.read(`reports/${runId}/pdf-options.json`)).toString();
    expect(JSON.parse(saved)).toMatchObject({
      passwordSet: true,
      options: { protection: { noCopy: true } },
    });
    expect(saved).not.toContain('секрет1');
    protect.mockClear();
    expect((await preview(id)).statusCode).toBe(200);
    expect(protect).not.toHaveBeenCalled();
  });

  it('смена пароля не меняет PDF прошлого запуска; скачивание не шифрует повторно', async () => {
    const id = await newTemplate();
    await putOptions(id, { password: 'первый1' });
    const runId = (await render(id)).json().runId as string;
    const file = () =>
      t.app.inject({ url: `/api/runs/${runId}/file?format=pdf`, headers: { cookie: admin } });
    const first = (await file()).rawPayload;
    await putOptions(id, { password: 'второй2' });
    protect.mockClear();
    expect(Buffer.compare((await file()).rawPayload, first)).toBe(0);
    expect(protect).not.toHaveBeenCalled();
  });

  it('шифрование недоступно — 503, запуск с ошибкой, out.pdf не записан', async () => {
    const id = await newTemplate();
    await putOptions(id, { protection: { noPrint: true } });
    protect.mockRejectedValueOnce(
      new AppError('PDF_PROTECT_UNAVAILABLE', 503, 'шифрование PDF недоступно: не установлен qpdf'),
    );
    const r = await render(id);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toBe('шифрование PDF недоступно: не установлен qpdf');
    const { reportRuns } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    const runs = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.templateId, id));
    expect(runs.map((x) => x.status)).toEqual(['error']);
    expect(await t.deps.storage.exists(`reports/${runs[0]!.id}/out.pdf`)).toBe(false);
  });

  it('другие форматы запуска с защитой — без шифрования', async () => {
    const id = await newTemplate();
    await putOptions(id, { password: 'секрет1' });
    const runId = (await render(id)).json().runId as string;
    protect.mockClear();
    const docx = await t.app.inject({
      url: `/api/runs/${runId}/file?format=docx`,
      headers: { cookie: admin },
    });
    expect(docx.rawPayload.toString()).toBe('DOCX');
    expect(protect).not.toHaveBeenCalled();
  });
});
