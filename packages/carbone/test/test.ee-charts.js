// Диаграммы DOCX/XLSX (2.5.0, спецификация §34.2): чистые функции разбора ссылок, чисел и кэша точек.
const assert = require('assert');
const charts = require('../lib/charts');

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
        '(Sheet1!$A$1:$A$2,Sheet1!$C$1:$C$2)', 'Sheet1!$A:$A', 'Sheet1!2:2', '[1]Sheet1!$A$1:$A$3',
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
