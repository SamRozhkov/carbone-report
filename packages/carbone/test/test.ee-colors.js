// Цвета :color(scope, type) (2.4.0, спецификация §32.4, решение R5 плана 2.4.0). Эталона EE нет: ожидания — по §32.4
// и справочнику docs/superpowers/notes/2026-10-10-ee-images-barcodes-colors.md §3.
const assert = require('assert');
const carbone = require('../lib/index');
const { renderBuffer } = carbone;
const { buildDocx, docxText, readEntry } = require('./golden-lib');

const RU = { lang: 'ru', timezone: 'Europe/Moscow' };

function renderAs (extension, xml, data) {
  return new Promise((resolve, reject) => carbone.renderXML(xml, data, { extension }, (err, res) => err ? reject(err) : resolve(res)));
}

async function renderError (extension, xml, data) {
  try {
    await renderAs(extension, xml, data);
  }
  catch (e) {
    return e.message;
  }
  throw new Error('ожидалась ошибка');
}

// XML правильно вложен (без парсера: стек тегов), жетонов не осталось
function assertWellFormed (xml) {
  const stack = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([^\s/>!?]+)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[2] === undefined || m[3] === '/') continue;
    if (m[1] === '/') assert.strictEqual(stack.pop(), m[2], 'закрывающий </' + m[2] + '> в ' + xml);
    else stack.push(m[2]);
  }
  assert.deepStrictEqual(stack, [], 'незакрытые теги в ' + xml);
  assert.ok(!/[-]/.test(xml), 'жетон остался в ' + xml);
}

async function ok (extension, xml, data) {
  const out = await renderAs(extension, xml, data);
  assertWellFormed(out);
  return out;
}

const C = { c: '#ff0000' };

// ---------------------------------------------------------------------------------------------------------------
// DOCX

