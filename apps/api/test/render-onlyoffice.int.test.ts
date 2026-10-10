import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import JSZip from 'jszip';
import { GenericContainer, TestContainers, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFastify, type App } from '../src/app';
import type { CarboneRenderer, TemplateFileRef } from '../src/deps';
import { registerErrorHandler } from '../src/lib/errors';
import { createRenderHandoff, type RenderHandoff } from '../src/modules/render/handoff';
import { createOnlyOfficeConverter } from '../src/modules/render/onlyoffice-convert';
import { RenderPool } from '../src/modules/render/pool';
import { createEmbeddedRenderer } from '../src/modules/render/renderer';
import { registerRenderRoutes } from '../src/modules/render/routes';
import { renderWorkerUrl } from '../src/modules/render/worker-url';
import { ONLYOFFICE_IMAGE } from './images';

// Настоящий Document Server весит около 3,4 ГБ: тест идёт только в CI (TEST_ONLYOFFICE=1).
const enabled = Boolean(process.env.TEST_ONLYOFFICE);

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NAME = 'ООО Ромашка';
const CONVERT_TIMEOUT = 120_000;

async function docxTemplate(
  body = '<w:p><w:r><w:t>Компания: {d.name}</w:t></w:r></w:p>',
): Promise<Buffer> {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file('word/_rels/document.xml.rels', `${XML}<Relationships xmlns="${RELS}"></Relationships>`);
  zip.file(
    'word/document.xml',
    `${XML}<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function xlsxTemplate(
  sheet = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{d.name}</t></is></c></row></sheetData>',
): Promise<Buffer> {
  const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `${XML}<workbook xmlns="${M}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  zip.file('xl/worksheets/sheet1.xml', `${XML}<worksheet xmlns="${M}">${sheet}</worksheet>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// drop/keep (2.2.0): файл после удаления строк, абзаца и столбца открывается настоящим конвертером
const DROP_DATA = {
  name: NAME,
  hide: true,
  cars: [
    { brand: 'Лада', ok: true },
    { brand: 'Тесла', ok: false },
    { brand: 'БМВ', ok: true },
  ],
};
const wp = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const wtr = (t: string) => `<w:tr><w:tc>${wp(t)}</w:tc></w:tr>`;
const DROP_DOCX =
  wp('Компания: {d.name}') +
  wp('{d.hide:ifEQ(true):drop(p)}скрытый абзац') +
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>' +
  wtr('{d.cars[i].brand}{d.cars[i].ok:ifEQ(false):drop(row)}') +
  wtr('{d.cars[i+1].brand}') +
  '</w:tbl>' +
  // таблица, все строки которой удаляются, исчезает целиком
  '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid>' +
  wtr('{d.cars[i].brand}{d.cars[i].brand:drop(row)}') +
  wtr('{d.cars[i+1].brand}') +
  '</w:tbl>' +
  wp('конец');
const xc = (t: string) => `<c t="inlineStr"><is><t>${t}</t></is></c>`;
const DROP_XLSX =
  '<cols><col min="1" max="1" width="20"/><col min="2" max="2" width="9"/><col min="3" max="3" width="12"/></cols><sheetData>' +
  `<row>${xc('{d.name}')}${xc('скрыть{d.hide:drop(col)}')}${xc('марка')}</row>` +
  `<row>${xc('{d.cars[i].brand}{d.cars[i].ok:ifEQ(false):drop(row)}')}${xc('x')}${xc('{d.cars[i].brand}')}</row>` +
  `<row>${xc('{d.cars[i+1].brand}')}${xc('')}${xc('')}</row>` +
  '</sheetData>';

const tpl = (ext: TemplateFileRef['ext'], file: Buffer): TemplateFileRef => ({
  id: `t-${ext}`,
  version: 1,
  ext,
  read: async () => file,
});
const ro = (convertTo: string) =>
  ({
    convertTo,
    lang: 'ru',
    timezone: 'Europe/Moscow',
    timeoutMs: CONVERT_TIMEOUT - 5_000,
  }) as never;

/** Цепочка причин ошибки (cause скрыта от клиента, но нужна для разбора падения в CI). */
function describeError(e: unknown): string {
  const parts: string[] = [];
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    parts.push(cur instanceof Error ? `${cur.name}: ${cur.message}` : String(cur));
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.join(' <- ');
}

describe.skipIf(!enabled)('встроенный рендер + настоящий Document Server', () => {
  let app: App;
  let port: number;
  let oo: StartedTestContainer;
  let pool: RenderPool;
  let handoff: RenderHandoff;
  let puts: { id: string; token: string }[];
  // Результаты handoff.take: строка — отказ ('forbidden'/'gone'), объект — файл выдан.
  let takes: unknown[];
  let renderer: CarboneRenderer;
  let deadLink: CarboneRenderer;
  let convert: ReturnType<typeof createOnlyOfficeConverter>;
  // Ключи только для этого прогона; в журнал и сообщения не попадают.
  const ooSecret = randomBytes(24).toString('hex');
  const appSecret = new TextEncoder().encode(randomBytes(24).toString('hex'));

  /** Последние строки журнала контейнера Document Server. */
  async function dsLogs(): Promise<string> {
    try {
      const stream = await oo.logs({ tail: 150 });
      const chunks: string[] = [];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        const done = () => (clearTimeout(timer), resolve());
        stream.on('data', (c: Buffer | string) => chunks.push(String(c)));
        stream.on('end', done);
        stream.on('error', done);
      });
      return chunks.join('').slice(-20_000);
    } catch (e) {
      return `журнал недоступен: ${describeError(e)}`;
    }
  }

  /** Выполняет шаг; при падении печатает причину и журнал Document Server. */
  async function diagnose<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const logs = await dsLogs();
      console.error(`[${what}] ${describeError(e)}\n--- журнал Document Server ---\n${logs}`);
      throw new Error(`${what}: ${describeError(e)}`, { cause: e });
    }
  }

  beforeAll(async () => {
    handoff = createRenderHandoff(appSecret);
    puts = [];
    const put = handoff.put.bind(handoff);
    handoff.put = async (...args) => {
      const r = await put(...args);
      puts.push(r);
      return r;
    };
    takes = [];
    const take = handoff.take.bind(handoff);
    handoff.take = async (...args) => {
      const r = await take(...args);
      takes.push(r);
      return r;
    };
    app = createFastify();
    registerErrorHandler(app);
    registerRenderRoutes(app, handoff);
    await app.listen({ port: 0, host: '0.0.0.0' });
    port = (app.server.address() as AddressInfo).port;
    // Контейнер ходит за файлом на хост по имени host.testcontainers.internal.
    await TestContainers.exposeHostPorts(port);

    oo = await new GenericContainer(ONLYOFFICE_IMAGE)
      .withEnvironment({
        JWT_ENABLED: 'true',
        JWT_SECRET: ooSecret,
        JWT_HEADER: 'Authorization',
        ALLOW_PRIVATE_IP_ADDRESS: 'true',
      })
      .withExposedPorts(80)
      .withWaitStrategy(
        Wait.forHttp('/healthcheck', 80)
          .forResponsePredicate((b) => b.includes('true'))
          .withStartupTimeout(240_000),
      )
      .start();

    const worker = renderWorkerUrl();
    pool = new RenderPool({ size: 1, workerUrl: worker.url, execArgv: worker.execArgv });
    convert = createOnlyOfficeConverter({
      baseUrl: `http://${oo.getHost()}:${oo.getMappedPort(80)}`,
      secret: new TextEncoder().encode(ooSecret),
    });
    renderer = createEmbeddedRenderer({
      pool,
      handoff,
      convert,
      selfUrl: `http://host.testcontainers.internal:${port}`,
    });
    deadLink = createEmbeddedRenderer({
      pool,
      handoff,
      convert,
      selfUrl: 'http://host.testcontainers.internal:1',
    });

    // Прогрев: холодный конвертер первое время отвечает -1/-2 или не отвечает.
    const warmDeadline = Date.now() + 60_000;
    const warmTpl = await docxTemplate();
    for (let attempt = 1; ; attempt++) {
      try {
        const { id, token } = await handoff.put(warmTpl, 'docx', Date.now() + 30_000);
        await convert({
          filetype: 'docx',
          outputtype: 'pdf',
          title: 'warmup.docx',
          url: `http://host.testcontainers.internal:${port}/internal/render-files/${id}?t=${encodeURIComponent(token)}`,
          signal: AbortSignal.timeout(30_000),
        });
        break;
      } catch (e) {
        if (Date.now() > warmDeadline) {
          throw new Error(
            `прогрев конвертера не удался (попыток: ${attempt}): ${describeError(e)}`,
            {
              cause: e,
            },
          );
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    // Прогрев не должен влиять на проверки выдачи ссылок.
    puts.length = 0;
    takes.length = 0;
  }, 420_000);

  afterAll(async () => {
    await oo?.stop();
    await pool?.destroy();
    handoff?.close();
    await app?.close();
  }, 120_000);

  it(
    'docx → pdf',
    async () => {
      const out = await diagnose('docx→pdf', async () =>
        renderer.render(tpl('docx', await docxTemplate()), { name: NAME }, ro('pdf')),
      );
      expect(out.subarray(0, 4).toString()).toBe('%PDF');
      expect(out.length).toBeGreaterThan(1024);
    },
    CONVERT_TIMEOUT,
  );

  it(
    'xlsx → ods',
    async () => {
      const out = await diagnose('xlsx→ods', async () =>
        renderer.render(tpl('xlsx', await xlsxTemplate()), { name: NAME }, ro('ods')),
      );
      const zip = await JSZip.loadAsync(out);
      expect(await zip.file('mimetype')!.async('string')).toBe(
        'application/vnd.oasis.opendocument.spreadsheet',
      );
      expect(await zip.file('content.xml')!.async('string')).toContain(NAME);
    },
    CONVERT_TIMEOUT,
  );

  it('odt → docx (шаблон odt получен конвертацией docx в Document Server)', async () => {
    const odt = await diagnose('шаблон docx→odt', async () => {
      const { id, token } = await handoff.put(
        await docxTemplate(),
        'docx',
        Date.now() + CONVERT_TIMEOUT,
      );
      return convert({
        filetype: 'docx',
        outputtype: 'odt',
        title: 'template.docx',
        url: `http://host.testcontainers.internal:${port}/internal/render-files/${id}?t=${encodeURIComponent(token)}`,
        signal: AbortSignal.timeout(CONVERT_TIMEOUT - 5_000),
      });
    });
    const out = await diagnose('odt→docx', () =>
      renderer.render(tpl('odt', odt), { name: NAME }, ro('docx')),
    );
    const zip = await JSZip.loadAsync(out);
    expect(await zip.file('word/document.xml')!.async('string')).toContain(NAME);
  }, 240_000);

  it(
    'drop/keep: docx → pdf (drop(row) в цикле, drop(p), таблица без строк)',
    async () => {
      const out = await diagnose('drop docx→pdf', async () =>
        renderer.render(tpl('docx', await docxTemplate(DROP_DOCX)), DROP_DATA, ro('pdf')),
      );
      expect(out.subarray(0, 4).toString()).toBe('%PDF');
      expect(out.length).toBeGreaterThan(1024);
    },
    CONVERT_TIMEOUT,
  );

  it(
    'drop: xlsx → pdf (drop(row) в цикле, drop(col))',
    async () => {
      const out = await diagnose('drop xlsx→pdf', async () =>
        renderer.render(tpl('xlsx', await xlsxTemplate(DROP_XLSX)), DROP_DATA, ro('pdf')),
      );
      expect(out.subarray(0, 4).toString()).toBe('%PDF');
      expect(out.length).toBeGreaterThan(1024);
    },
    CONVERT_TIMEOUT,
  );

  it(
    'ссылка разовая: Document Server забирает файл ровно один раз',
    async () => {
      const before = puts.length;
      const takesBefore = takes.length;
      await diagnose('docx→pdf (разовая ссылка)', async () =>
        renderer.render(tpl('docx', await docxTemplate()), { name: NAME }, ro('pdf')),
      );
      const made = puts.slice(before);
      expect(made).toHaveLength(1);
      // Ровно одна успешная выдача (объект, не отказ) на рендер с конвертацией.
      const ok = takes.slice(takesBefore).filter((r) => typeof r !== 'string');
      expect(ok).toHaveLength(1);
      // Повторно по верному токену файла уже нет.
      expect(await handoff.take(made[0]!.id, made[0]!.token)).toBe('gone');
    },
    CONVERT_TIMEOUT,
  );

  it(
    'недоступная ссылка — CONVERT_ERROR с кодом -4',
    async () => {
      await expect(
        deadLink.render(tpl('docx', await docxTemplate()), { name: NAME }, ro('pdf')),
      ).rejects.toMatchObject({
        code: 'CONVERT_ERROR',
        message: 'ошибка конвертации (код -4)',
      });
    },
    CONVERT_TIMEOUT,
  );
});
