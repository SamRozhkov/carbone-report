// Формирование таблиц в листах XLSX и ODS (спецификация carbone-reports §53): простая таблица, итог под ней
// (агрегаторы §31.1) и подитоги по группам (§53.2) — числа и даты остаются числами и датами (§54).
const assert = require('assert');
const { GROUPS, LIST, renderXlsx, renderOds } = require('./golden-lib');

// серийные номера Excel (дни от 1899-12-30): 2024-01-01 — 45292, отсюда 2026-01-01 — 46023
const D_2026_01_05 = 46027;
const D_2026_01_07 = 46029;
const D_2026_02_01 = 46054;

// простая таблица: шапка, строка данных, служебная строка [i+1], итог под таблицей
const SIMPLE = [
  ['Дата', 'Сумма', 'Кол-во'],
  ['{d.list[i].date:cellDate}', '{d.list[i].sum:formatN(2)}', '{d.list[i].qty:formatN(0)}'],
  ['{d.list[i+1].date:cellDate}', '{d.list[i+1].sum:formatN(2)}', '{d.list[i+1].qty:formatN(0)}'],
  ['Итого', '{d.list[].sum:aggSum:formatN(2)}', '{d.list[].qty:aggCount:formatN(0)}']
];

// подитоги §53.2: строка группы, вложенная строка, служебная вложенная, подитог, служебная группы, общий итог
const SUBTOTALS = [
  ['Контрагент', 'Дата', 'Сумма'],
  ['{d.groups[i].contractor}', '', ''],
  ['', '{d.groups[i].rows[i].date:cellDate}', '{d.groups[i].rows[i].sum:formatN(2)}'],
  ['', '{d.groups[i].rows[i+1].date}', ''],
  ['Итого по контрагенту', '', '{d.groups[i].rows[].sum:aggSum:formatN(2)}'],
  ['{d.groups[i+1].contractor}', '', ''],
  ['Всего', '', '{d.groups[].rows[].sum:aggSum:formatN(2)}']
];

// содержательные значения строки (без пустых ячеек) — для проверки порядка строк
const meaningful = (cells, value) => cells.map(value).filter((v) => v !== null && v !== '');

describe('Таблицы в листах: итог и подитоги (§53)', function () {
  describe('XLSX', function () {
    it('простая таблица: 3 строки данных, суммы — числа, даты — серийные номера', async function () {
      const { rows } = await renderXlsx(SIMPLE.slice(0, 3), { list: LIST });
      assert.deepStrictEqual(rows, [
        [{ t: 's', v: 'Дата' }, { t: 's', v: 'Сумма' }, { t: 's', v: 'Кол-во' }],
        [{ t: 'n', v: String(D_2026_01_05) }, { t: 'n', v: '100.5' }, { t: 'n', v: '2' }],
        [{ t: 'n', v: String(D_2026_01_07) }, { t: 'n', v: '50' }, { t: 'n', v: '1' }],
        [{ t: 'n', v: String(D_2026_02_01) }, { t: 'n', v: '10.25' }, { t: 'n', v: '3' }]
      ]);
    });
    it('итог под таблицей: aggSum и aggCount — числовые ячейки', async function () {
      const { rows } = await renderXlsx(SIMPLE, { list: LIST });
      assert.strictEqual(rows.length, 5);
      assert.deepStrictEqual(rows[4], [{ t: 's', v: 'Итого' }, { t: 'n', v: '160.75' }, { t: 'n', v: '3' }]);
    });
    it('подитоги по группам и общий итог (§53.2): порядок строк, подитоги — числа', async function () {
      const { rows } = await renderXlsx(SUBTOTALS, { groups: GROUPS });
      const flat = rows.slice(1).map((cells) => meaningful(cells, (c) => c.v));
      assert.deepStrictEqual(flat, [
        ['Альфа'],
        [String(D_2026_01_05), '100.5'],
        [String(D_2026_01_07), '50'],
        ['Итого по контрагенту', '150.5'],
        ['Бета'],
        [String(D_2026_02_01), '10.25'],
        ['Итого по контрагенту', '10.25'],
        ['Всего', '160.75']
      ]);
      for (const i of [4, 7, 8]) assert.deepStrictEqual(rows[i][2], { t: 'n', v: flat[i - 1][1] }, 'строка ' + i);
      for (const i of [2, 3, 6]) assert.deepStrictEqual([rows[i][1].t, rows[i][2].t], ['n', 'n'], 'строка ' + i);
    });
  });

  describe('ODS', function () {
    const float = (value) => ({ type: 'float', date: null, text: value });
    const date = (value) => ({ type: 'date', date: value, text: value });
    const pick = (c) => ({ type: c.type, date: c.date, text: c.text });

    it('простая таблица: 3 строки данных, суммы — float, даты — date', async function () {
      const rows = await renderOds(SIMPLE.slice(0, 3), { list: LIST });
      assert.strictEqual(rows.length, 4);
      assert.deepStrictEqual(rows.slice(1).map((r) => r.map(pick)), [
        [date('2026-01-05'), float('100.5'), float('2')],
        [date('2026-01-07'), float('50'), float('1')],
        [date('2026-02-01'), float('10.25'), float('3')]
      ]);
    });
    it('числовые ячейки несут office:value — данные, итог и подитоги', async function () {
      const value = (rows) => [...rows.content.matchAll(/office:value-type="float"[^>]*?office:value="([^"]*)"/g)].map((m) => m[1]);
      assert.deepStrictEqual(value(await renderOds(SIMPLE, { list: LIST })), ['100.5', '2', '50', '1', '10.25', '3', '160.75', '3']);
      assert.deepStrictEqual(value(await renderOds(SUBTOTALS, { groups: GROUPS })), ['100.5', '50', '150.5', '10.25', '10.25', '160.75']);
    });
    it('итог под таблицей: aggSum и aggCount — float', async function () {
      const rows = await renderOds(SIMPLE, { list: LIST });
      assert.strictEqual(rows.length, 5);
      assert.deepStrictEqual(rows[4].map(pick), [{ type: 'string', date: null, text: 'Итого' }, float('160.75'), float('3')]);
    });
    it('подитоги по группам и общий итог (§53.2): порядок строк, подитоги — float', async function () {
      const rows = await renderOds(SUBTOTALS, { groups: GROUPS });
      const flat = rows.slice(1).map((cells) => meaningful(cells, (c) => c.text));
      assert.deepStrictEqual(flat, [
        ['Альфа'],
        ['2026-01-05', '100.5'],
        ['2026-01-07', '50'],
        ['Итого по контрагенту', '150.5'],
        ['Бета'],
        ['2026-02-01', '10.25'],
        ['Итого по контрагенту', '10.25'],
        ['Всего', '160.75']
      ]);
      for (const i of [4, 7, 8]) assert.deepStrictEqual(pick(rows[i][2]), float(flat[i - 1][1]), 'строка ' + i);
      for (const i of [2, 3, 6]) assert.deepStrictEqual([rows[i][1].type, rows[i][2].type], ['date', 'float'], 'строка ' + i);
    });
  });
});
