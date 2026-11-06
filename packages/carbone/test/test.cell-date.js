// :cellDate — настоящие даты в ячейках XLSX и ODS (спецификация carbone-reports §54). Своё расширение, не функция EE.
const assert = require('assert');
const carbone = require('../lib/index');
const { renderBuffer } = carbone;
const dateFormatter = require('../formatters/date');
const { buildDocx, docxText, buildOdf, readEntry, zipBuffer } = require('./golden-lib');

const RU = { lang: 'ru', timezone: 'Europe/Moscow' };
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

// серийные номера Excel (дни от 1899-12-30): 2024-01-01 — 45292 (известное значение), 2026-03-08 — 46089
const D_2024_01_01 = 45292;
const D_2026_03_08 = 46089;

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
    { name: '_rels/.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + 'officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: XML + '<workbook xmlns="' + M + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="' + OFFICE_REL + 'worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="' + OFFICE_REL + 'sharedStrings" Target="sharedStrings.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: XML + '<sst xmlns="' + M + '">' + strings.map((s) => '<si><t xml:space="preserve">' + s + '</t></si>').join('') + '</sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: XML + '<worksheet xmlns="' + M + '"><sheetData>' + sheet + '</sheetData></worksheet>' }
  ]);
}

/**
 * Собранный XLSX → строки ячеек { t, v } (t — тип ячейки, v — содержимое <v> или null, если элемента нет);
 * текст общих строк подставляется в v.
 */
