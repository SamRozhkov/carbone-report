// Ссылки и :defaultURL (2.4.0, спецификация §32.5, решение R4 плана 2.4.0). Эталона EE нет: ожидания — по §32.5
// и справочнику docs/superpowers/notes/2026-10-10-ee-images-barcodes-colors.md §4.
const assert = require('assert');
const yazl = require('yazl');
const { renderBuffer } = require('../lib/index');
const { buildDocx, docxText, readEntry } = require('./golden-lib');

const RU = { lang: 'ru', timezone: 'Europe/Moscow' };
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');

// XML правильно вложен (стек тегов), служебных символов не осталось
function assertWellFormed (xml) {
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[2] === undefined) continue;
    // в значениях атрибутов нет сырых < и & без сущности
    for (const a of m[3].matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const v = a[1] !== undefined ? a[1] : a[2];
      assert.ok(!/</.test(v) && !/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(v), 'атрибут ' + v + ' в ' + m[0]);
    }
    // после атрибутов — только пробелы (кавычка из данных не порвала тег)
    assert.ok(/^(?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/.test(m[3]), 'тег ' + m[0]);
    if (m[4] === '/') continue;
    if (m[1] === '/') assert.strictEqual(stack.pop(), m[2], 'закрывающий </' + m[2] + '> в ' + xml);
    else stack.push(m[2]);
  }
  assert.deepStrictEqual(stack, [], 'незакрытые теги в ' + xml);
  assert.ok(!/[-]/.test(xml), 'служебный символ остался в ' + xml);
}

function zip (files) {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    const parts = [];
    z.outputStream.on('data', (c) => parts.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
    for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.from(data), name, { compress: name !== 'mimetype' });
    z.end();
  });
}

// ---------------------------------------------------------------------------------------------------------------
// DOCX: w:hyperlink + связь hyperlink в word/_rels/document.xml.rels

const LINK = '<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>ссылка</w:t></w:r></w:hyperlink></w:p>';
const rel = (target, id) => '<Relationship Id="' + (id || 'rIdL') + '" Type="' + HYPERLINK + '" Target="' + target + '" TargetMode="External"/>';

async function docx (target, data, extraRels, raws) {
  const tpl = await buildDocx('<<RAW>>' + (raws ? '\n<<RAW>>'.repeat(raws.length) : ''), [LINK].concat(raws || []), rel(target) + (extraRels || ''));
  const out = await renderBuffer(tpl, 'docx', data, RU);
  const rels = await readEntry(out, 'word/_rels/document.xml.rels');
  const doc = await readEntry(out, 'word/document.xml');
  assertWellFormed(rels);
  assertWellFormed(doc);
  return { out, rels, doc };
}

/** Target связи id как в XML и раскрытый */
function targetOf (rels, id) {
  const m = new RegExp('<Relationship [^>]*Id="' + (id || 'rIdL') + '"[^>]*>').exec(rels);
  assert.ok(m, 'нет связи в ' + rels);
  return /Target="([^"]*)"/.exec(m[0])[1];
}

async function link (value, target) {
  const r = await docx(target || '{d.url}', { url: value });
  return unesc(targetOf(r.rels));
}

