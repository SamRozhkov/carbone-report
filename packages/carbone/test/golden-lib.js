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
    for (const f of files) zip.addBuffer(Buffer.from(f.data), f.name);
    zip.end();
  });
}

/**
 * Собрать DOCX из шаблона в нотации справки.
 * Строка на `|` — строка таблицы (соседние строки — одна таблица), `<<RAW>>` — следующий элемент raw как есть,
 * иначе абзац.
 */
function buildDocx (template, raw, rels) {
  return zipBuffer([
    { name: '[Content_Types].xml', data: XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: XML + '<Relationships xmlns="' + RELS + '">' + (rels || '') + '</Relationships>' },
    { name: 'word/document.xml', data: XML + '<w:document ' + NS + '><w:body>' + body(template, raw || []) + '<w:p/><w:sectPr/></w:body></w:document>' }
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

function readEntry (buffer, name) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (entry) => {
        if (entry.fileName !== name) return zip.readEntry();
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          const parts = [];
          stream.on('data', (c) => parts.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        });
      });
      zip.on('end', () => reject(new Error('в архиве нет ' + name)));
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

module.exports = { buildDocx, docxText, normalizeError };
