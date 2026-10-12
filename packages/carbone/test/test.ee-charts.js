// Диаграммы DOCX/XLSX (2.5.0, спецификация §34.2): чистые функции разбора ссылок, чисел и кэша точек.
const assert = require('assert');
const crypto = require('crypto');
const charts = require('../lib/charts');
const { renderBuffer } = require('../lib/index');
const { buildDocx, buildDocxWithChart, buildXlsxWithChart, entryNames, readEntry } = require('./golden-lib');

describe('charts: функции', function () {
  describe('parseRef / formatRef', function () {
    it('диапазон с абсолютными адресами и кириллицей', function () {
      assert.deepStrictEqual(charts.parseRef('Лист1!$A$2:$A$3'), {
        sheet: 'Лист1', quoted: false, c1: 'A', r1: 2, c2: 'A', r2: 3,
        abs: { c1: true, r1: true, c2: true, r2: true }
      });
    });

    it('имя в кавычках и относительные адреса', function () {
      assert.deepStrictEqual(charts.parseRef('\'Sheet 1\'!A2:B9'), {
        sheet: 'Sheet 1', quoted: true, c1: 'A', r1: 2, c2: 'B', r2: 9,
        abs: { c1: false, r1: false, c2: false, r2: false }
      });
    });

    it('одна ячейка и удвоенная кавычка в имени', function () {
      const ref = charts.parseRef('\'It\'\'s\'!$B$1');
      assert.strictEqual(ref.sheet, 'It\'s');
      assert.strictEqual(ref.quoted, true);
      assert.strictEqual(ref.c2, 'B');
      assert.strictEqual(ref.r2, 1);
      assert.deepStrictEqual(ref.abs, { c1: true, r1: true, c2: true, r2: true });
    });

    it('смешанные абсолютные признаки', function () {
      const ref = charts.parseRef('S!$A2:B$9');
      assert.deepStrictEqual(ref.abs, { c1: true, r1: false, c2: false, r2: true });
    });

    it('formatRef(parseRef(x)) === x', function () {
      ['Лист1!$A$2:$A$3', '\'Sheet 1\'!A2:B9', '\'It\'\'s\'!$B$1', 'Sheet1!$B$1', '\'Лист 1\'!$A$2:$A$3', '\'Data\'!A1:C3', 'S!$A2:B$9'].forEach(function (x) {
        assert.strictEqual(charts.formatRef(charts.parseRef(x)), x);
      });
    });

    it('formatRef после смены строк', function () {
      const ref = charts.parseRef('Лист1!$A$2:$A$3');
      ref.r2 = 4;
      assert.strictEqual(charts.formatRef(ref), 'Лист1!$A$2:$A$4');
    });

    it('неподдерживаемое даёт null', function () {
      [
        '(Sheet1!$A$1:$A$2,Sheet1!$C$1:$C$2)', 'Sheet1!$A:$A', 'Sheet1!2:2', '[1]Sheet1!$A$1:$A$3', '\'[1]Sheet 1\'!$A$1',
        'МоёИмя', 'Sheet1!A1:B', 'Sheet1!', 'Sheet1!A0', '', 'A1:A3', 'Sheet1!A1:B2:C3'
      ].forEach(function (x) {
        assert.strictEqual(charts.parseRef(x), null, x);
      });
      assert.strictEqual(charts.parseRef(null), null);
      assert.strictEqual(charts.parseRef(undefined), null);
    });
  });

  describe('remapRows (R2)', function () {
    it('цикл 2..3 раскрыт в 3 итерации', function () {
      const map = new Map([[1, { first: 1, last: 1 }], [2, { first: 2, last: 4 }], [3, { first: 2, last: 4 }]]);
      assert.deepStrictEqual(charts.remapRows(map, 2, 3), { r1: 2, r2: 4, empty: false });
    });

    it('строка после цикла сдвигается', function () {
      const map = new Map([[1, { first: 1, last: 1 }], [2, { first: 2, last: 4 }], [5, { first: 6, last: 6 }]]);
      assert.deepStrictEqual(charts.remapRows(map, 5, 5), { r1: 6, r2: 6, empty: false });
    });

    it('пустой цикл', function () {
      const map = new Map([[1, { first: 1, last: 1 }], [4, { first: 2, last: 2 }]]);
      assert.deepStrictEqual(charts.remapRows(map, 2, 3), { r1: 2, r2: 2, empty: true });
    });

    it('конечной строки нет в карте: берётся ближайшая меньшая', function () {
      const map = new Map([[1, { first: 1, last: 1 }], [2, { first: 2, last: 4 }], [4, { first: 5, last: 5 }]]);
      assert.deepStrictEqual(charts.remapRows(map, 2, 3), { r1: 2, r2: 4, empty: false });
    });

    it('начальной строки нет в карте: берётся ближайшая большая', function () {
      const map = new Map([[1, { first: 1, last: 1 }], [3, { first: 2, last: 5 }]]);
      assert.deepStrictEqual(charts.remapRows(map, 2, 3), { r1: 2, r2: 5, empty: false });
    });

    it('одна строка', function () {
      const map = new Map([[1, { first: 1, last: 1 }]]);
      assert.deepStrictEqual(charts.remapRows(map, 1, 1), { r1: 1, r2: 1, empty: false });
    });
  });

  describe('toNumber', function () {
    it('числа', function () {
      assert.strictEqual(charts.toNumber('1 234,5'), 1234.5);
      assert.strictEqual(charts.toNumber('1 234,5'), 1234.5);
      assert.strictEqual(charts.toNumber('-3'), -3);
      assert.strictEqual(charts.toNumber('1e3'), 1000);
      assert.strictEqual(charts.toNumber('1,5E-2'), 0.015);
      assert.strictEqual(charts.toNumber('12.25'), 12.25);
      assert.strictEqual(charts.toNumber('0'), 0);
    });

    it('не числа', function () {
      ['10%', 'abc', '', '   ', '+5', '1,234.5', '1.', '.5', '--1', '1e', '1 2 a'].forEach(function (x) {
        assert.strictEqual(charts.toNumber(x), null, JSON.stringify(x));
      });
      assert.strictEqual(charts.toNumber(null), null);
      assert.strictEqual(charts.toNumber(undefined), null);
    });
  });

  describe('кэши', function () {
    it('buildStrCache: ptCount, idx, пропуск null', function () {
      assert.strictEqual(
        charts.buildStrCache(['a', null, 'b &amp; c'], ''),
        '<c:ptCount val="3"/><c:pt idx="0"><c:v>a</c:v></c:pt><c:pt idx="2"><c:v>b &amp; c</c:v></c:pt>'
      );
    });

    it('buildStrCache: пустой список', function () {
      assert.strictEqual(charts.buildStrCache([], ''), '<c:ptCount val="0"/>');
    });

    it('buildStrCache: прежние ptCount и pt заменяются, прочее остаётся после точек', function () {
      const old = '<c:ptCount val="9"/><c:pt idx="0"><c:v>x</c:v></c:pt><c:extLst><c:ext uri="u"/></c:extLst>';
      assert.strictEqual(
        charts.buildStrCache(['a'], old),
        '<c:ptCount val="1"/><c:pt idx="0"><c:v>a</c:v></c:pt><c:extLst><c:ext uri="u"/></c:extLst>'
      );
    });

    it('buildNumCache: formatCode первым, null пропущен, idx сохранён', function () {
      assert.strictEqual(
        charts.buildNumCache([1, null, 2.5], 'General'),
        '<c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="2"><c:v>2.5</c:v></c:pt>'
      );
    });

    it('buildNumCache: без formatCode', function () {
      assert.strictEqual(charts.buildNumCache([-3, 1000], null), '<c:ptCount val="2"/><c:pt idx="0"><c:v>-3</c:v></c:pt><c:pt idx="1"><c:v>1000</c:v></c:pt>');
      assert.strictEqual(charts.buildNumCache([null], null), '<c:ptCount val="1"/>');
    });
  });

  describe('столбцы', function () {
    it('columnIndex / columnName', function () {
      assert.strictEqual(charts.columnIndex('A'), 1);
      assert.strictEqual(charts.columnIndex('Z'), 26);
      assert.strictEqual(charts.columnIndex('AA'), 27);
      assert.strictEqual(charts.columnIndex('xfd'), 16384);
      assert.strictEqual(charts.columnName(1), 'A');
      assert.strictEqual(charts.columnName(27), 'AA');
      assert.strictEqual(charts.columnName(16384), 'XFD');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Сборка: диаграммы в XLSX и DOCX (renderBuffer)

const C_NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const chartSpace = (plot, external) => '<c:chartSpace ' + C_NS + '><c:chart><c:plotArea>' + plot
  + '<c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="2"/></c:valAx></c:plotArea></c:chart>'
  + (external === true ? '<c:externalData r:id="rId1"/>' : '') + '</c:chartSpace>';
const strRef = (f, pts) => '<c:strRef><c:f>' + f + '</c:f><c:strCache><c:ptCount val="' + (pts || []).length + '"/>'
  + (pts || []).map((v, i) => '<c:pt idx="' + i + '"><c:v>' + v + '</c:v></c:pt>').join('') + '</c:strCache></c:strRef>';
const numRef = (f, pts) => '<c:numRef><c:f>' + f + '</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="' + (pts || []).length + '"/>'
  + (pts || []).map((v, i) => '<c:pt idx="' + i + '"><c:v>' + v + '</c:v></c:pt>').join('') + '</c:numCache></c:numRef>';
const ser = (i, parts) => '<c:ser><c:idx val="' + i + '"/><c:order val="' + i + '"/>' + parts + '</c:ser>';
const bar = (sers) => '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>' + sers + '<c:axId val="1"/><c:axId val="2"/></c:barChart>';
const is = (r, t) => '<c r="' + r + '" t="inlineStr"><is><t>' + t + '</t></is></c>';
const row = (n, cells) => '<row r="' + n + '">' + cells.join('') + '</row>';

// Месяц | Сумма | План, строки цикла 2–3, ниже итог
const SHEET = row(1, [is('A1', 'Месяц'), is('B1', 'Сумма'), is('C1', 'План')])
  + row(2, [is('A2', '{d.rows[i].m}'), is('B2', '{d.rows[i].v}'), is('C2', '{d.rows[i].w}')])
  + row(3, [is('A3', '{d.rows[i+1].m}'), is('B3', '{d.rows[i+1].v}'), is('C3', '{d.rows[i+1].w}')])
  + row(4, [is('A4', 'Итого')]);
const ROWS3 = [{ m: 'Янв', v: '10', w: 1 }, { m: 'Фев', v: '20,5', w: 2 }, { m: 'Мар', v: 7, w: 3 }];
const BASE_SHEET = row(1, [is('A1', 'Месяц'), is('B1', 'Сумма')])
  + row(2, [is('A2', '{d.rows[i].m}'), is('B2', '{d.rows[i].v}')])
  + row(3, [is('A3', '{d.rows[i+1].m}'), is('B3', '{d.rows[i+1].v}')])
  + row(4, [is('A4', 'Итого')]);
const BASE_DATA = { title: 'Q', rows: [{ m: 'Янв', v: '10' }, { m: 'Фев', v: '20,5' }, { m: 'Мар', v: 7 }] };

const BAR = chartSpace(bar(ser(0, '<c:cat>' + strRef('\'Sheet1\'!$A$2:$A$3') + '</c:cat><c:val>' + numRef('\'Sheet1\'!$B$2:$B$3') + '</c:val>')));

// содержимое элемента (первого) или null
const inner = (xml, name) => {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(xml);
  return m === null ? null : m[1];
};
const all = (xml, name) => [...xml.matchAll(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'g'))].map((m) => m[1]);
// точки кэша: ptCount и [idx, значение]
const points = (cache) => ({
  count: Number(/<c:ptCount val="(\d+)"\/>/.exec(cache)[1]),
  pts: [...cache.matchAll(/<c:pt idx="(\d+)"><c:v>([\s\S]*?)<\/c:v><\/c:pt>/g)].map((m) => [Number(m[1]), m[2]])
});
// текст ячейки результата XLSX (общие строки уже восстановлены finishXlsx)
const cellOf = (sheet, ref) => {
  const m = new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)').exec(sheet);
  return m === null ? null : { attrs: m[1], body: m[2] || '' };
};
const sharedText = (sst, cell) => all(sst, 'si')[Number(inner(cell.body, 'v'))];

async function renderXlsx (chartXml, rows, sheetXml) {
  const out = await renderBuffer(await buildXlsxWithChart({ sheetXml: sheetXml || SHEET, chartXml }), 'xlsx', { rows });
  return {
    chart: chartXml ? await readEntry(out, 'xl/charts/chart1.xml') : null,
    sheet: await readEntry(out, 'xl/worksheets/sheet1.xml'),
    sst: await readEntry(out, 'xl/sharedStrings.xml')
  };
}

async function outputHash (buf) {
  const h = crypto.createHash('sha256');
  for (const name of await entryNames(buf)) {
    h.update(name + '\0');
    h.update(await readEntry(buf, name, true));
  }
  return h.digest('hex');
}

describe('charts: сборка XLSX', function () {
  it('3 строки: диапазоны до строки 4, кэш, ячейки сумм — числа, итог в строке 5', async function () {
    const { chart, sheet, sst } = await renderXlsx(BAR, ROWS3);
    const [catF, valF] = all(chart, 'c:f');
    assert.strictEqual(catF, '\'Sheet1\'!$A$2:$A$4');
    assert.strictEqual(valF, '\'Sheet1\'!$B$2:$B$4');
    assert.deepStrictEqual(points(inner(chart, 'c:strCache')), { count: 3, pts: [[0, 'Янв'], [1, 'Фев'], [2, 'Мар']] });
    const num = inner(chart, 'c:numCache');
    assert.ok(num.startsWith('<c:formatCode>General</c:formatCode>'), num);
    assert.deepStrictEqual(points(num), { count: 3, pts: [[0, '10'], [1, '20.5'], [2, '7']] });
    [['B2', '10'], ['B3', '20.5'], ['B4', '7']].forEach(([ref, v]) => {
      const cell = cellOf(sheet, ref);
      assert.ok(cell !== null, ref);
      assert.ok(!/\st="/.test(cell.attrs), ref + ': ' + cell.attrs);
      assert.strictEqual(cell.body, '<v>' + v + '</v>');
    });
    assert.ok(/<row r="5"/.test(sheet), sheet);
    assert.strictEqual(sharedText(sst, cellOf(sheet, 'A5')), '<t>Итого</t>');
    assert.strictEqual(sharedText(sst, cellOf(sheet, 'A4')), '<t>Мар</t>');
    assert.ok(!/crRow|crCol/.test(sheet), sheet);
    assert.ok(!/<row r="6"/.test(sheet), sheet);
  });

  it('1 строка', async function () {
    const { chart, sheet } = await renderXlsx(BAR, [{ m: 'Янв', v: '5' }]);
    assert.deepStrictEqual(all(chart, 'c:f'), ['\'Sheet1\'!$A$2:$A$2', '\'Sheet1\'!$B$2:$B$2']);
    assert.deepStrictEqual(points(inner(chart, 'c:strCache')), { count: 1, pts: [[0, 'Янв']] });
    assert.deepStrictEqual(points(inner(chart, 'c:numCache')), { count: 1, pts: [[0, '5']] });
    assert.ok(/<row r="3"/.test(sheet) && !/<row r="4"/.test(sheet), sheet);
  });

  it('0 строк (R2): одна строка после конца, кэш без точек', async function () {
    const { chart, sheet, sst } = await renderXlsx(BAR, []);
    assert.deepStrictEqual(all(chart, 'c:f'), ['\'Sheet1\'!$A$2:$A$2', '\'Sheet1\'!$B$2:$B$2']);
    assert.deepStrictEqual(points(inner(chart, 'c:strCache')), { count: 0, pts: [] });
    assert.deepStrictEqual(points(inner(chart, 'c:numCache')), { count: 0, pts: [] });
    assert.strictEqual(sharedText(sst, cellOf(sheet, 'A2')), '<t>Итого</t>');
    assert.ok(!/crRow|crCol/.test(sheet), sheet);
  });

  it('числа в ячейках (Review Focus 5)', async function () {
    const values = ['1 234,5', '-3', '1e3', '10%', 'abc', '', null];
    const { chart, sheet } = await renderXlsx(BAR, values.map((v, i) => ({ m: 'm' + i, v })));
    assert.strictEqual(all(chart, 'c:f')[1], '\'Sheet1\'!$B$2:$B$8');
    assert.deepStrictEqual(points(inner(chart, 'c:numCache')), { count: 7, pts: [[0, '1234.5'], [1, '-3'], [2, '1000']] });
    assert.strictEqual(cellOf(sheet, 'B2').body, '<v>1234.5</v>');
    assert.strictEqual(cellOf(sheet, 'B3').body, '<v>-3</v>');
    assert.strictEqual(cellOf(sheet, 'B4').body, '<v>1000</v>');
    ['B5', 'B6', 'B7'].forEach((ref) => assert.ok(/\st="s"/.test(cellOf(sheet, ref).attrs), ref));
  });

  it('две серии, c:tx на $B$1 и $C$1', async function () {
    const xml = chartSpace(bar(
      ser(0, '<c:tx>' + strRef('Sheet1!$B$1', ['old']) + '</c:tx><c:cat>' + strRef('Sheet1!$A$2:$A$3') + '</c:cat><c:val>' + numRef('Sheet1!$B$2:$B$3') + '</c:val>')
      + ser(1, '<c:tx>' + strRef('Sheet1!$C$1') + '</c:tx><c:cat>' + strRef('Sheet1!$A$2:$A$3') + '</c:cat><c:val>' + numRef('Sheet1!$C$2:$C$3') + '</c:val>')
    ));
    const { chart } = await renderXlsx(xml, ROWS3);
    assert.deepStrictEqual(all(chart, 'c:f'), ['Sheet1!$B$1', 'Sheet1!$A$2:$A$4', 'Sheet1!$B$2:$B$4', 'Sheet1!$C$1', 'Sheet1!$A$2:$A$4', 'Sheet1!$C$2:$C$4']);
    const str = all(chart, 'c:strCache');
    assert.deepStrictEqual(points(str[0]), { count: 1, pts: [[0, 'Сумма']] });
    assert.deepStrictEqual(points(str[2]), { count: 1, pts: [[0, 'План']] });
    const num = all(chart, 'c:numCache');
    assert.deepStrictEqual(points(num[1]), { count: 3, pts: [[0, '1'], [1, '2'], [2, '3']] });
  });

  it('точечная диаграмма: c:xVal и c:yVal — numRef', async function () {
    const xml = chartSpace('<c:scatterChart><c:scatterStyle val="lineMarker"/>' + ser(0, '<c:xVal>' + numRef('Sheet1!$B$2:$B$3') + '</c:xVal><c:yVal>' + numRef('Sheet1!$C$2:$C$3') + '</c:yVal>')
      + '<c:axId val="1"/><c:axId val="2"/></c:scatterChart>');
    const { chart, sheet } = await renderXlsx(xml, ROWS3);
    assert.deepStrictEqual(all(chart, 'c:f'), ['Sheet1!$B$2:$B$4', 'Sheet1!$C$2:$C$4']);
    const [x, y] = all(chart, 'c:numCache');
    assert.deepStrictEqual(points(x).pts, [[0, '10'], [1, '20.5'], [2, '7']]);
    assert.deepStrictEqual(points(y).pts, [[0, '1'], [1, '2'], [2, '3']]);
    assert.strictEqual(cellOf(sheet, 'B3').body, '<v>20.5</v>');
  });

  it('круговая диаграмма', async function () {
    const xml = chartSpace('<c:pieChart><c:varyColors val="1"/>' + ser(0, '<c:cat>' + strRef('Sheet1!$A$2:$A$3') + '</c:cat><c:val>' + numRef('Sheet1!$B$2:$B$3') + '</c:val>') + '</c:pieChart>');
    const { chart } = await renderXlsx(xml, ROWS3);
    assert.deepStrictEqual(all(chart, 'c:f'), ['Sheet1!$A$2:$A$4', 'Sheet1!$B$2:$B$4']);
    assert.strictEqual(points(inner(chart, 'c:numCache')).count, 3);
  });

  it('c:multiLvlStrRef (R3) и ссылка-объединение не меняются', async function () {
    const multi = '<c:multiLvlStrRef><c:f>Sheet1!$A$2:$B$3</c:f><c:multiLvlStrCache><c:ptCount val="2"/><c:lvl><c:pt idx="0"><c:v>x</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef>';
    const union = numRef('(Sheet1!$B$2:$B$3,Sheet1!$C$2)', [5, 6]);
    const xml = chartSpace(bar(ser(0, '<c:cat>' + multi + '</c:cat><c:val>' + union + '</c:val>')));
    const { chart, sheet } = await renderXlsx(xml, ROWS3);
    assert.ok(chart.includes(multi), chart);
    assert.ok(chart.includes(union), chart);
    assert.ok(!/crRow|crCol/.test(sheet), sheet);
  });
});

describe('charts: сборка DOCX', function () {
  // Лист1 из русского Word: A1 нет вовсе, имя ряда в B1
  const EMB = row(1, [is('B1', 'Сумма')])
    + row(2, [is('A2', '{d.rows[i].m}'), is('B2', '{d.rows[i].v}')])
    + row(3, [is('A3', '{d.rows[i+1].m}'), is('B3', '{d.rows[i+1].v}')]);
  const chartXml = (marked) => chartSpace(bar(ser(0,
    '<c:tx>' + strRef('Лист1!$B$1', ['Сумма']) + '</c:tx>'
    + '<c:cat>' + strRef('Лист1!$A$2:$A$3', marked ? ['{d.rows[i].m}', '{d.rows[i+1].m}'] : []) + '</c:cat>'
    + '<c:val>' + numRef('Лист1!$B$2:$B$3', marked ? ['{d.rows[i].v}', '{d.rows[i+1].v}'] : []) + '</c:val>')), true);

  async function renderDocx (marked) {
    const tpl = await buildDocxWithChart({ chartXml: chartXml(marked), embeddedSheetXml: EMB, sheetName: 'Лист1' });
    const out = await renderBuffer(tpl, 'docx', { rows: ROWS3 });
    const emb = await readEntry(out, 'word/embeddings/Microsoft_Excel_Worksheet.xlsx', true);
    return { chart: await readEntry(out, 'word/charts/chart1.xml'), sheet: await readEntry(emb, 'xl/worksheets/sheet1.xml') };
  }

  it('Review Focus 1: Лист1, нет A1, имя ряда в B1', async function () {
    const { chart, sheet } = await renderDocx(false);
    assert.deepStrictEqual(all(chart, 'c:f'), ['Лист1!$B$1', 'Лист1!$A$2:$A$4', 'Лист1!$B$2:$B$4']);
    const [tx, cat] = all(chart, 'c:strCache');
    assert.deepStrictEqual(points(tx), { count: 1, pts: [[0, 'Сумма']] });
    assert.deepStrictEqual(points(cat), { count: 3, pts: [[0, 'Янв'], [1, 'Фев'], [2, 'Мар']] });
    assert.deepStrictEqual(points(inner(chart, 'c:numCache')), { count: 3, pts: [[0, '10'], [1, '20.5'], [2, '7']] });
    // встроенная книга: номера строк и ячеек, B1 остаётся B1, числа без t, служебных атрибутов нет
    assert.ok(!/crRow|crCol/.test(sheet), sheet);
    assert.ok(/<row r="1"/.test(sheet) && /<row r="4"/.test(sheet) && !/<row r="5"/.test(sheet), sheet);
    assert.strictEqual(cellOf(sheet, 'A1'), null);
    assert.ok(/<t>Сумма<\/t>/.test(cellOf(sheet, 'B1').body), sheet);
    assert.ok(/<t>Мар<\/t>/.test(cellOf(sheet, 'A4').body), sheet);
    [['B2', '10'], ['B3', '20.5'], ['B4', '7']].forEach(([ref, v]) => {
      const cell = cellOf(sheet, ref);
      assert.ok(!/\st="/.test(cell.attrs), ref + ': ' + cell.attrs);
      assert.strictEqual(cell.body, '<v>' + v + '</v>');
    });
  });

  it('метки в кэше диаграммы и без них — одинаковый результат', async function () {
    const a = await renderDocx(true);
    const b = await renderDocx(false);
    assert.strictEqual(a.chart, b.chart);
    assert.strictEqual(a.sheet, b.sheet);
  });
});

describe('charts: шаблоны без диаграмм (Review Focus 4)', function () {
  // эталоны сняты на коде 2.4.0 до появления диаграмм (sha256 имён и содержимого файлов результата)
  it('XLSX с циклом без диаграммы — как в 2.4.0, без crRow/crCol', async function () {
    const out = await renderBuffer(await buildXlsxWithChart({ sheetXml: BASE_SHEET }), 'xlsx', BASE_DATA);
    assert.strictEqual(await outputHash(out), '9689779dc8b440f9d0cce3b04da9e5302c77de8085e3e7a8a3b19b7b38880d68');
    assert.ok(!/crRow|crCol/.test(await readEntry(out, 'xl/worksheets/sheet1.xml')));
  });

  it('DOCX без диаграмм — как в 2.4.0', async function () {
    const out = await renderBuffer(await buildDocx('Отчёт {d.title}\n| {d.rows[i].m} | {d.rows[i].v} |\n| {d.rows[i+1].m} | {d.rows[i+1].v} |'), 'docx', BASE_DATA);
    assert.strictEqual(await outputHash(out), 'eda177a73ef57c9a4c033a49e936ff4718f0b02fa703824415397bd88ede3690');
  });
});

describe('charts: hasCharts / tagSheet', function () {
  it('tagSheet: crRow у строк, crCol у ячеек, вне sheetData не трогает', function () {
    const xml = '<worksheet><cols><col min="1"/></cols><sheetData><row r="2" spans="1:2"><c r="B2" s="1"><v>1</v></c><c r="AA2"/></row><row r="3"/></sheetData></worksheet>';
    assert.strictEqual(charts.tagSheet(xml),
      '<worksheet><cols><col min="1"/></cols><sheetData><row r="2" spans="1:2" crRow="2"><c r="B2" s="1" crCol="B"><v>1</v></c><c r="AA2" crCol="AA"/></row><row r="3" crRow="3"/></sheetData></worksheet>');
  });

  it('hasCharts: верхний уровень XLSX и встроенная книга DOCX', function () {
    const chart = { name: 'xl/charts/chart1.xml', parent: '', data: '<c:chartSpace></c:chartSpace>' };
    assert.strictEqual(charts.hasCharts({ files: [chart] }, ''), true);
    assert.strictEqual(charts.hasCharts({ files: [{ name: 'xl/charts/chartEx1.xml', parent: '', data: '<cx:chartSpace/>' }] }, ''), false);
    assert.strictEqual(charts.hasCharts({ files: [] }, ''), false);
    const emb = 'word/embeddings/Microsoft_Excel_Worksheet.xlsx';
    const files = [
      { name: 'word/charts/chart1.xml', parent: '', data: '<c:chartSpace></c:chartSpace>' },
      { name: 'word/charts/_rels/chart1.xml.rels', parent: '', data: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet.xlsx"/></Relationships>' },
      { name: 'xl/worksheets/sheet1.xml', parent: emb, data: '<worksheet/>' }
    ];
    assert.strictEqual(charts.hasCharts({ files }, emb), true);
    assert.strictEqual(charts.hasCharts({ files }, 'word/embeddings/other.xlsx'), false);
    assert.strictEqual(charts.hasCharts({ files }, ''), false);
    // книга не распакована (например, OLE-объект) — не книга диаграммы
    assert.strictEqual(charts.hasCharts({ files: files.slice(0, 2) }, emb), false);
  });
});
