// Помощники эталонов EE: сборка DOCX из шаблона в нотации справки и разбор текста результата.
// Порт buildDocx/docxText из scripts/help-check.ts на CommonJS с yazl/yauzl.
const yazl = require('yazl');
const yauzl = require('yauzl');
const assert = require('assert');

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS = 'xmlns:w="' + W + '"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
  + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, '\'')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&');

// весь текст абзаца — один run, как в пробах матрицы
const para = (t) => '<w:p><w:r><w:t xml:space="preserve">' + esc(t) + '</w:t></w:r></w:p>';
const isRow = (l) => l.startsWith('|');
const cellsOf = (l) => l.trim().slice(1, -1).split('|').map((c) => c.trim());
const rowLine = (cells) => ('| ' + cells.join(' | ') + ' |').replace(/\| {2}(?=\|)/g, '| ');

function table (rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const cell = (c) => '<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>' + para(c) + '</w:tc>';
  return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
    + '<w:tblGrid>' + '<w:gridCol w:w="2000"/>'.repeat(cols) + '</w:tblGrid>'
    + rows.map((r) => '<w:tr>' + r.map(cell).join('') + '</w:tr>').join('')
    + '</w:tbl>';
}

function body (template, raws) {
  const out = [];
  let rows = [];
  let rawIndex = 0;
  const flush = () => {
    if (rows.length > 0) out.push(table(rows));
    rows = [];
  };
  for (const line of template.split('\n')) {
    if (line === '<<RAW>>') {
      flush();
      out.push(raws[rawIndex++]);
    }
    else if (isRow(line)) rows.push(cellsOf(line));
    else {
      flush();
      out.push(para(line));
    }
  }
  flush();
  return out.join('');
}

function zipBuffer (files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const parts = [];
    zip.outputStream.on('data', (c) => parts.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
    // mimetype (OpenDocument) — первым и без сжатия
    for (const f of files) zip.addBuffer(Buffer.from(f.data), f.name, { compress: f.name !== 'mimetype' });
    zip.end();
  });
}

// типы файлов-вложений шаблона (Default в [Content_Types].xml)
const MEDIA_TYPES = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif' };

/**
 * Собрать DOCX из шаблона в нотации справки.
 * Строка на `|` — строка таблицы (соседние строки — одна таблица), `<<RAW>>` — следующий элемент raw как есть,
 * иначе абзац. files — дополнительные файлы архива (например, `word/media/p.png`); для их расширений
 * png/jpeg/jpg/gif в `[Content_Types].xml` добавляется `Default`.
 */
function buildDocx (template, raw, rels, files) {
  const extra = Object.entries(files || {}).map(([name, data]) => ({ name, data }));
  const defaults = [...new Set(extra.map((f) => (/\.([a-z]+)$/i.exec(f.name) || [])[1]).filter((e) => e !== undefined).map((e) => e.toLowerCase()))]
    .filter((e) => MEDIA_TYPES[e] !== undefined)
    .map((e) => '<Default Extension="' + e + '" ContentType="' + MEDIA_TYPES[e] + '"/>')
    .join('');
  return zipBuffer([
    { name: '[Content_Types].xml', data: XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + defaults + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: XML + '<Relationships xmlns="' + RELS + '">' + (rels || '') + '</Relationships>' },
    { name: 'word/document.xml', data: XML + '<w:document ' + NS + '><w:body>' + body(template, raw || []) + '<w:p/><w:sectPr/></w:body></w:document>' },
    ...extra
  ]);
}