describe('EE платные: ссылки — isValidUrl (§32.5)', function () {
  const isValidUrl = (u) => require('../lib/links').isValidUrl(u);
  const normalizeUrl = (u) => require('../lib/links').normalizeUrl(u);
  it('допустимые: http(s), без схемы, mailto, tel', function () {
    for (const u of ['https://example.com', 'http://x.ru', 'example.com/a', 'www.example.com', 'https://sub.example.co.uk:8080/a/b?c=1&d=2#e',
      'mailto:a@b.ru', 'mailto:a@b.ru?subject=Hi', 'tel:+79990000000', 'tel:+7 (999) 000-00-00', 'https://пример.рф/путь', '//example.com/x']) {
      assert.strictEqual(isValidUrl(u), true, u);
    }
  });
  it('недопустимые: опасные схемы, нет TLD, IP, пусто, пароль в адресе', function () {
    for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', 'ftp://example.com',
      'http://localhost', 'localhost:3000', 'http://127.0.0.1/', '10.0.0.1', 'http://[::1]/', 'not a url', '', '   ', null, undefined,
      'mailto:', 'mailto:nobody', 'tel:', 'tel:abc', 'https://', 'https://-a.com', 'https://a_b.com', 'https://example.c',
      'https://user:pass@example.com', 'https:\\\\evil.com', 'java\nscript:alert(1)', 'https://exa mple.com', 'https://a.' + 'b'.repeat(300) + '.com']) {
      assert.strictEqual(isValidUrl(u), false, JSON.stringify(u));
    }
  });
  it('normalizeUrl: https:// без схемы, пробелы и кавычки кодируются, недопустимое — null', function () {
    assert.strictEqual(normalizeUrl('example.com/a'), 'https://example.com/a');
    assert.strictEqual(normalizeUrl(' http://x.ru '), 'http://x.ru');
    assert.strictEqual(normalizeUrl('https://x.ru/a b"c<d>'), 'https://x.ru/a%20b%22c%3Cd%3E');
    assert.strictEqual(normalizeUrl('https://x.ru/%D0%B0'), 'https://x.ru/%D0%B0');
    assert.strictEqual(normalizeUrl('https://x.ru/путь'), 'https://x.ru/%D0%BF%D1%83%D1%82%D1%8C');
    assert.strictEqual(normalizeUrl('javascript:alert(1)'), null);
  });
});