async function renderXlsx (rows, data, options) {
  const out = await renderBuffer(await xlsx(rows), 'xlsx', data, options || RU);
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

/** Собранный ODS → строки ячеек: открывающий тег и текст абзаца; content.xml шаблона и результата — правильный XML */
async function renderOds (rows, data, options, excel) {
  const template = await buildOdf('ods', odsBody(rows, excel), excel ? {} : { ns: CALCEXT_NS });
  assertWellFormed(await readEntry(template, 'content.xml'));
  const out = await renderBuffer(template, 'ods', data, options || RU);
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
  return result;
}

const serial = (v) => Number(v);
const near = (actual, expected) => assert.ok(Math.abs(serial(actual) - expected) < 1e-9, actual + ' ≠ ' + expected);

describe(':cellDate (§54)', function () {
  it('самопроверка assertWellFormed: необъявленный префикс, непарный тег, повторный атрибут', function () {
    const ok = '<a xmlns:x="u"><x:b x:c="1"/></a>';
    assertWellFormed(ok);
    assert.throws(() => assertWellFormed('<a xmlns:x="u"><x:b calcext:c="1"/></a>'), /не объявлен/);
    assert.throws(() => assertWellFormed('<a><b></a>'), /непарный/);
    assert.throws(() => assertWellFormed('<a b="1" b="2"/>'), /повторный/);
    assert.throws(() => assertWellFormed('<a b=1/>'), /сломанный/);
  });
  describe('XLSX: ячейка становится датой', function () {
    it('дата — t="n", в <v> целый серийный номер Excel, стиль ячейки сохранён', async function () {
      const { rows } = await renderXlsx([['{d.a:cellDate}', '{d.b:cellDate}']], { a: '2024-01-01', b: '2026-03-08' });
      assert.deepStrictEqual(rows, [[{ t: 'n', v: String(D_2024_01_01) }, { t: 'n', v: String(D_2026_03_08) }]]);
    });
    it('дата со временем — дробная часть: время суток в часовом поясе отчёта', async function () {
      const { rows } = await renderXlsx([['{d.a:cellDate}', '{d.b:cellDate}']], { a: '2026-03-08T23:30:00+03:00', b: '2026-03-08T12:00:00Z' });
      assert.strictEqual(rows[0][0].t, 'n');
      near(rows[0][0].v, D_2026_03_08 + 23.5 / 24);
      near(rows[0][1].v, D_2026_03_08 + 15 / 24);
    });
    it('часовой пояс отчёта: 21:00 UTC — полночь следующего дня в Москве и 21:00 того же дня в UTC', async function () {
      const data = { a: '2026-03-08T21:00:00Z' };
      const moscow = await renderXlsx([['{d.a:cellDate}']], data, { lang: 'ru', timezone: 'Europe/Moscow' });
      assert.deepStrictEqual(moscow.rows, [[{ t: 'n', v: String(D_2026_03_08 + 1) }]]);
      const utc = await renderXlsx([['{d.a:cellDate}']], data, { lang: 'ru', timezone: 'UTC' });
      near(utc.rows[0][0].v, D_2026_03_08 + 21 / 24);
    });
    it('дата без времени не сдвигается часовым поясом (и западнее UTC)', async function () {
      const { rows } = await renderXlsx([['{d.a:cellDate}']], { a: '2026-03-08' }, { lang: 'en', timezone: 'America/New_York' });
      assert.deepStrictEqual(rows, [[{ t: 'n', v: String(D_2026_03_08) }]]);
    });
    it('patternIn — входной формат, как у formatD', async function () {
      const { rows } = await renderXlsx([["{d.a:cellDate('DD.MM.YYYY')}", "{d.b:cellDate('DD.MM.YYYY HH:mm')}", "{d.c:cellDate('X')}"]],
        { a: '08.03.2026', b: '08.03.2026 18:00', c: 1772992800 });
      assert.deepStrictEqual(rows[0][0], { t: 'n', v: String(D_2026_03_08) });
      near(rows[0][1].v, D_2026_03_08 + 21 / 24);
      // 1772992800 — 2026-03-08T18:00:00Z, в Москве 21:00
      near(rows[0][2].v, D_2026_03_08 + 21 / 24);
    });
    it('пустое значение (null, пустая строка, нет поля) — ячейка без значения', async function () {
      const { rows, sheet } = await renderXlsx([['{d.a:cellDate}', '{d.b:cellDate}', '{d.c:cellDate}']], { a: null, b: '' });
      assert.deepStrictEqual(rows, [[{ t: 'n', v: null }, { t: 'n', v: null }, { t: 'n', v: null }]]);
      assert.ok(!/Invalid/.test(sheet), sheet);
    });
    it('нераспознаваемая дата — ячейка без значения, не ошибка рендера', async function () {
      const { rows, sheet } = await renderXlsx([['{d.a:cellDate}', '{d.b:cellDate}', "{d.c:cellDate('DD.MM.YYYY')}", "{d.e:cellDate('DD.MM.YYYY')}"]], { a: 'не дата', b: '2026-13-45', c: 'abc', e: '31.02.2026' });
      assert.deepStrictEqual(rows, [[{ t: 'n', v: null }, { t: 'n', v: null }, { t: 'n', v: null }, { t: 'n', v: null }]]);
      assert.ok(!/Invalid|NaN/.test(sheet), sheet);
    });
    it('цикл: каждая строка — дата, пустые и неверные значения — пустые ячейки', async function () {
      const data = { rows: [{ n: 'a', d: '2024-01-01' }, { n: 'b', d: null }, { n: 'c', d: '2026-03-08T12:00:00+03:00' }, { n: 'd', d: 'x' }, { n: 'e', d: '2026-03-08' }] };
      const { rows } = await renderXlsx([['Имя', 'Дата'], ['{d.rows[i].n}', '{d.rows[i].d:cellDate}'], ['{d.rows[i+1].n}', '{d.rows[i+1].d:cellDate}'], ['итого', '']], data);
      assert.strictEqual(rows.length, 7);
      assert.deepStrictEqual(rows.map((r) => r[0].v), ['Имя', 'a', 'b', 'c', 'd', 'e', 'итого']);
      assert.deepStrictEqual(rows.slice(1, 6).map((r) => r[1]), [
        { t: 'n', v: String(D_2024_01_01) },
        { t: 'n', v: null },
        { t: 'n', v: String(D_2026_03_08 + 0.5) },
        { t: 'n', v: null },
        { t: 'n', v: String(D_2026_03_08) }
      ]);
    });
    it('две метки в ячейке или текст рядом с меткой — ячейка остаётся текстом, дата — строкой ISO', async function () {
      const { rows } = await renderXlsx([['{d.a:cellDate} {d.b:cellDate}', 'с {d.a:cellDate}']], { a: '2026-03-08', b: '2024-01-01T10:00:00Z' });
      assert.deepStrictEqual(rows, [[{ t: 's', v: '2026-03-08 2024-01-01' }, { t: 's', v: 'с 2026-03-08' }]]);
    });
    it('cellDate не последний форматтер — ячейка остаётся текстом', async function () {
      const { rows } = await renderXlsx([["{d.a:cellDate:ifEmpty('—')}", "{d.b:cellDate:ifEmpty('—')}"]], { a: '2026-03-08', b: null });
      assert.deepStrictEqual(rows, [[{ t: 's', v: '2026-03-08' }, { t: 's', v: '—' }]]);
    });
    it('formatN рядом работает как раньше', async function () {
      const { rows } = await renderXlsx([['{d.n:formatN()}', '{d.a:cellDate}']], { n: 12.5, a: '2024-01-01' });
      assert.deepStrictEqual(rows, [[{ t: 'n', v: '12.5' }, { t: 'n', v: String(D_2024_01_01) }]]);
    });
  });

  describe('ODS: ячейка становится датой', function () {
    it('дата — office:value-type="date", office:date-value YYYY-MM-DD, calcext:value-type="date"', async function () {
      const rows = await renderOds([['{d.a:cellDate}']], { a: '2026-03-08' });
      assert.deepStrictEqual(rows, [[{ type: 'date', calc: 'date', date: '2026-03-08', text: '2026-03-08' }]]);
    });
    it('дата со временем — YYYY-MM-DDTHH:mm:ss в часовом поясе отчёта', async function () {
      const rows = await renderOds([['{d.a:cellDate}', '{d.b:cellDate}']], { a: '2026-03-08T23:30:00+03:00', b: '2026-03-08T21:00:00Z' });
      assert.deepStrictEqual(rows, [[
        { type: 'date', calc: 'date', date: '2026-03-08T23:30:00', text: '2026-03-08' },
        { type: 'date', calc: 'date', date: '2026-03-09T00:00:00', text: '2026-03-09' }
      ]]);
    });
    it('часовой пояс отчёта и patternIn', async function () {
      const rows = await renderOds([["{d.a:cellDate('DD.MM.YYYY HH:mm')}", '{d.b:cellDate}']], { a: '08.03.2026 18:00', b: '2026-03-08' }, { lang: 'en', timezone: 'America/New_York' });
      assert.deepStrictEqual(rows, [[
        { type: 'date', calc: 'date', date: '2026-03-08T14:00:00', text: '2026-03-08' }, // 8 марта 2026 в Нью-Йорке уже летнее время (UTC−4)
        { type: 'date', calc: 'date', date: '2026-03-08', text: '2026-03-08' }
      ]]);
    });
    it('ODS из Excel/Google Sheets (пространство calcext не объявлено) — calcext не добавляется, XML правильный', async function () {
      const rows = await renderOds([['{d.a:cellDate}', '{d.b:cellDate}', '{d.c:formatN()}']], { a: '2026-03-08T23:30:00+03:00', b: null, c: 1.5 }, RU, true);
      assert.deepStrictEqual(rows, [[
        { type: 'date', calc: null, date: '2026-03-08T23:30:00', text: '2026-03-08' },
        { type: null, calc: null, date: null, text: '' },
        { type: 'float', calc: null, date: null, text: '1.5' }
      ]]);
    });
    it('пустое и нераспознаваемое значение — ячейка без значения', async function () {
      const rows = await renderOds([['{d.a:cellDate}', '{d.b:cellDate}', '{d.c:cellDate}', '{d.d:cellDate}']], { a: null, b: '', d: 'не дата' });
      const empty = { type: null, calc: null, date: null, text: '' };
      assert.deepStrictEqual(rows, [[empty, empty, empty, empty]]);
    });
    it('цикл со многими строками', async function () {
      const data = { rows: [{ d: '2024-01-01' }, { d: null }, { d: '2026-03-08T12:00:00+03:00' }] };
      const rows = await renderOds([['{d.rows[i].d:cellDate}'], ['{d.rows[i+1].d:cellDate}']], data);
      assert.deepStrictEqual(rows, [
        [{ type: 'date', calc: 'date', date: '2024-01-01', text: '2024-01-01' }],
        [{ type: null, calc: null, date: null, text: '' }],
        [{ type: 'date', calc: 'date', date: '2026-03-08T12:00:00', text: '2026-03-08' }]
      ]);
    });
    it('две метки в ячейке — ячейка остаётся текстом', async function () {
      const rows = await renderOds([['{d.a:cellDate} {d.b:cellDate}']], { a: '2026-03-08', b: '2024-01-01' });
      assert.deepStrictEqual(rows, [[{ type: 'string', calc: 'string', date: null, text: '2026-03-08 2024-01-01' }]]);
    });
    it('formatN рядом работает как раньше', async function () {
      const rows = await renderOds([['{d.n:formatN()}', '{d.a:cellDate}']], { n: 12.5, a: '2026-03-08' });
      assert.strictEqual(rows[0][0].type, 'float');
      assert.deepStrictEqual(rows[0][1], { type: 'date', calc: 'date', date: '2026-03-08', text: '2026-03-08' });
    });
  });

  describe('вне таблиц — строка ISO YYYY-MM-DD', function () {
    it('DOCX: дата, дата со временем (в часовом поясе отчёта), пустое и неверное значение', async function () {
      const out = await renderBuffer(await buildDocx("{d.a:cellDate}|{d.b:cellDate}|{d.c:cellDate}|{d.d:cellDate}|{d.e:cellDate('DD.MM.YYYY')}"), 'docx',
        { a: '2026-03-08', b: '2026-03-08T21:30:00Z', c: null, d: 'x', e: '08.03.2026' }, RU);
      assert.strictEqual(await docxText(out), '2026-03-08|2026-03-09|||2026-03-08');
    });
    it('форматтер cellDate напрямую', function () {
      const ctx = { lang: 'ru', timezone: 'Europe/Moscow' };
      assert.strictEqual(dateFormatter.cellDate.call(ctx, '2026-03-08'), '2026-03-08');
      assert.strictEqual(dateFormatter.cellDate.call(ctx, '20260308'), '2026-03-08');
      assert.strictEqual(dateFormatter.cellDate.call(ctx, '2026-03-08T22:00:00Z'), '2026-03-09');
      assert.strictEqual(dateFormatter.cellDate.call(ctx, '08/03/2026', 'DD/MM/YYYY'), '2026-03-08');
      assert.strictEqual(dateFormatter.cellDate.call(ctx, null), '');
      assert.strictEqual(dateFormatter.cellDate.call(ctx, undefined), '');
      assert.strictEqual(dateFormatter.cellDate.call(ctx, ''), '');
      assert.strictEqual(dateFormatter.cellDate.call(ctx, 'abc'), '');
      assert.strictEqual(dateFormatter.cellDate.call(ctx, '2026-02-30'), '');
      // с входным форматом — строгий разбор (formatD по-прежнему нестрогий: переносит на 3 марта)
      assert.strictEqual(dateFormatter.cellDate.call(ctx, '31.02.2026', 'DD.MM.YYYY'), '');
      assert.strictEqual(dateFormatter.formatD.call(ctx, '31.02.2026', 'YYYY-MM-DD', 'DD.MM.YYYY'), '2026-03-03');
    });
  });
});
