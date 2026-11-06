// :cellDate — настоящие даты в ячейках XLSX и ODS (спецификация carbone-reports §54). Своё расширение, не функция EE.
const assert = require('assert');
const carbone = require('../lib/index');
const { renderBuffer } = carbone;
const dateFormatter = require('../formatters/date');
const { RU, buildDocx, docxText, renderXlsx, renderOds, assertWellFormed } = require('./golden-lib');

// серийные номера Excel (дни от 1899-12-30): 2024-01-01 — 45292 (известное значение), 2026-03-08 — 46089
const D_2024_01_01 = 45292;
const D_2026_03_08 = 46089;

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