const wr = (t, rPr) => '<w:r>' + (rPr !== undefined ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:t>' + t + '</w:t></w:r>';
const wp = (inner, pPr) => '<w:p>' + (pPr !== undefined ? '<w:pPr>' + pPr + '</w:pPr>' : '') + inner + '</w:p>';
const body = (inner) => '<w:document><w:body>' + inner + '</w:body></w:document>';

describe('EE платные: :color — DOCX (§32.4)', function () {
  it('p/text: w:color во всех w:rPr абзаца, w:rPr создаётся, порядок дочерних по схеме', async function () {
    const out = await ok('docx', body(wp(wr('{d.c:color(p, text)}А') + wr('Б', '<w:b/><w:color w:val="00FF00" w:themeColor="accent1"/><w:sz w:val="20"/>') + wr('В', '<w:b/><w:sz w:val="20"/>'))), C);
    assert.strictEqual(out, body(wp(wr('А', '<w:color w:val="FF0000"/>') + wr('Б', '<w:b/><w:color w:val="FF0000"/><w:sz w:val="20"/>') + wr('В', '<w:b/><w:color w:val="FF0000"/><w:sz w:val="20"/>'))));
  });
  it('p по умолчанию, text по умолчанию; знак абзаца в существующем w:pPr тоже красится', async function () {
    const out = await ok('docx', body(wp(wr('{d.c:color}А'), '<w:jc w:val="center"/>') + wp(wr('чужой'))), C);
    assert.strictEqual(out, body(wp(wr('А', '<w:color w:val="FF0000"/>'), '<w:jc w:val="center"/><w:rPr><w:color w:val="FF0000"/></w:rPr>') + wp(wr('чужой'))));
  });
  it('p/background → w:pPr/w:shd (w:pPr создаётся первым дочерним)', async function () {
    const out = await ok('docx', body(wp(wr('{d.c:color(p, background)}А'))), C);
    assert.strictEqual(out, body(wp(wr('А'), '<w:shd w:val="clear" w:color="auto" w:fill="FF0000"/>')));
  });
  it('p/background: w:shd по схеме перед w:jc, существующий w:shd заменяется', async function () {
    assert.strictEqual(await ok('docx', body(wp(wr('{d.c:color(p, background)}А'), '<w:pStyle w:val="a"/><w:jc w:val="left"/>')), C),
      body(wp(wr('А'), '<w:pStyle w:val="a"/><w:shd w:val="clear" w:color="auto" w:fill="FF0000"/><w:jc w:val="left"/>')));
    assert.strictEqual(await ok('docx', body(wp(wr('{d.c:color(p, background)}А'), '<w:shd w:val="clear" w:fill="00FF00"/>')), C),
      body(wp(wr('А'), '<w:shd w:val="clear" w:color="auto" w:fill="FF0000"/>')));
  });
  const tc = (inner, tcPr) => '<w:tc>' + (tcPr !== undefined ? '<w:tcPr>' + tcPr + '</w:tcPr>' : '') + inner + '</w:tc>';
  const tbl = (...rows) => '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1"/><w:gridCol w:w="1"/></w:tblGrid>' + rows.map((r) => '<w:tr>' + r + '</w:tr>').join('') + '</w:tbl>';
  it('cell/background → w:tcPr/w:shd (после w:tcW, создаётся при отсутствии)', async function () {
    const out = await ok('docx', body(tbl(tc(wp(wr('{d.c:color(cell, background)}А')), '<w:tcW w:w="1" w:type="dxa"/><w:vAlign w:val="top"/>') + tc(wp(wr('Б'))))), C);
    assert.strictEqual(out, body(tbl(tc(wp(wr('А')), '<w:tcW w:w="1" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="FF0000"/><w:vAlign w:val="top"/>') + tc(wp(wr('Б'))))));
    const out2 = await ok('docx', body(tbl(tc(wp(wr('{d.c:color(cell, background)}А'))) + tc(wp(wr('Б'))))), C);
    assert.strictEqual(out2, body(tbl(tc(wp(wr('А')), '<w:shd w:val="clear" w:color="auto" w:fill="FF0000"/>') + tc(wp(wr('Б'))))));
  });
  it('row/background — во всех ячейках строки; row/text — все абзацы строки', async function () {
    const out = await ok('docx', body(tbl(tc(wp(wr('{d.c:color(row, background)}А'))) + tc(wp(wr('Б'))), tc(wp(wr('В'))) + tc(wp(wr('Г'))))), C);
    const shd = '<w:shd w:val="clear" w:color="auto" w:fill="FF0000"/>';
    assert.strictEqual(out, body(tbl(tc(wp(wr('А')), shd) + tc(wp(wr('Б')), shd), tc(wp(wr('В'))) + tc(wp(wr('Г'))))));
    const out2 = await ok('docx', body(tbl(tc(wp(wr('{d.c:color(row)}А'))) + tc(wp(wr('Б'))), tc(wp(wr('В'))) + tc(wp(wr('Г'))))), C);
    const red = '<w:color w:val="FF0000"/>';
    assert.strictEqual(out2, body(tbl(tc(wp(wr('А', red))) + tc(wp(wr('Б', red))), tc(wp(wr('В'))) + tc(wp(wr('Г'))))));
  });
  it('highlight, shape, part, border — ошибки шаблона с Source', async function () {
    assert.strictEqual(await renderError('docx', body(wp(wr('{d.c:color(p, highlight)}'))), C),
      'color(p, highlight) не поддерживается в DOCX. Для p доступно: text, background. Source: "{d.c:color(p,highlight)}"');
    assert.strictEqual(await renderError('docx', body(wp(wr('{d.c:color(part)}'))), C),
      'color(part) работает только в ODT. Source: "{d.c:color(part)}"');
    assert.strictEqual(await renderError('docx', body(wp(wr('{d.c:color(shape, background)}'))), C),
      'color(shape) не поддерживается в DOCX. Доступно: p, cell, row. Source: "{d.c:color(shape,background)}"');
    assert.strictEqual(await renderError('docx', body(wp(wr('{d.c:color(p, border)}'))), C),
      'color(p, border): рамка (border) задаётся только для фигур — color(shape, border). Source: "{d.c:color(p,border)}"');
    assert.match(await renderError('docx', body(wp(wr('{d.c:color(x)}'))), C), /^color: неизвестная область «x»\. Доступно: p, cell, row, shape, part\. Source: /);
    assert.match(await renderError('docx', body(wp(wr('{d.c:color(p, bold)}'))), C), /^color: неизвестный тип «bold»\. Доступно: text, highlight, background, border\. Source: /);
    assert.match(await renderError('docx', body(wp(wr('{d.c:color(p, text, 1)}'))), C), /^У color не больше двух аргументов/);
    assert.match(await renderError('docx', body(wp(wr('{d.c:color(p):upperCase}'))), C), /^color должен быть последним форматтером метки/);
  });
  it('cell вне таблицы — ошибка «метка должна стоять в ячейке таблицы»', async function () {
    assert.strictEqual(await renderError('docx', body(wp(wr('{d.c:color(cell, background)}'))), C),
      'Для color(cell) метка должна стоять в ячейке таблицы. Source: "{d.c:color(cell,background)}"');
  });
});

describe('EE платные: :color — значение цвета', function () {
  const red = (v) => ok('docx', body(wp(wr('{d.c:color}А'))), { c: v });
  const expectColor = (hex) => body(wp(wr('А', '<w:color w:val="' + hex + '"/>')));
  for (const [v, hex] of [['#ff0000', 'FF0000'], ['FF0000', 'FF0000'], ['#a1B2c3', 'A1B2C3'], ['red', '888888'], ['#12345', '888888'], [null, '888888'], [undefined, '888888'], ['#ff00001', '888888']]) {
    it(JSON.stringify(v) + ' → ' + hex, async function () {
      assert.strictEqual(await red(v), expectColor(hex));
    });
  }
  it('тег ничего не печатает', async function () {
    assert.strictEqual(await docxText(await renderBuffer(await buildDocx('[{d.c:color(p)}цветной]'), 'docx', C, RU)), '[цветной]');
  });
  it('цикл: каждая строка таблицы своим цветом из .color (DOCX через renderBuffer)', async function () {
    const tpl = await buildDocx('| {d.rows[i].name}{d.rows[i].color:color(row, background)} |\n| {d.rows[i+1].name} |');
    const out = await renderBuffer(tpl, 'docx', { rows: [{ name: 'a', color: '#111111' }, { name: 'b', color: '222222' }, { name: 'c', color: 'нет' }] }, RU);
    const doc = await readEntry(out, 'word/document.xml');
    const rows = [...doc.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((m) => [...m[0].matchAll(/w:fill="([0-9A-F]{6})"/g)].map((x) => x[1]).join(','));
    assert.deepStrictEqual(rows, ['111111', '222222', '888888']);
    assert.strictEqual(await docxText(out), '| a |\n| b |\n| c |');
  });
});

describe('EE платные: :color — bindColor без изменений', function () {
  it('bindColor удаляется, цвет не меняется', async function () {
    const out = await ok('docx', body(wp(wr('{bindColor(ff0000, #hexa) = d.c}А', '<w:color w:val="FF0000"/>'))), { c: '00ff00' });
    assert.strictEqual(out, body(wp(wr('А', '<w:color w:val="FF0000"/>'))));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// XLSX / ODS

describe('EE платные: :color — XLSX/ODS', function () {
  it('XLSX и ODS — ошибка «color не поддерживается в XLSX/ODS»', async function () {
    assert.strictEqual(await renderError('xlsx', '<sheetData><row><c><is><t>{d.c:color(cell, background)}</t></is></c></row></sheetData>', C),
      'color не поддерживается в XLSX/ODS Source: "{d.c:color(cell,background)}"');
    assert.strictEqual(await renderError('ods', '<table:table-row><table:table-cell><text:p>{d.c:color}</text:p></table:table-cell></table:table-row>', C),
      'color не поддерживается в XLSX/ODS Source: "{d.c:color}"');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// PPTX

const pr = (t, rPr) => '<a:r>' + (rPr !== undefined ? rPr : '') + '<a:t>' + t + '</a:t></a:r>';
const sp = (inner, spPr) => '<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' + (spPr !== undefined ? spPr : '<p:spPr/>') + '<p:txBody><a:bodyPr/>' + inner + '</p:txBody></p:sp>';
const sld = (inner) => '<p:sld><p:cSld><p:spTree>' + inner + '</p:spTree></p:cSld></p:sld>';
const fill = (hex) => '<a:solidFill><a:srgbClr val="' + hex + '"/></a:solidFill>';

describe('EE платные: :color — PPTX (§32.4)', function () {
  it('p/text → a:rPr/a:solidFill во всех прогонах абзаца (a:rPr создаётся; заливка заменяется; перед a:latin)', async function () {
    const out = await ok('pptx', sld(sp('<a:p>' + pr('{d.c:color(p, text)}А') + pr('Б', '<a:rPr lang="ru-RU" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="Arial"/></a:rPr>') + '<a:endParaRPr lang="ru-RU"/></a:p><a:p>' + pr('чужой') + '</a:p>')), C);
    assert.strictEqual(out, sld(sp('<a:p>' + pr('А', '<a:rPr>' + fill('FF0000') + '</a:rPr>') + pr('Б', '<a:rPr lang="ru-RU" b="1">' + fill('FF0000') + '<a:latin typeface="Arial"/></a:rPr>') + '<a:endParaRPr lang="ru-RU">' + fill('FF0000') + '</a:endParaRPr></a:p><a:p>' + pr('чужой') + '</a:p>')));
  });
  it('p/highlight → a:highlight после заливки', async function () {
    const out = await ok('pptx', sld(sp('<a:p>' + pr('{d.c:color(p, highlight)}А', '<a:rPr>' + fill('00FF00') + '<a:latin typeface="Arial"/></a:rPr>') + '</a:p>')), C);
    assert.strictEqual(out, sld(sp('<a:p>' + pr('А', '<a:rPr>' + fill('00FF00') + '<a:highlight><a:srgbClr val="FF0000"/></a:highlight><a:latin typeface="Arial"/></a:rPr>') + '</a:p>')));
  });
  it('shape/background → p:spPr/a:solidFill (после геометрии, вместо прежней заливки)', async function () {
    const spPr = '<p:spPr><a:xfrm><a:off x="0" y="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="1"/></p:spPr>';
    const out = await ok('pptx', sld(sp('<a:p>' + pr('{d.c:color(shape, background)}А') + '</a:p>', spPr)), C);
    assert.strictEqual(out, sld(sp('<a:p>' + pr('А') + '</a:p>', spPr.replace('<a:noFill/>', fill('FF0000')))));
    const out2 = await ok('pptx', sld(sp('<a:p>' + pr('{d.c:color(shape, background)}А') + '</a:p>')), C);
    assert.strictEqual(out2, sld(sp('<a:p>' + pr('А') + '</a:p>', '<p:spPr>' + fill('FF0000') + '</p:spPr>')));
  });
  it('shape/border → p:spPr/a:ln/a:solidFill (a:ln создаётся или дополняется)', async function () {
    const out = await ok('pptx', sld(sp('<a:p>' + pr('{d.c:color(shape, border)}А') + '</a:p>', '<p:spPr><a:prstGeom prst="rect"/><a:ln w="12700"><a:prstDash val="dash"/></a:ln></p:spPr>')), C);
    assert.strictEqual(out, sld(sp('<a:p>' + pr('А') + '</a:p>', '<p:spPr><a:prstGeom prst="rect"/><a:ln w="12700">' + fill('FF0000') + '<a:prstDash val="dash"/></a:ln></p:spPr>')));
    const out2 = await ok('pptx', sld(sp('<a:p>' + pr('{d.c:color(shape, border)}А') + '</a:p>', '<p:spPr><a:prstGeom prst="rect"/><a:effectLst/></p:spPr>')), C);
    assert.strictEqual(out2, sld(sp('<a:p>' + pr('А') + '</a:p>', '<p:spPr><a:prstGeom prst="rect"/><a:ln>' + fill('FF0000') + '</a:ln><a:effectLst/></p:spPr>')));
  });
  it('метка в замещающем тексте фигуры (descr) тоже относится к фигуре', async function () {
    const out = await ok('pptx', sld('<p:sp><p:nvSpPr><p:cNvPr id="2" name="S" descr="{d.c:color(shape, background)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>'), C);
    assert.strictEqual(out, sld('<p:sp><p:nvSpPr><p:cNvPr id="2" name="S" descr=""/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>' + fill('FF0000') + '</p:spPr></p:sp>'));
  });
  it('cell/background → a:tcPr после a:txBody; row — каждая ячейка', async function () {
    const tc = (t, tcPr) => '<a:tc><a:txBody><a:bodyPr/><a:p>' + pr(t) + '</a:p></a:txBody>' + (tcPr || '') + '</a:tc>';
    const tbl = (...rows) => '<p:graphicFrame><a:graphic><a:graphicData><a:tbl>' + rows.map((r) => '<a:tr h="1">' + r + '</a:tr>').join('') + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
    const out = await ok('pptx', sld(tbl(tc('{d.c:color(cell, background)}А', '<a:tcPr marL="1"><a:lnL/></a:tcPr>') + tc('Б'))), C);
    assert.strictEqual(out, sld(tbl(tc('А', '<a:tcPr marL="1"><a:lnL/>' + fill('FF0000') + '</a:tcPr>') + tc('Б'))));
    const out2 = await ok('pptx', sld(tbl(tc('{d.c:color(row, background)}А') + tc('Б'), tc('В'))), C);
    const cell = '<a:tcPr>' + fill('FF0000') + '</a:tcPr>';
    assert.strictEqual(out2, sld(tbl(tc('А', cell) + tc('Б', cell), tc('В'))));
  });
  it('p/background и part — ошибки', async function () {
    assert.match(await renderError('pptx', sld(sp('<a:p>' + pr('{d.c:color(p, background)}') + '</a:p>')), C), /^color\(p, background\) не поддерживается в PPTX\. Для p доступно: text, highlight\. Source: /);
    assert.match(await renderError('pptx', sld(sp('<a:p>' + pr('{d.c:color(part)}') + '</a:p>')), C), /^color\(part\) работает только в ODT\./);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ODT / ODP (R5: автоматический стиль CRc<n> с родителем — исходным стилем)

const odt = (styles, inner) => '<office:document-content><office:automatic-styles>' + styles + '</office:automatic-styles><office:body><office:text>' + inner + '</office:text></office:body></office:document-content>';

describe('EE платные: :color — ODT (§32.4, R5)', function () {
  it('p/text: стиль CRc1 с родителем — общим стилем; абзац ссылается на него', async function () {
    const out = await ok('odt', odt('', '<text:p text:style-name="Standard">{d.c:color(p)}А</text:p><text:p text:style-name="Standard">Б</text:p>'), C);
    assert.strictEqual(out, odt('<style:style style:name="CRc1" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:color="#ff0000"/></style:style>',
      '<text:p text:style-name="CRc1">А</text:p><text:p text:style-name="Standard">Б</text:p>'));
  });
  it('p/highlight → fo:background-color в text-properties; p/background → в paragraph-properties', async function () {
    const out = await ok('odt', odt('', '<text:p text:style-name="Standard">{d.c:color(p, highlight)}А</text:p>'), C);
    assert.strictEqual(out, odt('<style:style style:name="CRc1" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:background-color="#ff0000"/></style:style>', '<text:p text:style-name="CRc1">А</text:p>'));
    const out2 = await ok('odt', odt('', '<text:h text:style-name="Heading_20_1" text:outline-level="1">{d.c:color(p, background)}А</text:h>'), C);
    assert.strictEqual(out2, odt('<style:style style:name="CRc1" style:family="paragraph" style:parent-style-name="Heading_20_1"><style:paragraph-properties fo:background-color="#ff0000"/></style:style>', '<text:h text:style-name="CRc1" text:outline-level="1">А</text:h>'));
  });
  it('исходный автоматический стиль клонируется (свойства сохраняются, родитель — его родитель); без стиля — без родителя', async function () {
    const p1 = '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-weight="bold" fo:color="#00ff00"/></style:style>';
    const out = await ok('odt', odt(p1, '<text:p text:style-name="P1">{d.c:color(p)}А</text:p><text:p>{d.c:color(p, background)}Б</text:p>'), C);
    assert.strictEqual(out, odt(p1
      + '<style:style style:name="CRc1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-weight="bold" fo:color="#ff0000"/></style:style>'
      + '<style:style style:name="CRc2" style:family="paragraph"><style:paragraph-properties fo:background-color="#ff0000"/></style:style>',
    '<text:p text:style-name="CRc1">А</text:p><text:p text:style-name="CRc2">Б</text:p>'));
  });
  it('p/text красит и фрагменты текста абзаца со своим стилем', async function () {
    const t1 = '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>';
    const out = await ok('odt', odt(t1, '<text:p text:style-name="Standard">{d.c:color}А<text:span text:style-name="T1">Б</text:span></text:p>'), C);
    assert.strictEqual(out, odt(t1
      + '<style:style style:name="CRc1" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:color="#ff0000"/></style:style>'
      + '<style:style style:name="CRc2" style:family="text"><style:text-properties fo:font-style="italic" fo:color="#ff0000"/></style:style>',
    '<text:p text:style-name="CRc1">А<text:span text:style-name="CRc2">Б</text:span></text:p>'));
  });
  it('part — ближайший text:span; без него — ошибка', async function () {
    const out = await ok('odt', odt('', '<text:p text:style-name="Standard">А<text:span text:style-name="Emphasis">{d.c:color(part)}Б</text:span>В</text:p>'), C);
    assert.strictEqual(out, odt('<style:style style:name="CRc1" style:family="text" style:parent-style-name="Emphasis"><style:text-properties fo:color="#ff0000"/></style:style>',
      '<text:p text:style-name="Standard">А<text:span text:style-name="CRc1">Б</text:span>В</text:p>'));
    assert.strictEqual(await renderError('odt', odt('', '<text:p>{d.c:color(part)}Б</text:p>'), C),
      'Для color(part) метка должна стоять внутри фрагмента текста со своим стилем (text:span). Source: "{d.c:color(part)}"');
  });
  it('cell/background → table-cell-properties; row — каждая ячейка; одинаковые стили не дублируются', async function () {
    const row = (a, b) => '<table:table-row><table:table-cell table:style-name="A1"><text:p>' + a + '</text:p></table:table-cell><table:table-cell table:style-name="A1"><text:p>' + b + '</text:p></table:table-cell></table:table-row>';
    const out = await ok('odt', odt('', '<table:table>' + row('{d.c:color(row, background)}А', 'Б') + row('В', '{d.c:color(cell, background)}Г') + '</table:table>'), C);
    const cell = (t, s) => '<table:table-cell table:style-name="' + s + '"><text:p>' + t + '</text:p></table:table-cell>';
    assert.strictEqual(out, odt('<style:style style:name="CRc1" style:family="table-cell" style:parent-style-name="A1"><style:table-cell-properties fo:background-color="#ff0000"/></style:style>',
      '<table:table><table:table-row>' + cell('А', 'CRc1') + cell('Б', 'CRc1') + '</table:table-row><table:table-row>' + cell('В', 'A1') + cell('Г', 'CRc1') + '</table:table-row></table:table>'));
  });
  it('цикл: каждая строка своим цветом, имя CRc<n> не совпадает с существующим', async function () {
    const tpl = odt('<style:style style:name="CRc1" style:family="paragraph"/>', '<table:table><table:table-row><table:table-cell><text:p>{d.r[i].n}{d.r[i].c:color(row, background)}</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>{d.r[i+1].n}</text:p></table:table-cell></table:table-row></table:table>');
    const out = await ok('odt', tpl, { r: [{ n: 'a', c: '#111111' }, { n: 'b', c: '#222222' }, { n: 'c', c: '#111111' }] });
    assert.strictEqual(out, odt('<style:style style:name="CRc1" style:family="paragraph"/>'
      + '<style:style style:name="CRc2" style:family="table-cell"><style:table-cell-properties fo:background-color="#111111"/></style:style>'
      + '<style:style style:name="CRc3" style:family="table-cell"><style:table-cell-properties fo:background-color="#222222"/></style:style>',
    '<table:table>' + ['a:CRc2', 'b:CRc3', 'c:CRc2'].map((x) => '<table:table-row><table:table-cell table:style-name="' + x.split(':')[1] + '"><text:p>' + x.split(':')[0] + '</text:p></table:table-cell></table:table-row>').join('') + '</table:table>'));
  });
  it('shape/background → graphic-properties draw:fill; border — ошибка', async function () {
    const frame = (s, t) => '<draw:custom-shape draw:style-name="' + s + '"><text:p>' + t + '</text:p></draw:custom-shape>';
    const out = await ok('odt', odt('', '<text:p>' + frame('gr1', '{d.c:color(shape, background)}А') + '</text:p>'), C);
    assert.strictEqual(out, odt('<style:style style:name="CRc1" style:family="graphic" style:parent-style-name="gr1"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff0000"/></style:style>', '<text:p>' + frame('CRc1', 'А') + '</text:p>'));
    assert.match(await renderError('odt', odt('', frame('gr1', '{d.c:color(shape, border)}')), C), /^color\(shape, border\) не поддерживается в ODT\. Для shape доступно: text, highlight, background\. Source: /);
  });
  it('нет office:automatic-styles — создаётся перед office:body', async function () {
    const out = await ok('odt', '<office:document-content><office:body><office:text><text:p>{d.c:color}А</text:p></office:text></office:body></office:document-content>', C);
    assert.strictEqual(out, '<office:document-content><office:automatic-styles><style:style style:name="CRc1" style:family="paragraph"><style:text-properties fo:color="#ff0000"/></style:style></office:automatic-styles><office:body><office:text><text:p text:style-name="CRc1">А</text:p></office:text></office:body></office:document-content>');
  });
  it('ODT целиком (renderBuffer): content.xml со стилем и ссылкой', async function () {
    const yazl = require('yazl');
    const zip = (files) => new Promise((resolve, reject) => {
      const z = new yazl.ZipFile();
      const parts = [];
      z.outputStream.on('data', (c) => parts.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
      for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.from(data), name, { compress: name !== 'mimetype' });
      z.end();
    });
    const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
    const tpl = await zip({
      mimetype: 'application/vnd.oasis.opendocument.text',
      'META-INF/manifest.xml': '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
      'content.xml': '<?xml version="1.0" encoding="UTF-8"?><office:document-content ' + NS + ' office:version="1.3"><office:automatic-styles/><office:body><office:text><text:p text:style-name="Standard">{d.c:color(p, text)}Красный</text:p></office:text></office:body></office:document-content>'
    });
    const content = await readEntry(await renderBuffer(tpl, 'odt', C, RU), 'content.xml');
    assertWellFormed(content);
    assert.ok(content.includes('<office:automatic-styles><style:style style:name="CRc1" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:color="#ff0000"/></style:style></office:automatic-styles>'), content);
    assert.ok(content.includes('<text:p text:style-name="CRc1">Красный</text:p>'), content);
  });
});

describe('EE платные: :color — ODP (§32.4)', function () {
  const odp = (styles, inner) => '<office:document-content><office:automatic-styles>' + styles + '</office:automatic-styles><office:body><office:presentation><draw:page>' + inner + '</draw:page></office:presentation></office:body></office:document-content>';
  it('shape/background: стиль презентации (presentation:style-name) или графический', async function () {
    const out = await ok('odp', odp('', '<draw:frame presentation:style-name="pr1" presentation:class="title"><draw:text-box><text:p>{d.c:color(shape, background)}А</text:p></draw:text-box></draw:frame>'
      + '<draw:custom-shape draw:style-name="gr1"><text:p>{d.c:color(shape, background)}Б</text:p></draw:custom-shape>'), C);
    assert.strictEqual(out, odp('<style:style style:name="CRc1" style:family="presentation" style:parent-style-name="pr1"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff0000"/></style:style>'
      + '<style:style style:name="CRc2" style:family="graphic" style:parent-style-name="gr1"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff0000"/></style:style>',
    '<draw:frame presentation:style-name="CRc1" presentation:class="title"><draw:text-box><text:p>А</text:p></draw:text-box></draw:frame><draw:custom-shape draw:style-name="CRc2"><text:p>Б</text:p></draw:custom-shape>'));
  });
  it('shape/text — абзацы фигуры; part — только ODT', async function () {
    const out = await ok('odp', odp('', '<draw:custom-shape draw:style-name="gr1"><text:p text:style-name="P1">{d.c:color(shape)}А</text:p><text:p>Б</text:p></draw:custom-shape>'), C);
    assert.strictEqual(out, odp('<style:style style:name="CRc1" style:family="paragraph" style:parent-style-name="P1"><style:text-properties fo:color="#ff0000"/></style:style>'
      + '<style:style style:name="CRc2" style:family="paragraph"><style:text-properties fo:color="#ff0000"/></style:style>',
    '<draw:custom-shape draw:style-name="gr1"><text:p text:style-name="CRc1">А</text:p><text:p text:style-name="CRc2">Б</text:p></draw:custom-shape>'));
    assert.match(await renderError('odp', odp('', '<text:p><text:span text:style-name="T1">{d.c:color(part)}</text:span></text:p>'), C), /^color\(part\) работает только в ODT\./);
  });
});
