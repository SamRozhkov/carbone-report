// Помощники тестов картинок из данных (2.4.0) и графиков (2.6.0): PNG нужного размера, картинки-заглушки
// DOCX/PPTX/XLSX/ODF, чтение результата. Вынесены из test.ee-images.js без изменений (2.6.0).
const assert = require('assert');
const zlib = require('zlib');
const yazl = require('yazl');
const { renderBuffer } = require('../lib/index');
const { buildDocx, buildOdf: buildOdfPackage, readEntry, entryNames } = require('./golden-lib');

const RU = { lang: 'ru', timezone: 'Europe/Moscow' };
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const PIC_REL = '<Relationship Id="rIdImg" Type="' + IMAGE_REL + '" Target="media/p.png"/>';

// ---------------------------------------------------------------------------------------------------------------
// картинки нужного размера

function chunk (type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Настоящий PNG w×h (RGB, чёрный); seed меняет пиксель, чтобы файлы различались */
function png (w, h, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  raw[1] = seed || 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Заголовок JPEG с размером (SOI, APP0, SOF0, EOI) — для image-size достаточно */
function jpeg (w, h) {
  return Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
}

function gif (w, h) {
  return Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, 0x3B])]);
}

/** PNG-заголовок с «хвостом» до size байт */
function bigPng (size, seed) {
  const head = png(1, 1, seed);
  const buf = Buffer.alloc(size);
  head.copy(buf);
  buf[size - 1] = seed || 0;
  return buf;
}

const uri = (type, buf) => 'data:image/' + type + ';base64,' + buf.toString('base64');

// ---------------------------------------------------------------------------------------------------------------
// шаблон

/** Картинка Word «в тексте»: метка (или текст) в descr у wp:docPr и pic:cNvPr; рамка cx×cy EMU */
function drawing (descr, opts) {
  const o = Object.assign({ cx: 2000000, cy: 2000000, rid: 'rIdImg', title: null, id: 1 }, opts);
  return '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + o.cx + '" cy="' + o.cy + '"/>'
    + '<wp:docPr id="' + o.id + '" name="Picture ' + o.id + '" descr="' + descr + '"' + (o.title !== null ? ' title="' + o.title + '"' : '') + '/>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr>'
    + '<pic:cNvPr id="0" name="p.png" descr="' + descr + '"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="' + o.rid + '"><a:extLst><a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}"/></a:extLst></a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + o.cx + '" cy="' + o.cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
}

const para = (inner) => '<w:p><w:r>' + inner + '</w:r></w:p>';

async function buildPictureDocx (raws, files) {
  return buildDocx(raws.map(() => '<<RAW>>').join('\n'), raws, PIC_REL, Object.assign({ 'word/media/p.png': png(1, 1) }, files));
}

