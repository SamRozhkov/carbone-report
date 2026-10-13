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

// изображения и штрихкоды (2.4.0): картинки-заглушки с тегом в замещающем тексте (descr)
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMAGE_DATA = { photo: `data:image/png;base64,${PNG_1X1}`, code: 'INV-2026-0042' };

/** Картинка «в тексте» 2,54 × 2,54 см с тегом в замещающем тексте; заглушка — word/media/p.png. */
function placeholder(id: number, tag: string): string {
  return (
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/>' +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${tag}"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="p.png" descr="${tag}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    '<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

async function imagesDocx(): Promise<Buffer> {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const NS =
    `xmlns:w="${W}"` +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
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
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/></Relationships>`,
  );
  zip.file('word/media/p.png', Buffer.from(PNG_1X1, 'base64'));
  const body =
    wp('Компания: {d.name}') +
    placeholder(1, '{d.photo}') +
    placeholder(2, '{d.code:barcode(qrcode)}') +
    wp('конец');
  zip.file(
    'word/document.xml',
    `${XML}<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

// диаграммы (2.5.0): гистограмма, теги — в листе данных строками цикла [i] и [i+1]
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const CHART_CT = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const CHART_DATA = {
  sales: [
    { month: 'Янв', sum: 10 },
    { month: 'Фев', sum: 25 },
    { month: 'Мар', sum: 7 },
  ],
};
/** Ячейка текстом; `r` — адрес. */
const ic = (r: string, t: string) => `<c r="${r}" t="inlineStr"><is><t>${t}</t></is></c>`;
/** Лист данных: имя ряда в B1 (A1 нет, как у Word), строки цикла 2–3. */
const CHART_SHEET =
  `<row r="1">${ic('B1', 'Сумма')}</row>` +
  `<row r="2">${ic('A2', '{d.sales[i].month}')}${ic('B2', '{d.sales[i].sum}')}</row>` +
  `<row r="3">${ic('A3', '{d.sales[i+1].month}')}${ic('B3', '{d.sales[i+1].sum}')}</row>`;

/** Гистограмма по Лист1: подписи A2:A3, значения B2:B3, имя ряда B1; кэш пуст — его строит сборка. */
function chartXml(external: boolean): string {
  const ref = (kind: 'str' | 'num', f: string) =>
    `<c:${kind}Ref><c:f>${f}</c:f><c:${kind}Cache>${kind === 'num' ? '<c:formatCode>General</c:formatCode>' : ''}<c:ptCount val="0"/></c:${kind}Cache></c:${kind}Ref>`;
  return (
    `${XML}<c:chartSpace xmlns:c="${CHART_NS}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL}">` +
    '<c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>' +
    '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>' +
    '<c:ser><c:idx val="0"/><c:order val="0"/>' +
    `<c:tx>${ref('str', 'Лист1!$B$1')}</c:tx>` +
    `<c:cat>${ref('str', 'Лист1!$A$2:$A$3')}</c:cat>` +
    `<c:val>${ref('num', 'Лист1!$B$2:$B$3')}</c:val>` +
    '</c:ser><c:gapWidth val="150"/><c:axId val="1"/><c:axId val="2"/></c:barChart>' +
    '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>' +
    '<c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/>' +
    '<c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="2"/><c:crosses val="autoZero"/>' +
    '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>' +
    '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>' +
    '<c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/>' +
    '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="1"/>' +
    '<c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>' +
    '</c:plotArea><c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/></c:chart>' +
    (external ? '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>' : '') +
    '</c:chartSpace>'
  );
}

/** Файлы книги с одним листом «Лист1»; `drawing` — диаграмма на листе (XLSX). */
function workbook(zip: JSZip, sheetData: string, drawing: boolean): void {
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      (drawing
        ? `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="${CHART_CT}"/>`
        : '') +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    'xl/workbook.xml',
    `${XML}<workbook xmlns="${SHEET_NS}" xmlns:r="${OFFICE_REL}"><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `${XML}<worksheet xmlns="${SHEET_NS}" xmlns:r="${OFFICE_REL}"><sheetData>${sheetData}</sheetData>${drawing ? '<drawing r:id="rId1"/>' : ''}</worksheet>`,
  );
}

/** DOCX: абзац и гистограмма «в тексте» со встроенной книгой (Word: «Изменить данные»). */
async function chartDocx(): Promise<Buffer> {
  const embedded = new JSZip();
  workbook(embedded, CHART_SHEET, false);
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/charts/chart1.xml" ContentType="${CHART_CT}"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId5" Type="${OFFICE_REL}/chart" Target="charts/chart1.xml"/></Relationships>`,
  );
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const NS =
    `xmlns:w="${W}" xmlns:r="${OFFICE_REL}"` +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const chart =
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="3200400"/><wp:docPr id="1" name="Chart 1"/>' +
    `<a:graphic><a:graphicData uri="${CHART_NS}"><c:chart xmlns:c="${CHART_NS}" r:id="rId5"/></a:graphicData></a:graphic>` +
    '</wp:inline></w:drawing></w:r></w:p>';
  zip.file(
    'word/document.xml',
    `${XML}<w:document ${NS}><w:body>${wp('Продажи по месяцам')}${chart}<w:sectPr/></w:body></w:document>`,
  );
  zip.file('word/charts/chart1.xml', chartXml(true));
  zip.file(
    'word/charts/_rels/chart1.xml.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_REL}/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/></Relationships>`,
  );
  zip.file(
    'word/embeddings/Microsoft_Excel_Worksheet.xlsx',
    await embedded.generateAsync({ type: 'nodebuffer' }),
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** XLSX: данные в ячейках листа, гистограмма на том же листе. */
async function chartXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  workbook(zip, CHART_SHEET, true);
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
  );
  zip.file(
    'xl/drawings/drawing1.xml',
    `${XML}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      '<xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="5400000" cy="2700000"/>' +
      '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
      `<a:graphic><a:graphicData uri="${CHART_NS}"><c:chart xmlns:c="${CHART_NS}" xmlns:r="${OFFICE_REL}" r:id="rId1"/></a:graphicData></a:graphic>` +
      '</xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>',
  );
  zip.file(
    'xl/drawings/_rels/drawing1.xml.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_REL}/chart" Target="../charts/chart1.xml"/></Relationships>`,
  );
  zip.file('xl/charts/chart1.xml', chartXml(false));
  return zip.generateAsync({ type: 'nodebuffer' });
}

// :html (2.5.0): абзац, список, таблица — DOCX; вложенный список с таблицей в пункте, объединённые ячейки,
// изображение из data URI — ODT
const HTML_DOCX =
  '<p>Счёт <b>оплачен</b> полностью.</p>' +
  '<ul><li>Доставка</li><li>Монтаж</li></ul>' +
  '<table><tr><th>Товар</th><th>Количество</th></tr><tr><td>Кабель</td><td>10</td></tr></table>';
const HTML_ODT =
  '<p>Абзац из <i>HTML</i>.</p>' +
  '<ol><li>Первый пункт<ul><li>Вложенный пункт<table><tr><td>Ячейка в пункте</td></tr></table>продолжение</li></ul></li>' +
  '<li>Второй пункт</li></ol>' +
  '<table><tr><td rowspan="2">Объединено</td><td colspan="2">Шапка</td></tr><tr><td>Левая</td><td>Правая</td></tr></table>' +
  `<p><img src="data:image/png;base64,${PNG_1X1}" width="40" height="40"> подпись</p>`;

/** ODT с одним абзацем; `text` — содержимое text:p. */
async function odtTemplate(text: string): Promise<Buffer> {
  const ns =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' +
    ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"' +
    ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"' +
    ' xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
  const zip = new JSZip();
  // mimetype — первым и без сжатия (ODF 1.2, 3.3)
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `${XML}<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">` +
      '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>' +
      '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
      '</manifest:manifest>',
  );
  zip.file(
    'content.xml',
    `${XML}<office:document-content ${ns} office:version="1.2"><office:automatic-styles/><office:body><office:text>` +
      `<text:p>${text}</text:p></office:text></office:body></office:document-content>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

const tpl = (ext: TemplateFileRef['ext'], file: Buffer): TemplateFileRef => ({
  id: `t-${ext}`,
  version: 1,
  ext,
  read: async () => file,
});
/** Весь текст XML-частей архива (документ, диаграммы, встроенные объекты) — для проверки результата конвертации. */
async function zipText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const parts = Object.values(zip.files).filter((f) => !f.dir && f.name.endsWith('.xml'));
  return (await Promise.all(parts.map((f) => f.async('string')))).join('\n');
}

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
      imageUrlAllowlist: [],
      imageUrlTimeoutMs: 5000,
    });
    deadLink = createEmbeddedRenderer({
      pool,
      handoff,
      convert,
      selfUrl: 'http://host.testcontainers.internal:1',
      imageUrlAllowlist: [],
      imageUrlTimeoutMs: 5000,
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
    'drop/keep: docx → pdf и odt (drop(row) в цикле, drop(p), таблица без строк)',
    async () => {
      const out = await diagnose('drop docx→pdf', async () =>
        renderer.render(tpl('docx', await docxTemplate(DROP_DOCX)), DROP_DATA, ro('pdf')),
      );
      expect(out.subarray(0, 4).toString()).toBe('%PDF');
      expect(out.length).toBeGreaterThan(1024);
      // без конвертации: удалено именно то, что должно (строка «Тесла», абзац, вторая таблица)
      const docx = await renderer.render(
        tpl('docx', await docxTemplate(DROP_DOCX)),
        DROP_DATA,
        ro('docx'),
      );
      const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
      expect(xml).toContain('БМВ');
      expect(xml).not.toContain('Тесла');
      expect(xml).not.toContain('скрытый абзац');
      expect(xml.match(/<w:tbl>/g)).toHaveLength(1);
      // настоящий читатель: Document Server открывает результат и видит тот же текст
      const odt = await diagnose('drop docx→odt', async () =>
        renderer.render(tpl('docx', await docxTemplate(DROP_DOCX)), DROP_DATA, ro('odt')),
      );
      const content = await (await JSZip.loadAsync(odt)).file('content.xml')!.async('string');
      expect(content).toContain('Лада');
      expect(content).toContain('конец');
      expect(content).not.toContain('Тесла');
      expect(content).not.toContain('скрытый абзац');
    },
    CONVERT_TIMEOUT,
  );

  it(
    'drop: xlsx → pdf и ods (drop(row) в цикле, drop(col))',
    async () => {
      const out = await diagnose('drop xlsx→pdf', async () =>
        renderer.render(tpl('xlsx', await xlsxTemplate(DROP_XLSX)), DROP_DATA, ro('pdf')),
      );
      expect(out.subarray(0, 4).toString()).toBe('%PDF');
      expect(out.length).toBeGreaterThan(1024);
      const ods = await diagnose('drop xlsx→ods', async () =>
        renderer.render(tpl('xlsx', await xlsxTemplate(DROP_XLSX)), DROP_DATA, ro('ods')),
      );
      const content = await (await JSZip.loadAsync(ods)).file('content.xml')!.async('string');
      expect(content).toContain('марка');
      expect(content).toContain('БМВ');
      expect(content).not.toContain('Тесла');
      expect(content).not.toContain('скрыть');
    },
    CONVERT_TIMEOUT,
  );

  it(
    'xlsx с циклом и несколькими текстовыми ячейками → ods: все ячейки на месте',
    async () => {
      // До 2.2.0 сборка оставляла в листе встроенные строки (t="inlineStr"); Document Server при конвертации
      // сохранял только первую из них.
      const sheet =
        '<sheetData>' +
        `<row r="1">${xc('Марка')}${xc('Комментарий')}</row>` +
        `<row r="2">${xc('{d.cars[i].brand}')}${xc('ok: {d.cars[i].ok}')}</row>` +
        `<row r="3">${xc('{d.cars[i+1].brand}')}${xc('')}</row>` +
        '</sheetData>';
      const ods = await diagnose('xlsx-цикл→ods', async () =>
        renderer.render(tpl('xlsx', await xlsxTemplate(sheet)), DROP_DATA, ro('ods')),
      );
      const content = await (await JSZip.loadAsync(ods)).file('content.xml')!.async('string');
      for (const text of ['Марка', 'Комментарий', 'Лада', 'Тесла', 'БМВ', 'ok: false']) {
        expect(content).toContain(text);
      }
    },
    CONVERT_TIMEOUT,
  );

  it(
    'изображение из data URI и штрихкод: docx → pdf без ошибки, в PDF есть изображения',
    async () => {
      // сборка без конвертации: обе заглушки заменены своими файлами
      const docx = await renderer.render(
        tpl('docx', await imagesDocx()),
        { name: NAME, ...IMAGE_DATA },
        ro('docx'),
      );
      const zip = await JSZip.loadAsync(docx);
      const media = Object.keys(zip.files).filter((n) => /^word\/media\/cr-img-\d+\.png$/.test(n));
      expect(media).toHaveLength(2);
      const xml = await zip.file('word/document.xml')!.async('string');
      expect(xml).not.toContain('{d.');
      // настоящий читатель: Document Server открывает документ и кладёт изображения в PDF
      const pdf = await diagnose('изображения docx→pdf', async () =>
        renderer.render(tpl('docx', await imagesDocx()), { name: NAME, ...IMAGE_DATA }, ro('pdf')),
      );
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      const text = pdf.toString('latin1');
      expect(text).toMatch(/\/Image\b/);
      expect(text.match(/\/Subtype\s*\/Image\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    },
    CONVERT_TIMEOUT,
  );

  it(
    'диаграмма Word: docx → pdf без ошибки, подписи категорий читаются',
    async () => {
      const docx = await renderer.render(tpl('docx', await chartDocx()), CHART_DATA, ro('docx'));
      const chart = await (
        await JSZip.loadAsync(docx)
      )
        .file('word/charts/chart1.xml')!
        .async('string');
      expect(chart).toContain('<c:f>Лист1!$A$2:$A$4</c:f>');
      const pdf = await diagnose('диаграмма docx→pdf', async () =>
        renderer.render(tpl('docx', await chartDocx()), CHART_DATA, ro('pdf')),
      );
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      // настоящий читатель: Document Server открывает диаграмму и видит подписи из данных
      const odt = await diagnose('диаграмма docx→odt', async () =>
        renderer.render(tpl('docx', await chartDocx()), CHART_DATA, ro('odt')),
      );
      expect(await zipText(odt)).toContain('Фев');
    },
    CONVERT_TIMEOUT,
  );

  it(
    'диаграмма Excel: xlsx → pdf без ошибки',
    async () => {
      const pdf = await diagnose('диаграмма xlsx→pdf', async () =>
        renderer.render(tpl('xlsx', await chartXlsx()), CHART_DATA, ro('pdf')),
      );
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    },
    CONVERT_TIMEOUT,
  );

  it(
    ':html в DOCX: абзац, список, таблица → pdf без ошибки, текст из HTML читается',
    async () => {
      const pdf = await diagnose(':html docx→pdf', async () =>
        renderer.render(
          tpl('docx', await docxTemplate(wp('{d.h:html}'))),
          { h: HTML_DOCX },
          ro('pdf'),
        ),
      );
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      const odt = await diagnose(':html docx→odt', async () =>
        renderer.render(
          tpl('docx', await docxTemplate(wp('{d.h:html}'))),
          { h: HTML_DOCX },
          ro('odt'),
        ),
      );
      const text = await zipText(odt);
      for (const word of ['оплачен', 'Монтаж', 'Кабель', 'Количество'])
        expect(text).toContain(word);
    },
    CONVERT_TIMEOUT,
  );

  it(
    ':html в ODT: вложенный список с таблицей, объединённые ячейки, изображение → pdf без ошибки, текст читается',
    async () => {
      const pdf = await diagnose(':html odt→pdf', async () =>
        renderer.render(tpl('odt', await odtTemplate('{d.h:html}')), { h: HTML_ODT }, ro('pdf')),
      );
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      const docx = await diagnose(':html odt→docx', async () =>
        renderer.render(tpl('odt', await odtTemplate('{d.h:html}')), { h: HTML_ODT }, ro('docx')),
      );
      const text = await zipText(docx);
      for (const word of [
        'Вложенный пункт',
        'Ячейка в пункте',
        'продолжение',
        'Второй пункт',
        'Объединено',
        'Правая',
      ])
        expect(text).toContain(word);
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
