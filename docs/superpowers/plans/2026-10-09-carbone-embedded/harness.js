const path = require('path'); const fs = require('fs');
const { renderBuffer, file } = require('./proto');
const yauzl = require('../carbone-src/node_modules/yauzl');
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const para = (t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
const isRow = (l) => l.startsWith('|');
const cellsOf = (l) => l.trim().slice(1, -1).split('|').map((c) => c.trim());
const rowLine = (cells) => `| ${cells.join(' | ')} |`.replace(/\| {2}(?=\|)/g, '| ');
function table(rows) { const cols = Math.max(...rows.map((r) => r.length));
  const cell = (c) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(c)}</w:tc>`;
  return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' + `<w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(cols)}</w:tblGrid>` + rows.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('') + '</w:tbl>'; }
function body(tpl, raws) { const out = []; let rows = []; let ri = 0; const flush = () => { if (rows.length) out.push(table(rows)); rows = []; };
  for (const l of tpl.split('\n')) { if (l === '<<RAW>>') { flush(); out.push(raws[ri++]); } else if (isRow(l)) rows.push(cellsOf(l)); else { flush(); out.push(para(l)); } }
  flush(); return out.join(''); }
const NS = 'xmlns:w="' + W + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
function buildDocx(tpl, raws, rels) { return new Promise((res) => file.zip([
  { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
  { name: '_rels/.rels', data: `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
  { name: 'word/_rels/document.xml.rels', data: `${XML}<Relationships xmlns="${RELS}">${rels || ''}</Relationships>` },
  { name: 'word/document.xml', data: `${XML}<w:document ${NS}><w:body>${body(tpl, raws || [])}<w:p/><w:sectPr/></w:body></w:document>` },
], (e, b) => res(b))); }
const TEXT_RE = /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>/g;
const BLOCK_RE = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const PARA_RE = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const ROW_RE = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g; const CELL_RE = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
const paraText = (p) => { let s = ''; for (const m of p.matchAll(TEXT_RE)) { if (m[0].startsWith('<w:br')) s += '\n'; else if (m[1] !== undefined) s += unesc(m[1]); } return s; };
function docxText(x) { const b = /<w:body>([\s\S]*)<\/w:body>/.exec(x)?.[1] ?? ''; const lines = [];
  for (const [blk] of b.matchAll(BLOCK_RE)) { if (blk.startsWith('<w:tbl>')) { for (const [row] of blk.matchAll(ROW_RE)) lines.push(rowLine([...row.matchAll(CELL_RE)].map(([c]) => [...c.matchAll(PARA_RE)].map(([p]) => paraText(p)).join(' / ')))); }
    else { const t = paraText(blk); if (t !== '') lines.push(t); } } return lines.join('\n'); }
function readEntry(buf, name) { return new Promise((res, rej) => yauzl.fromBuffer(buf, { lazyEntries: true }, (e, z) => { if (e) return rej(e); z.readEntry();
  z.on('entry', (en) => { if (en.fileName !== name) return z.readEntry(); z.openReadStream(en, (e, s) => { const ch = []; s.on('data', (d) => ch.push(d)); s.on('end', () => res(Buffer.concat(ch).toString())); }); });
  z.on('end', () => res(null)); })); }
const coreErr = (s) => (s || '').replace(/^HTTP \d+ /, '').replace(/^.*?"error":"/, '').replace(/^Unable to generate the document\. Error: /, '').replace(/ Source: .*$/s, '').replace(/\\"/g, '"');
module.exports = { buildDocx, docxText, readEntry, coreErr, renderBuffer };
if (require.main === module) (async () => {
  const which = process.argv[2];
  const lang0 = process.argv[3] || 'ru-ru';
  const cases = [];
  if (which === 'help') for (const e of require('../help-examples.json')) cases.push({ id: e.id, template: e.template, data: JSON.parse(e.data), opts: { lang: 'ru', timezone: 'Europe/Moscow' }, expText: e.unavailable ? null : e.result, expErr: e.unavailable ? (/используется (\S+)/.exec(e.result)[1]) : null });
  else for (const p of require('../probes-export.json')) { if (p.convertTo && p.convertTo !== 'docx') continue;
    let expText = null; if (p.docx) expText = docxText(await readEntry(Buffer.from(p.docx, 'base64'), 'word/document.xml'));
    cases.push({ id: p.source + ':' + p.name, template: p.template, raws: p.rawXml, rels: p.rels, data: p.data, opts: Object.assign({ lang: 'ru-ru', timezone: 'Europe/Moscow' }, p.opts || {}), expText, expErr: p.error ? coreErr(p.error) : null, textPy: p.textPy }); }
  let ok = 0, bad = 0; const rows = [];
  for (const c of cases) { let got, gotErr;
    try { const out = await renderBuffer(await buildDocx(c.template, c.raws, c.rels), 'docx', c.data, c.opts); got = docxText(await readEntry(out, 'word/document.xml')); }
    catch (e) { gotErr = String(e && e.message || e); }
    let pass;
    if (c.expErr) pass = !!gotErr && (which === 'help' ? gotErr.includes('"' + c.expErr + '" is disabled') : gotErr === c.expErr);
    else if (c.expText !== null && c.expText !== undefined) pass = !gotErr && got === c.expText;
    else pass = !gotErr && c.textPy != null && got.replace(/\n/g, ' ') === c.textPy.replace(/\[|\]/g, '').replace(/\n/g, ' ');
    pass ? ok++ : bad++;
    rows.push({ id: c.id, pass, exp: c.expErr ? 'ERR ' + c.expErr : (c.expText ?? c.textPy), got: gotErr ? 'ERR ' + gotErr : got });
  }
  fs.writeFileSync(path.join(__dirname, `baseline-${which}.json`), JSON.stringify(rows, null, 1));
  console.log(`${which}: pass ${ok} fail ${bad}`);
})();