/** r:embed всех a:blip документа по порядку */
const embeds = (doc) => [...doc.matchAll(/<a:blip r:embed="([^"]*)"/g)].map((m) => m[1]);
/** Target связи Id */
function target (rels, id) {
  const m = new RegExp('<Relationship [^>]*Id="' + id + '"[^>]*>').exec(rels);
  assert.ok(m, 'нет связи ' + id + ' в ' + rels);
  assert.ok(m[0].includes('Type="' + IMAGE_REL + '"'), m[0]);
  return /Target="([^"]*)"/.exec(m[0])[1];
}
const sizes = (doc) => [...doc.matchAll(/<(wp:extent|a:ext) cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => m[1] + ' ' + m[2] + '×' + m[3]);

/** Проверка, что XML сбалансирован (открытые и закрытые теги совпадают) */
function assertWellFormed (xml) {
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  let last = 0;
  while ((m = re.exec(xml)) !== null) {
    assert.ok(!/[<>]/.test(xml.slice(last, m.index)), 'лишний < или > перед ' + xml.slice(m.index, m.index + 40));
    last = m.index + m[0].length;
    if (m[2] === undefined) continue;
    assert.match(m[3], /^(?:\s+[^\s=<>"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*$/, 'сломан атрибут: ' + m[0]);
    if (m[1] === '/') assert.strictEqual(stack.pop(), m[2]);
    else if (m[4] !== '/') stack.push(m[2]);
  }
  assert.deepStrictEqual(stack, []);
}

// ---------------------------------------------------------------------------------------------------------------
// PPTX, XLSX, OpenDocument (Task 2 плана 2.4.0): минимальные архивы собираются здесь

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

/** zip из { имя: данные } по порядку; mimetype (ODF) — без сжатия */
function zip (files) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    const parts = [];
    z.outputStream.on('data', (c) => parts.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
    for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.from(data), name, { compress: name !== 'mimetype' });
    z.end();
  });
}

const rels = (list) => XML_HEAD + '<Relationships xmlns="' + RELS_NS + '">' + list.map(([id, type, t]) => '<Relationship Id="' + id + '" Type="' + (type.startsWith('http') ? type : OFFICE_REL + type) + '" Target="' + t + '"/>').join('') + '</Relationships>';
const types = (overrides) => XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
  + Object.entries(overrides).map(([p, t]) => '<Override PartName="' + p + '" ContentType="' + t + '"/>').join('') + '</Types>';

/** Картинка слайда PPTX; рамка cx×cy EMU в точке x,y */
function pptxPic (descr, opts) {
  const o = Object.assign({ id: 2, cx: 2000000, cy: 2000000, x: 100, y: 200, title: null, blip: '' }, opts);
  return '<p:pic><p:nvPicPr><p:cNvPr id="' + o.id + '" name="Picture ' + o.id + '" descr="' + descr + '"' + (o.title !== null ? ' title="' + o.title + '"' : '') + '/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
    + '<p:blipFill><a:blip r:embed="rIdImg"' + (o.blip ? '>' + o.blip + '</a:blip>' : '/>') + '<a:stretch><a:fillRect/></a:stretch></p:blipFill>'
    + '<p:spPr><a:xfrm><a:off x="' + o.x + '" y="' + o.y + '"/><a:ext cx="' + o.cx + '" cy="' + o.cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}

const pptxText = (text, id) => '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="T' + id + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>' + text + '</a:t></a:r></a:p></p:txBody></p:sp>';

function buildPptx (shapes) {
  const P = 'application/vnd.openxmlformats-officedocument.presentationml.';
  return zip({
    '[Content_Types].xml': types({ '/ppt/presentation.xml': P + 'presentation.main+xml', '/ppt/slides/slide1.xml': P + 'slide+xml' }),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': XML_HEAD + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' + A_NS + '><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slide', 'slides/slide1.xml']]),
    'ppt/slides/slide1.xml': XML_HEAD + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' + A_NS + '><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' + shapes.join('') + '</p:spTree></p:cSld></p:sld>',
    'ppt/slides/_rels/slide1.xml.rels': rels([['rIdImg', 'image', '../media/p.png']]),
    'ppt/media/p.png': png(1, 1)
  });
}

/** Картинка листа XLSX в привязке anchor (oneCellAnchor | twoCellAnchor | absoluteAnchor) */
function xlsxPic (descr, opts) {
  const o = Object.assign({ id: 2, cx: 2000000, cy: 2000000, anchor: 'oneCellAnchor' }, opts);
  const from = '<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>';
  const place = {
    oneCellAnchor: from + '<xdr:ext cx="' + o.cx + '" cy="' + o.cy + '"/>',
    twoCellAnchor: from + '<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>',
    absoluteAnchor: '<xdr:pos x="0" y="0"/><xdr:ext cx="' + o.cx + '" cy="' + o.cy + '"/>'
  }[o.anchor];
  return '<xdr:' + o.anchor + '>' + place
    + '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + o.id + '" name="Picture ' + o.id + '" descr="' + descr + '"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
    + '<xdr:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
    + '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + o.cx + '" cy="' + o.cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>'
    + '<xdr:clientData/></xdr:' + o.anchor + '>';
}

