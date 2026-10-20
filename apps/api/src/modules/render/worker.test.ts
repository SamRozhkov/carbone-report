// Настоящий поток рендера (worker.ts через worker-dev.mjs) со встроенной сборкой Carbone:
// опции загрузки изображений доходят до Carbone, предупреждения возвращаются пулу (R6).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RenderPool, TemplateRenderError } from './pool';
import { renderWorkerUrl } from './worker-url';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const NS = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');
// PNG 1×1
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** DOCX: абзац «Отчёт» и картинка-заглушка с меткой {d.img} в описании */
async function template(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rIdImg" Type="${IMAGE}" Target="media/p.png"/></Relationships>`,
  );
  zip.file('word/media/p.png', PNG);
  const drawing =
    '<w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1" descr="{d.img}"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr>' +
    '<pic:cNvPr id="0" name="p.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing>';
  zip.file(
    'word/document.xml',
    `${XML}<w:document ${NS}><w:body><w:p><w:r><w:t>Отчёт</w:t></w:r></w:p><w:p><w:r>${drawing}</w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

let server: Server;
let host: string;
let pool: RenderPool;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/ok.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PNG);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const worker = renderWorkerUrl();
  pool = new RenderPool({ size: 1, workerUrl: worker.url, execArgv: worker.execArgv });
});

afterAll(async () => {
  await pool?.destroy();
  server?.closeAllConnections();
  server?.close();
});

const job = async (img: string, allowlist: string[]) => ({
  template: await template(),
  ext: 'docx',
  data: { img },
  options: {
    lang: 'ru',
    timezone: 'Europe/Moscow',
    imageUrlAllowlist: allowlist,
    imageUrlTimeoutMs: 2000,
  },
});

async function documentXml(out: Buffer): Promise<string> {
  return (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string');
}

describe('worker.ts: изображения по адресу', () => {
  it('адрес из белого списка — картинка заменена, предупреждений нет', async () => {
    const r = await pool.run(await job(`http://${host}/ok.png`, [host]), Date.now() + 30_000);
    expect(r.warnings).toEqual([]);
    const names = Object.keys((await JSZip.loadAsync(r.out)).files);
    expect(names).toContain('word/media/cr-img-1.png');
  }, 40_000);

  it('404 — заглушка удалена, предупреждение (адрес без query) пересылается пулу', async () => {
    const r = await pool.run(
      await job(`http://${host}/missing.png?token=s3cret`, [host]),
      Date.now() + 30_000,
    );
    expect(r.warnings).toEqual([
      `изображение не загружено: http://${host}/missing.png — код ответа 404 Метка: {d.img}`,
    ]);
    const doc = await documentXml(r.out);
    expect(doc).toContain('Отчёт');
    expect(doc).not.toContain('<w:drawing>');
  }, 40_000);

  it('хост вне белого списка — ошибка шаблона с Source', async () => {
    const run = pool.run(
      await job(`http://${host}/ok.png`, ['cdn.example.org']),
      Date.now() + 30_000,
    );
    await expect(run).rejects.toThrow(TemplateRenderError);
    await expect(run).rejects.toThrow(
      `хост «${host}» не входит в белый список IMAGE_URL_ALLOWLIST Source: "{d.img}"`,
    );
  }, 40_000);
});

describe('worker.ts: обработка PDF (§36.4)', () => {
  it('задача pdf: приложения из extra, водяной знак — в настоящем потоке', async () => {
    const { makePdf, pageTexts } = await import('../pdf/test-pdf');
    const r = await pool.run(
      {
        kind: 'pdf',
        template: Buffer.from(await makePdf([{ label: 'R1' }])),
        ext: 'pdf',
        data: {
          pdfa: false,
          watermark: { text: 'КОПИЯ', opacity: 20, color: 'gray', angle: 'diagonal' },
          pageNumbers: null,
          metadata: null,
          attachments: [{ placement: 'end' }],
          now: '2026-10-15T09:30:00.000Z',
        },
        options: { lang: '', timezone: '' },
        extra: [await makePdf([{ label: 'A1' }])],
      },
      Date.now() + 30_000,
    );
    const texts = await pageTexts(r.out);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('R1');
    expect(texts[1]).toContain('A1');
    for (const t of texts) expect(t).toContain('КОПИЯ');
  }, 40_000);

  it('задача pdf с битым файлом — TemplateRenderError, поток жив', async () => {
    const run = pool.run(
      {
        kind: 'pdf',
        template: Buffer.from('%PDF-1.7 мусор'),
        ext: 'pdf',
        data: {
          pdfa: false,
          watermark: null,
          pageNumbers: null,
          metadata: null,
          attachments: [],
          now: '2026-10-15T09:30:00.000Z',
        },
        options: { lang: '', timezone: '' },
      },
      Date.now() + 30_000,
    );
    await expect(run).rejects.toThrow(TemplateRenderError);
  }, 40_000);

  it('задача sign: на выходе есть поле подписи (§39.4)', async () => {
    const { makePdf } = await import('../pdf/test-pdf');
    const r = await pool.run(
      {
        kind: 'sign',
        template: Buffer.from(await makePdf([{ label: 'R1' }])),
        ext: 'pdf',
        data: {
          position: 'bottom-right',
          lines: ['a', 'b', 'c', 'd', 'e'],
          contentsBytes: 1000,
          signedAt: '2026-10-19T11:32:00.000Z',
        },
        options: { lang: '', timezone: '' },
      },
      Date.now() + 30_000,
    );
    expect(r.out.toString('latin1')).toContain('/FT /Sig');
  }, 40_000);
});
