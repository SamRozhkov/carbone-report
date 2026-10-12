// Помощники эталонов EE: сборка DOCX из шаблона в нотации справки и разбор текста результата.
// Порт buildDocx/docxText из scripts/help-check.ts на CommonJS с yazl/yauzl.
const yazl = require('yazl');
const yauzl = require('yauzl');

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
 * opts: { fonts, automatic — содержимое office:font-face-decls / office:automatic-styles content.xml (не задано —
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
    { name: 'content.xml', data: XML + '<office:document-content ' + ODF_NS + ' office:version="1.3">'
      + (o.fonts !== undefined ? '<office:font-face-decls>' + o.fonts + '</office:font-face-decls>' : '')
      + (o.automatic !== undefined ? '<office:automatic-styles>' + o.automatic + '</office:automatic-styles>' : '')
      + '<office:body><office:' + ODF_MIME[ext] + '>' + body + '</office:' + ODF_MIME[ext] + '></office:body></office:document-content>' },
    ...extra
  ]);
}

const buildOdt = (body, opts) => buildOdf('odt', body, opts);

module.exports = { ODF_NS, buildOdf, buildOdt, buildDocx, buildDocxWithChart, buildXlsxWithChart, docxText, entryNames, normalizeError, readEntry, zipBuffer };