function buildXlsx (anchors) {
  const S = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
  const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zip({
    '[Content_Types].xml': types({
      '/xl/workbook.xml': S + 'sheet.main+xml', '/xl/worksheets/sheet1.xml': S + 'worksheet+xml',
      '/xl/sharedStrings.xml': S + 'sharedStrings+xml', '/xl/drawings/drawing1.xml': 'application/vnd.openxmlformats-officedocument.drawing+xml'
    }),
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': XML_HEAD + '<workbook ' + MAIN + '><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': rels([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'sharedStrings', 'sharedStrings.xml']]),
    'xl/sharedStrings.xml': XML_HEAD + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>{d.title}</t></si></sst>',
    'xl/worksheets/sheet1.xml': XML_HEAD + '<worksheet ' + MAIN + '><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData><drawing r:id="rId1"/></worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': rels([['rId1', 'drawing', '../drawings/drawing1.xml']]),
    'xl/drawings/drawing1.xml': XML_HEAD + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' + A_NS + '>' + anchors.join('') + '</xdr:wsDr>',
    'xl/drawings/_rels/drawing1.xml.rels': rels([['rIdImg', 'image', '../media/p.png']]),
    'xl/media/p.png': png(1, 1)
  });
}

/** Рамка ODF с картинкой; title/desc — содержимое svg:title / svg:desc (null — нет элемента) */
function odfFrame (opts) {
  const o = Object.assign({ name: 'Image1', w: '4cm', h: '4cm', title: null, desc: null, attrs: ' text:anchor-type="as-char"' }, opts);
  return '<draw:frame draw:name="' + o.name + '"' + o.attrs + ' svg:width="' + o.w + '" svg:height="' + o.h + '" draw:z-index="0">'
    + '<draw:image xlink:href="Pictures/p.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="image/png"/>'
    + (o.title !== null ? '<svg:title>' + o.title + '</svg:title>' : '') + (o.desc !== null ? '<svg:desc>' + o.desc + '</svg:desc>' : '')
    + '</draw:frame>';
}

/** ODT/ODS/ODP с картинкой Pictures/p.png (golden-lib.buildOdf) */
const buildOdf = (ext, body) => buildOdfPackage(ext, body, { files: { 'Pictures/p.png': png(1, 1) } });

const odsBody = (shapes, cell) => '<table:table table:name="S"><table:shapes>' + shapes + '</table:shapes><table:table-column/><table:table-row><table:table-cell office:value-type="string"><text:p>' + (cell || '') + '</text:p></table:table-cell></table:table-row></table:table>';
const odpBody = (frames) => '<draw:page draw:name="p1">' + frames + '</draw:page>';

async function renderAny (tpl, ext, data, options) {
  const out = await renderBuffer(tpl, ext, data, Object.assign({}, RU, options));
  const names = await entryNames(out);
  return { out, names, read: (name, binary) => readEntry(out, name, binary) };
}

/** атрибуты всех элементов name (по порядку) */
const tags = (xml, name) => [...xml.matchAll(new RegExp('<' + name + '(?=[\\s/>])[^>]*>', 'g'))].map((m) => m[0]);
const attrOf = (tag, name) => (new RegExp('\\s' + name + '="([^"]*)"').exec(tag) || [])[1];
const ids = (xml, name) => tags(xml, name).map((t) => attrOf(t, 'id'));

module.exports = {
  RU, IMAGE_REL, PIC_REL, chunk, png, jpeg, gif, bigPng, uri, drawing, para, buildPictureDocx, embeds, target, sizes,
  assertWellFormed, zip, rels, types, A_NS, XML_HEAD, RELS_NS, OFFICE_REL, pptxPic, pptxText, buildPptx, xlsxPic,
  buildXlsx, odfFrame, buildOdf, odsBody, odpBody, renderAny, tags, attrOf, ids
};