const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const CHART_CT = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// файлы минимальной книги: workbook.xml с одним листом sheetName, связи, лист с содержимым sheetData = sheetXml
function workbookFiles (sheetXml, sheetName, sheetExtra, extraTypes) {
  return [
    { name: '[Content_Types].xml', data: XML + '<Types xmlns="' + CT_NS + '"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' + (extraTypes || '') + '</Types>' },
    { name: '_rels/.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: XML + '<workbook xmlns="' + SHEET_NS + '" xmlns:r="' + OFFICE_REL + '"><sheets><sheet name="' + escAttr(sheetName || 'Sheet1') + '" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + '/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: XML + '<worksheet xmlns="' + SHEET_NS + '" xmlns:r="' + OFFICE_REL + '"><sheetData>' + sheetXml + '</sheetData>' + (sheetExtra || '') + '</worksheet>' }
  ];
}

/**
 * Собрать XLSX с одним листом и (если chartXml задан) диаграммой на нём.
 * sheetXml — содержимое sheetData (строки), chartXml — весь xl/charts/chart1.xml без пролога.
 */
function buildXlsxWithChart ({ sheetXml, chartXml, sheetName }) {
  if (chartXml === undefined || chartXml === null) {
    return zipBuffer(workbookFiles(sheetXml, sheetName));
  }
  const files = workbookFiles(sheetXml, sheetName, '<drawing r:id="rId1"/>',
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'
    + '<Override PartName="/xl/charts/chart1.xml" ContentType="' + CHART_CT + '"/>');
  return zipBuffer([
    ...files,
    { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + '/drawing" Target="../drawings/drawing1.xml"/></Relationships>' },
    { name: 'xl/drawings/drawing1.xml', data: XML + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="5400000" cy="2700000"/>'
      + '<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="1" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="' + OFFICE_REL + '" r:id="rId1"/></a:graphicData></a:graphic>'
      + '</xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>' },
    { name: 'xl/drawings/_rels/drawing1.xml.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + '/chart" Target="../charts/chart1.xml"/></Relationships>' },
    { name: 'xl/charts/chart1.xml', data: XML + chartXml }
  ]);
}

/**
 * Собрать DOCX с диаграммой word/charts/chart1.xml и встроенной книгой word/embeddings/Microsoft_Excel_Worksheet.xlsx.
 * documentXml — содержимое w:body (по умолчанию абзац с диаграммой), embeddedSheetXml — содержимое sheetData книги.
 */
async function buildDocxWithChart ({ documentXml, chartXml, embeddedSheetXml, sheetName }) {
  const embedded = await zipBuffer(workbookFiles(embeddedSheetXml, sheetName));
  const drawing = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="3200400"/><wp:docPr id="1" name="Chart 1"/>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId5"/></a:graphicData></a:graphic>'
    + '</wp:inline></w:drawing></w:r></w:p>';
  return zipBuffer([
    { name: '[Content_Types].xml', data: XML + '<Types xmlns="' + CT_NS + '"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/charts/chart1.xml" ContentType="' + CHART_CT + '"/></Types>' },
    { name: '_rels/.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + '/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId5" Type="' + OFFICE_REL + '/chart" Target="charts/chart1.xml"/></Relationships>' },
    { name: 'word/document.xml', data: XML + '<w:document ' + NS + '><w:body>' + (documentXml !== undefined ? documentXml : drawing) + '<w:sectPr/></w:body></w:document>' },
    { name: 'word/charts/chart1.xml', data: XML + chartXml },
    { name: 'word/charts/_rels/chart1.xml.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + '/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/></Relationships>' },
    { name: 'word/embeddings/Microsoft_Excel_Worksheet.xlsx', data: embedded }
  ]);
}

const TEXT_RE = /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>/g;
const BLOCK_RE = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const PARA_RE = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const ROW_RE = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
const CELL_RE = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;

function paraText (p) {
  let s = '';
  for (const m of p.matchAll(TEXT_RE)) {
    if (m[0].startsWith('<w:br')) s += '\n';
    else if (m[1] !== undefined) s += unesc(m[1]);
  }
  return s;
}

/** Файл архива: строка utf8, с binary === true — Buffer */
function readEntry (buffer, name, binary) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (entry) => {
        if (entry.fileName !== name) return zip.readEntry();
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          const parts = [];
          stream.on('data', (c) => parts.push(c)).on('error', reject).on('end', () => {
            const data = Buffer.concat(parts);
            resolve(binary === true ? data : data.toString('utf8'));
          });
        });
      });
      zip.on('end', () => reject(new Error('в архиве нет ' + name)));
      zip.readEntry();
    });
  });
}