describe('EE платные: ссылки — DOCX (§32.5)', function () {
  it('без схемы — https://, http/mailto/tel как есть', async function () {
    assert.strictEqual(await link('example.com/a'), 'https://example.com/a');
    assert.strictEqual(await link('http://x.ru'), 'http://x.ru');
    assert.strictEqual(await link('mailto:a@b.ru'), 'mailto:a@b.ru');
    assert.strictEqual(await link('tel:+79990000000'), 'tel:+79990000000');
  });
  it('недопустимое — #', async function () {
    for (const v of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://localhost', 'not a url', '', null, undefined]) {
      assert.strictEqual(await link(v), '#', JSON.stringify(v));
    }
  });
  it('текст ссылки в документе не меняется (эталон matrix/tests2/dynamic-hyperlink)', async function () {
    const r = await docx('{d.url}', { url: 'https://example.org/x' });
    assert.strictEqual(await docxText(r.out), 'ссылка');
    assert.strictEqual(targetOf(r.rels), 'https://example.org/x');
  });
  it(':defaultURL(\'…\') и :defaultURL(.поле): пустое или недопустимое — аргумент; допустимое — значение', async function () {
    const lit = '{d.url:defaultURL(\'https://example.com\')}';
    assert.strictEqual(await link('not a url', lit), 'https://example.com');
    assert.strictEqual(await link('', lit), 'https://example.com');
    assert.strictEqual(await link('javascript:alert(1)', lit), 'https://example.com');
    assert.strictEqual(await link('x.ru/a', lit), 'https://x.ru/a');
    const dyn = '{d.url:defaultURL(.fallback)}';
    assert.strictEqual(unesc(targetOf((await docx(dyn, { url: 'bad', fallback: 'fallback.ru' })).rels)), 'https://fallback.ru');
    assert.strictEqual(unesc(targetOf((await docx(dyn, { url: 'ok.ru', fallback: 'fallback.ru' })).rels)), 'https://ok.ru');
  });
  it(':defaultURL: недопустимый аргумент — #', async function () {
    assert.strictEqual(await link('bad', '{d.url:defaultURL(\'javascript:alert(1)\')}'), '#');
    assert.strictEqual(unesc(targetOf((await docx('{d.url:defaultURL(.fallback)}', { url: 'bad', fallback: 'data:text/html,x' })).rels)), '#');
    assert.strictEqual(unesc(targetOf((await docx('{d.url:defaultURL(.fallback)}', { url: 'bad' })).rels)), '#');
  });
  it(':defaultURL с & в аргументе (в XML — &amp;)', async function () {
    const r = await docx('{d.url:defaultURL(\'https://example.com/?a=1&amp;b=2\')}', { url: 'bad' });
    assert.strictEqual(targetOf(r.rels), 'https://example.com/?a=1&amp;b=2');
  });
  it('R4: статическая часть + метка — значение через encodeURIComponent, проверяется адрес целиком', async function () {
    const r = await docx('https://site.ru/?q={d.q}&amp;x=1', { q: 'a&b c' });
    assert.strictEqual(targetOf(r.rels), 'https://site.ru/?q=a%26b%20c&amp;x=1');
    assert.strictEqual(await link('a/b?c', 'https://site.ru/p/{d.url}'), 'https://site.ru/p/a%2Fb%3Fc');
    // метка в имени хоста: значение кодируется — подменить хост нельзя
    assert.strictEqual(await link('evil.com/x', 'https://{d.url}.example.com/'), '#');
    assert.strictEqual(await link('www', 'https://{d.url}.example.com/'), 'https://www.example.com/');
    // статическая часть недопустима — # даже с допустимым значением
    assert.strictEqual(await link('alert(1)', 'javascript:{d.url}'), '#');
  });
  it('R4: несколько меток, :defaultURL заменяет адрес целиком', async function () {
    const r = await docx('https://{d.host}/{d.path}?q={d.q}', { host: 'example.com', path: 'a b', q: '1' });
    assert.strictEqual(unesc(targetOf(r.rels)), 'https://example.com/a%20b?q=1');
    assert.strictEqual(unesc(targetOf((await docx('https://{d.host}/{d.path:defaultURL(\'https://fallback.ru\')}', { host: 'localhost', path: 'x' })).rels)), 'https://fallback.ru');
    // пустое значение метки с :defaultURL — аргумент
    assert.strictEqual(await link('', 'https://site.ru/?q={d.url:defaultURL(\'https://fallback.ru\')}'), 'https://fallback.ru');
    // без :defaultURL пустое значение в смешанном адресе — адрес из статической части
    assert.strictEqual(await link('', 'https://site.ru/?q={d.url}'), 'https://site.ru/?q=');
  });
  it('Review Focus 2: " < & \' в адресе не ломают Target', async function () {
    for (const v of ['https://x.ru/"><script>', 'x.ru/a"b', '"onclick="alert(1)', 'https://x.ru/?a=1&b=\'2\'', '<x>&amp;"']) {
      const r = await docx('{d.url}', { url: v });
      assert.strictEqual(unesc(targetOf(r.rels)).includes('"'), false, v);
    }
    assert.strictEqual(await link('https://x.ru/"><script>'), 'https://x.ru/%22%3E%3Cscript%3E');
    assert.strictEqual(await link('https://x.ru/?a=1&b=\'2\''), 'https://x.ru/?a=1&b=\'2\'');
    const r = await docx('https://site.ru/?q={d.q}', { q: '"><x a="' });
    assert.strictEqual(unesc(targetOf(r.rels)), 'https://site.ru/?q=%22%3E%3Cx%20a%3D%22');
  });
  it('значение после :show/:ifEmpty (stopPropagation) тоже проверяется', async function () {
    assert.strictEqual(await link('javascript:alert(1)', '{d.f:ifEQ(1):show(.url)}'), '#');
    const r = await docx('{d.f:ifEQ(1):show(.url)}', { f: 1, url: 'javascript:alert(1)' });
    assert.strictEqual(targetOf(r.rels), '#');
    const ok = await docx('{d.f:ifEQ(1):show(.url)}', { f: 1, url: 'x.ru' });
    assert.strictEqual(targetOf(ok.rels), 'https://x.ru');
  });
  it('статические ссылки и прочие связи не меняются; метка не в адресе ссылки не проверяется', async function () {
    const other = '<Relationship Id="rIdS" Type="' + HYPERLINK + '" Target="javascript:void(0)" TargetMode="External"/>'
      + '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="{d.url}"/>';
    const r = await docx('{d.url}', { url: 'bad' }, other);
    assert.strictEqual(targetOf(r.rels), '#');
    assert.strictEqual(targetOf(r.rels, 'rIdS'), 'javascript:void(0)');
    assert.strictEqual(targetOf(r.rels, 'rIdX'), 'bad');
  });
  it('шаблон без динамических ссылок собирается байт-в-байт', async function () {
    const tpl = await buildDocx('<<RAW>>\n{d.t}', [LINK], rel('https://static.ru/a?b=1&amp;c=2'));
    const out = await renderBuffer(tpl, 'docx', { t: 'x' }, RU);
    // CE 3.8.2 заменяет перевод строки после объявления XML пробелом — как и до 2.4.0
    assert.strictEqual(await readEntry(out, 'word/_rels/document.xml.rels'), (await readEntry(tpl, 'word/_rels/document.xml.rels')).replace('\n', ' '));
  });
  it('ошибка метки в адресе показывает метку без служебного __url', async function () {
    const tpl = await buildDocx('<<RAW>>', [LINK], rel('{d.url:nope:defaultURL(\'x.ru\')}') + rel('{d.url:nope2}', 'rIdM'));
    await assert.rejects(renderBuffer(tpl, 'docx', { url: 1 }, RU), (e) => {
      assert.match(e.message, /^Formatter "nope" does not exist\. Do you mean "[^"]*"\? Source: "\{d\.url:nope:defaultURL\('x\.ru'\)\}"$/);
      return true;
    });
    const tpl2 = await buildDocx('<<RAW>>', [LINK], rel('{d.url:nope2}'));
    await assert.rejects(renderBuffer(tpl2, 'docx', { url: 1 }, RU), /Source: "\{d\.url:nope2\}"$/);
  });
  it('метка, закодированная редактором (%7Bd.url%7D), работает', async function () {
    assert.strictEqual(await link('example.com', '%7Bd.url%7D'), 'https://example.com');
    assert.strictEqual(await link('javascript:alert(1)', '%7Bd.url%7D'), '#');
  });
  it(':defaultURL в обычном тексте — подстановка значения по умолчанию', async function () {
    const text = async (tpl, data) => docxText(await renderBuffer(await buildDocx(tpl), 'docx', data, RU));
    assert.strictEqual(await text('[{d.u:defaultURL(\'https://example.com\')}]', { u: 'not a url' }), '[https://example.com]');
    assert.strictEqual(await text('[{d.u:defaultURL(\'https://example.com\')}]', { u: 'x.ru/a' }), '[x.ru/a]');
    assert.strictEqual(await text('[{d.u:defaultURL(.f)}]', { u: '', f: 'https://f.ru' }), '[https://f.ru]');
    // аргумент в тексте не проверяется: печатается как есть
    assert.strictEqual(await text('[{d.u:defaultURL(\'нет\')}]', { u: 'javascript:alert(1)' }), '[нет]');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ODT: text:a xlink:href; XLSX: связь hyperlink листа; PPTX: a:hlinkClick

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"'
  + ' xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';

function buildOdt (body) {
  const mime = 'application/vnd.oasis.opendocument.text';
  return zip({
    mimetype: mime,
    'META-INF/manifest.xml': XML_HEAD + '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">'
      + '<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="' + mime + '"/>'
      + '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    'content.xml': XML_HEAD + '<office:document-content ' + ODF_NS + ' office:version="1.3"><office:body><office:text>' + body + '</office:text></office:body></office:document-content>'
  });
}

const hrefs = (xml) => [...xml.matchAll(/<(?:text|draw):a [^>]*xlink:href="([^"]*)"/g)].map((m) => unesc(m[1]));

describe('EE платные: ссылки — ODT (§32.5)', function () {
  async function odt (body, data) {
    const out = await renderBuffer(await buildOdt(body), 'odt', data, RU);
    const xml = await readEntry(out, 'content.xml');
    assertWellFormed(xml);
    return xml;
  }
  const a = (href) => '<text:p><text:a xlink:type="simple" xlink:href="' + href + '">ссылка</text:a></text:p>';
  it('text:a: проверка, https://, #, :defaultURL', async function () {
    assert.deepStrictEqual(hrefs(await odt(a('{d.a}') + a('{d.b}') + a('{d.c:defaultURL(\'https://f.ru\')}') + a('https://static.ru/?a=1&amp;b=2'),
      { a: 'example.com', b: 'javascript:alert(1)', c: 'data:x' })), ['https://example.com', '#', 'https://f.ru', 'https://static.ru/?a=1&b=2']);
  });
  it('R4 и кавычка в значении', async function () {
    const xml = await odt(a('https://site.ru/?q={d.q}') + a('{d.u}'), { q: 'a&b c', u: 'x.ru/"<>' });
    assert.ok(xml.includes('xlink:href="https://site.ru/?q=a%26b%20c"'), xml);
    assert.deepStrictEqual(hrefs(xml), ['https://site.ru/?q=a%26b%20c', 'https://x.ru/%22%3C%3E']);
  });
  it('ссылки в цикле: у каждой строки своя проверка', async function () {
    const xml = await odt('<text:p><text:a xlink:href="{d.list[i].u}">{d.list[i].t}</text:a></text:p><text:p><text:a xlink:href="{d.list[i+1].u}">{d.list[i+1].t}</text:a></text:p>',
      { list: [{ u: 'a.ru', t: '1' }, { u: 'javascript:x', t: '2' }, { u: 'mailto:a@b.ru', t: '3' }] });
    assert.deepStrictEqual(hrefs(xml), ['https://a.ru', '#', 'mailto:a@b.ru']);
  });
  it('draw:a и %7B…%7D от редактора', async function () {
    const xml = await odt('<text:p><draw:a xlink:href="%7Bd.u%7D"><draw:frame/></draw:a></text:p>', { u: 'example.com' });
    assert.deepStrictEqual(hrefs(xml), ['https://example.com']);
  });
});

describe('EE платные: ссылки — XLSX, PPTX (§32.5)', function () {
  const rels = (list) => XML_HEAD + '<Relationships xmlns="' + RELS_NS + '">' + list.join('') + '</Relationships>';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const typesXml = (o) => XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + Object.entries(o).map(([p, t]) => '<Override PartName="' + p + '" ContentType="' + t + '"/>').join('') + '</Types>';
  it('XLSX: гиперссылка ячейки — связь листа', async function () {
    const S = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
    const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const tpl = await zip({
      '[Content_Types].xml': typesXml({ '/xl/workbook.xml': S + 'sheet.main+xml', '/xl/worksheets/sheet1.xml': S + 'worksheet+xml' }),
      '_rels/.rels': rels(['<Relationship Id="rId1" Type="' + R + 'officeDocument" Target="xl/workbook.xml"/>']),
      'xl/workbook.xml': XML_HEAD + '<workbook ' + MAIN + '><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': rels(['<Relationship Id="rId1" Type="' + R + 'worksheet" Target="worksheets/sheet1.xml"/>']),
      'xl/worksheets/sheet1.xml': XML_HEAD + '<worksheet ' + MAIN + '><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ссылка</t></is></c><c r="B1" t="inlineStr"><is><t>ещё</t></is></c></row></sheetData>'
        + '<hyperlinks><hyperlink ref="A1" r:id="rId1"/><hyperlink ref="B1" r:id="rId2"/></hyperlinks></worksheet>',
      'xl/worksheets/_rels/sheet1.xml.rels': rels([rel('{d.a}', 'rId1'), rel('%7Bd.b%7D', 'rId2')])
    });
    const out = await renderBuffer(tpl, 'xlsx', { a: 'example.com/x', b: 'javascript:alert(1)' }, RU);
    const sheetRels = await readEntry(out, 'xl/worksheets/_rels/sheet1.xml.rels');
    assertWellFormed(sheetRels);
    assert.strictEqual(targetOf(sheetRels, 'rId1'), 'https://example.com/x');
    assert.strictEqual(targetOf(sheetRels, 'rId2'), '#');
  });
  it('PPTX: a:hlinkClick — связь слайда', async function () {
    const P = 'application/vnd.openxmlformats-officedocument.presentationml.';
    const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const tpl = await zip({
      '[Content_Types].xml': typesXml({ '/ppt/presentation.xml': P + 'presentation.main+xml', '/ppt/slides/slide1.xml': P + 'slide+xml' }),
      '_rels/.rels': rels(['<Relationship Id="rId1" Type="' + R + 'officeDocument" Target="ppt/presentation.xml"/>']),
      'ppt/presentation.xml': XML_HEAD + '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' + A_NS + '><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
      'ppt/_rels/presentation.xml.rels': rels(['<Relationship Id="rId1" Type="' + R + 'slide" Target="slides/slide1.xml"/>']),
      'ppt/slides/slide1.xml': XML_HEAD + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' + A_NS + '><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
        + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:hlinkClick r:id="rIdL"/></a:rPr><a:t>ссылка</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
      'ppt/slides/_rels/slide1.xml.rels': rels([rel('{d.u}')])
    });
    const out = await renderBuffer(tpl, 'pptx', { u: 'tel:+7 999 000-00-00' }, RU);
    const slideRels = await readEntry(out, 'ppt/slides/_rels/slide1.xml.rels');
    assertWellFormed(slideRels);
    assert.strictEqual(targetOf(slideRels), 'tel:+7%20999%20000-00-00');
  });
});