/** Имена файлов архива по порядку */
function entryNames (buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const names = [];
      zip.on('entry', (entry) => {
        names.push(entry.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Текст word/document.xml в нотации справки: абзацы построчно, строки таблиц как `| a | b |`. */
async function docxText (buffer) {
  const xml = await readEntry(buffer, 'word/document.xml');
  const bodyXml = (/<w:body>([\s\S]*)<\/w:body>/.exec(xml) || [])[1] || '';
  const lines = [];
  for (const [block] of bodyXml.matchAll(BLOCK_RE)) {
    if (block.startsWith('<w:tbl>')) {
      for (const [row] of block.matchAll(ROW_RE)) {
        lines.push(rowLine([...row.matchAll(CELL_RE)].map(([c]) => [...c.matchAll(PARA_RE)].map(([p]) => paraText(p)).join(' / '))));
      }
    }
    else {
      const text = paraText(block);
      if (text !== '') lines.push(text);
    }
  }
  return lines.join('\n');
}

/** Сообщение ошибки без префикса «Unable to generate the document. Error: » и суффикса « Source: "…"». */
function normalizeError (message) {
  return String(message)
    .replace(/^Unable to generate the document\. Error: /, '')
    .replace(/ Source: [\s\S]*$/, '');
}

// OpenDocument: минимальный пакет ODT/ODS/ODP
const ODF_MIME = { odt: 'text', ods: 'spreadsheet', odp: 'presentation' };
const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
  + ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"'
  + ' xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"'
  + ' xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"'
  + ' xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
const ODF_FILE_TYPES = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', xml: 'text/xml' };

/**
 * ODT/ODS/ODP: body — содержимое office:text / office:spreadsheet / office:presentation.
 * opts: { ns — дополнительные объявления пространств имён content.xml (xmlns:calcext="…"), fonts, automatic — содержимое office:font-face-decls / office:automatic-styles content.xml (не задано —
 * элемента нет), files — { имя: данные } дополнительные файлы (styles.xml, Pictures/…; в manifest.xml по расширению) }
 */
function buildOdf (ext, body, opts) {
  const o = opts || {};
  const mime = 'application/vnd.oasis.opendocument.' + ODF_MIME[ext];
  const extra = Object.entries(o.files || {}).map(([name, data]) => ({ name, data }));
  const entries = extra.map((f) => '<manifest:file-entry manifest:full-path="' + f.name + '" manifest:media-type="'
    + (ODF_FILE_TYPES[(/\.([a-z]+)$/i.exec(f.name) || [])[1]] || '') + '"/>').join('');
  return zipBuffer([
    { name: 'mimetype', data: mime },
    { name: 'META-INF/manifest.xml', data: XML + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">'
      + '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="' + mime + '"/>'
      + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' + entries + '</manifest:manifest>' },
    { name: 'content.xml', data: XML + '<office:document-content ' + ODF_NS + (o.ns ? ' ' + o.ns : '') + ' office:version="1.3">'
      + (o.fonts !== undefined ? '<office:font-face-decls>' + o.fonts + '</office:font-face-decls>' : '')
      + (o.automatic !== undefined ? '<office:automatic-styles>' + o.automatic + '</office:automatic-styles>' : '')
      + '<office:body><office:' + ODF_MIME[ext] + '>' + body + '</office:' + ODF_MIME[ext] + '></office:body></office:document-content>' },
    ...extra
  ]);
}

const buildOdt = (body, opts) => buildOdf('odt', body, opts);

// Листы XLSX/ODS для тестов рендера ячеек (§53, §54): сборка из строк текстов ячеек и разбор результата.
// renderBuffer подключается при вызове — golden-lib загружается и без движка.
const RU = { lang: 'ru', timezone: 'Europe/Moscow' };

/** XLSX: строки — массивы текстов ячеек (общие строки, как сохраняет Excel); ячейки со стилем s="1" */
function xlsx (rows) {
  const strings = [];
  const cell = (v, r, c) => {
    strings.push(v);
    return '<c r="' + String.fromCharCode(65 + c) + r + '" s="1" t="s"><v>' + (strings.length - 1) + '</v></c>';
  };
  const sheet = rows.map((cells, r) => '<row r="' + (r + 1) + '">' + cells.map((v, c) => cell(v, r + 1, c)).join('') + '</row>').join('');
  return zipBuffer([
    { name: '[Content_Types].xml', data: XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>' },
    { name: '_rels/.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + '/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: XML + '<workbook xmlns="' + SHEET_NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + '/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + OFFICE_REL + '/sharedStrings" Target="sharedStrings.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: XML + '<sst xmlns="' + SHEET_NS + '">' + strings.map((s) => '<si><t xml:space="preserve">' + s + '</t></si>').join('') + '</sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: XML + '<worksheet xmlns="' + SHEET_NS + '"><sheetData>' + sheet + '</sheetData></worksheet>' }
  ]);
}

/**
 * Собранный XLSX → строки ячеек { t, v } (t — тип ячейки, v — содержимое <v> или null, если элемента нет);
 * текст общих строк подставляется в v.
 */
async function renderXlsx (rows, data, options) {
  const out = await require('../lib/index').renderBuffer(await xlsx(rows), 'xlsx', data, options || RU);
  const sheet = await readEntry(out, 'xl/worksheets/sheet1.xml');
  assertWellFormed(sheet);
  let sst = '';
  try {
    sst = await readEntry(out, 'xl/sharedStrings.xml');
  }
  catch (e) {
    sst = '';
  }
  const strings = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) => [...si.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join(''));
  const result = [];
  for (const [, body = ''] of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = [];
    for (const [, attrs, inner = ''] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const t = (/\st="([^"]*)"/.exec(attrs) || [])[1] || null;
      const v = (/<v>([^<]*)<\/v>/.exec(inner) || [])[1];
      assert.ok(!/<v\s*\/>|<v><\/v>/.test(inner), 'пустой <v> в ячейке: ' + inner);
      assert.match(attrs, /\ss="1"/, 'стиль ячейки потерян: ' + attrs);
      cells.push({ t, v: v === undefined ? null : (t === 's' ? strings[Number(v)] : v) });
    }
    result.push(cells);
  }
  return { rows: result, sheet };
}

/**
 * XML правильно построен — без парсера в зависимостях (строгого XML-парсера в пакете нет, htmlparser2 ошибки не
 * ловит): теги вложены парно, атрибуты в кавычках, у элемента нет повторных атрибутов, и каждый префикс имени
 * элемента или атрибута объявлен (xmlns:префикс) в нём или в предке.
 */
function assertWellFormed (xml) {
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([^\s/>!?]+)((?:\s+[^\s=<>"']+\s*=\s*"[^"<]*")*)\s*(\/?)>|</g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[0] === '<') assert.fail('сломанный тег в позиции ' + m.index + ': ' + xml.slice(m.index, m.index + 80));
    if (m[2] === undefined) continue;
    if (m[1] === '/') {
      const open = stack.pop();
      assert.strictEqual(open && open.name, m[2], 'непарный закрывающий тег </' + m[2] + '>');
      continue;
    }
    const attrs = [...m[3].matchAll(/([^\s=]+)\s*=\s*"([^"]*)"/g)].map((a) => a[1]);
    assert.strictEqual(new Set(attrs).size, attrs.length, 'повторный атрибут: ' + m[0]);
    const ns = new Set(stack.length > 0 ? stack[stack.length - 1].ns : ['xml']);
    attrs.filter((a) => a.startsWith('xmlns:')).forEach((a) => ns.add(a.slice(6)));
    for (const name of [m[2], ...attrs.filter((a) => !a.startsWith('xmlns'))]) {
      const i = name.indexOf(':');
      if (i !== -1) assert.ok(ns.has(name.slice(0, i)), 'префикс «' + name.slice(0, i) + '» не объявлен: ' + m[0]);
    }
    if (m[4] !== '/') stack.push({ name: m[2], ns });
  }
  assert.deepStrictEqual(stack.map((e) => e.name), []);
}

const CALCEXT_NS = 'xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"';

/**
 * ODS: строки — массивы текстов ячеек. По умолчанию — как сохраняет LibreOffice (пространство calcext объявлено,
 * у ячеек calcext:value-type); excel: true — как сохраняют Excel и Google Sheets (calcext нет)
 */
const odsCell = (text, excel) => '<table:table-cell table:style-name="ce1" office:value-type="string"' + (excel ? '' : ' calcext:value-type="string"') + '><text:p>' + text + '</text:p></table:table-cell>';
const odsBody = (rows, excel) => '<table:table table:name="S"><table:table-column table:number-columns-repeated="' + Math.max(...rows.map((r) => r.length)) + '"/>'
  + rows.map((cells) => '<table:table-row>' + cells.map((c) => odsCell(c, excel)).join('') + '</table:table-row>').join('') + '</table:table>';

/** Собранный ODS → строки ячеек: открывающий тег и текст абзаца (у массива — свойство content); content.xml шаблона и результата — правильный XML */
async function renderOds (rows, data, options, excel) {
  const template = await buildOdf('ods', odsBody(rows, excel), excel ? {} : { ns: CALCEXT_NS });
  assertWellFormed(await readEntry(template, 'content.xml'));
  const out = await require('../lib/index').renderBuffer(template, 'ods', data, options || RU);
  const content = await readEntry(out, 'content.xml');
  assertWellFormed(content);
  const result = [];
  for (const [, body] of content.matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
    const cells = [];
    for (const [, tag, text] of body.matchAll(/(<table:table-cell\b[^>]*>)<text:p>([^<]*)<\/text:p><\/table:table-cell>/g)) {
      const attr = (name) => (new RegExp('\\s' + name + '="([^"]*)"').exec(tag) || [])[1] || null;
      assert.match(tag, /table:style-name="ce1"/, 'стиль ячейки потерян: ' + tag);
      cells.push({ type: attr('office:value-type'), calc: attr('calcext:value-type'), date: attr('office:date-value'), text });
    }
    result.push(cells);
  }
  // content.xml результата — неперечисляемым свойством, чтобы сравнение строк ячеек его не видело
  Object.defineProperty(result, 'content', { value: content });
  return result;
}

// данные тестов листов (§53): группы с вложенными строками и те же строки плоским списком
const GROUPS = [
  { contractor: 'Альфа', rows: [{ date: '2026-01-05', sum: 100.5, qty: 2 }, { date: '2026-01-07', sum: 50, qty: 1 }] },
  { contractor: 'Бета', rows: [{ date: '2026-02-01', sum: 10.25, qty: 3 }] }
];
const LIST = GROUPS.flatMap((g) => g.rows.map((r) => ({ contractor: g.contractor, ...r })));

module.exports = { GROUPS, LIST, ODF_NS, RU, assertWellFormed, renderOds, renderXlsx, xlsx, buildOdf, buildOdt, buildDocx, buildDocxWithChart, buildXlsxWithChart, docxText, entryNames, normalizeError, readEntry, zipBuffer };
