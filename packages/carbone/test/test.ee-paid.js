// Платные функции Carbone EE, реализованные в 2.2.0 (спецификация §31). Эталона EE нет: ожидания — по примерам
// открытой документации (docs/superpowers/notes/2026-10-10-ee-aggregators-drop-sort.md) и решениям §31.1.
const assert = require('assert');
const carbone = require('../lib/index');
const { renderBuffer } = carbone;
const { buildDocx, docxText, normalizeError } = require('./golden-lib');

const RU = { lang: 'ru', timezone: 'Europe/Moscow' };

async function text (template, data, options) {
  return docxText(await renderBuffer(await buildDocx(template), 'docx', data, options || RU));
}

async function rawError (template, data, options) {
  try {
    await renderBuffer(await buildDocx(template), 'docx', data, options || RU);
  }
  catch (e) {
    return e.message;
  }
  throw new Error('ожидалась ошибка');
}

// «6 машин» из примеров документации: qty 1,4,3,2,1,10; sort подобран так, что [sort>1] даёт 19 / 4.75 / 2 / 4
const SIX = {
  cars: [
    { brand: 'Lexus', qty: 1, sort: 1 },
    { brand: 'Faraday', qty: 4, sort: 2 },
    { brand: 'Venturi', qty: 3, sort: 3 },
    { brand: 'Faraday', qty: 2, sort: 4 },
    { brand: 'Aptera', qty: 1, sort: 1 },
    { brand: 'Venturi', qty: 10, sort: 5 }
  ]
};

// вложенный массив из документации: подытог по стране
const COUNTRIES = [
  { country: 'France', cities: [{ name: 'Paris', cars: 100 }, { name: 'Lyon', cars: 51 }] },
  { country: 'Italy', cities: [{ name: 'Rome', cars: 22 }] }
];

// строки цикла по cars с одной меткой-агрегатором в каждой
function loop (marker) {
  return '| {d.cars[i].brand} | {d.cars[i]' + marker + '} |\n| {d.cars[i+1].brand} | |';
}

function column (result) {
  return result.split('\n').map((row) => row.split('|')[2].trim());
}

describe('EE платные: агрегаторы вне цикла (справочник §1)', function () {
  const cases = [
    ['{d.cars[].qty:aggSum}', '21'],
    ['{d.cars[sort>1].qty:aggSum}', '19'],
    ['{d.cars[].qty:aggAvg}', '3.5'],
    ['{d.cars[sort>1].qty:aggAvg}', '4.75'],
    ['{d.cars[].qty:aggMin}', '1'],
    ['{d.cars[sort>1].qty:aggMin}', '2'],
    ['{d.cars[].qty:aggMax}', '10'],
    ['{d.cars[].qty:aggCount}', '6'],
    ['{d.cars[sort>1].qty:aggCount}', '4'],
    ['{d.cars[].brand:aggCountD}', '4'],
    ['{d.cars[].brand:aggStr}', 'Lexus, Faraday, Venturi, Faraday, Aptera, Venturi'],
    ['{d.cars[].brand:aggStr(\' | \')}', 'Lexus | Faraday | Venturi | Faraday | Aptera | Venturi'],
    // порядок различных — по последнему вхождению, как в примере документации
    ['{d.cars[].brand:aggStrD}', 'Lexus, Faraday, Aptera, Venturi']
  ];
  for (const [tpl, want] of cases) {
    it(tpl + ' → ' + want, async function () {
      assert.strictEqual(await text(tpl, SIX), want);
    });
  }
  it('форматтер до агрегатора — к каждому значению, после — к итогу', async function () {
    // 4·2 + 3·3 + 2·4 + 10·5 = 75
    assert.strictEqual(await text('{d.cars[sort>1].qty:mul(.sort):aggSum}', SIX), '75');
    assert.strictEqual(await text('{d.cars[sort>1].qty:mul(.sort):aggSum:formatN(2)}', SIX), '75,00');
    assert.strictEqual(await text('{d.cars[].qty:aggAvg:formatN(1)}', SIX), '3,5');
  });
  it('несколько условий фильтра и фильтр по строке', async function () {
    assert.strictEqual(await text('{d.cars[sort>1, brand=\'Faraday\'].qty:aggSum}', SIX), '6');
  });
  it('корневой массив, вложенный объект до массива, complement', async function () {
    assert.strictEqual(await text('{d[].qty:aggSum}', SIX.cars), '21');
    assert.strictEqual(await text('{d.a.cars[].qty:aggSum}', { a: SIX }), '21');
    assert.strictEqual(await text('{c.cars[].qty:aggSum}', {}, Object.assign({ complement: SIX }, RU)), '21');
  });
  it('два уровня «[]» — по всем элементам', async function () {
    assert.strictEqual(await text('{d[].cities[].cars:aggSum}', COUNTRIES), '173');
  });
  it('значение без массива — набор из одного значения', async function () {
    assert.strictEqual(await text('{d.n:aggSum} {d.n:cumSum}', { n: 5 }), '5 5');
  });
});

describe('EE платные: агрегаторы в цикле', function () {
  it('cumSum — нарастающий итог по строкам', async function () {
    assert.deepStrictEqual(column(await text(loop('.qty:cumSum'), SIX)), ['1', '5', '8', '10', '11', '21']);
  });
  it('cumCount — номер строки', async function () {
    assert.deepStrictEqual(column(await text(loop('.qty:cumCount'), SIX)), ['1', '2', '3', '4', '5', '6']);
  });
  it('cumCountD — накопительное число различных', async function () {
    // Lexus, Faraday, Venturi, Faraday, Aptera, Venturi. В пересказе документации — 1, 2, 2, 3, 4, 4,
    // что с этими данными не сходится (третья строка — новый бренд); считаем по определению
    assert.deepStrictEqual(column(await text(loop('.brand:cumCountD'), SIX)), ['1', '2', '3', '3', '4', '4']);
  });
  it('aggSum в цикле — итог всего набора на каждой строке', async function () {
    assert.deepStrictEqual(column(await text(loop('.qty:aggSum'), SIX)), ['21', '21', '21', '21', '21', '21']);
  });
  it('aggSum(.brand) — итог по бренду (partition-by)', async function () {
    assert.deepStrictEqual(column(await text(loop('.qty:aggSum(.brand)'), SIX)), ['1', '6', '13', '6', '1', '13']);
  });
  it('cumCount(.brand) — нумерация заново для каждого бренда', async function () {
    assert.deepStrictEqual(column(await text(loop('.qty:cumCount(.brand)'), SIX)), ['1', '1', '1', '2', '1', '2']);
  });
  it('cumSum(.brand) и aggCount(.brand)', async function () {
    assert.deepStrictEqual(column(await text(loop('.qty:cumSum(.brand)'), SIX)), ['1', '4', '3', '6', '1', '13']);
    assert.deepStrictEqual(column(await text(loop('.qty:aggCount(.brand)'), SIX)), ['1', '2', '2', '2', '1', '2']);
  });
  it('aggStr с разделителем и partition-by, aggStrD с partition-by', async function () {
    assert.deepStrictEqual(column(await text(loop('.qty:aggStr(\'+\', .brand)'), SIX)), ['1', '4+2', '3+10', '4+2', '1', '3+10']);
    assert.deepStrictEqual(column(await text(loop('.brand:aggStrD(\', \', .sort)'), SIX)), ['Lexus, Aptera', 'Faraday', 'Venturi', 'Faraday', 'Lexus, Aptera', 'Venturi']);
  });
  it('цикл с фильтром: агрегат по отфильтрованным строкам', async function () {
    const t = '| {d.cars[i, sort>1].brand} | {d.cars[i, sort>1].qty:cumSum} | {d.cars[i, sort>1].qty:aggSum} |\n| {d.cars[i+1].brand} | | |';
    assert.strictEqual(await text(t, SIX), '| Faraday | 4 | 19 |\n| Venturi | 7 | 19 |\n| Faraday | 9 | 19 |\n| Venturi | 19 | 19 |');
  });
  it('cum* — в порядке вывода строк (цикл с сортировкой)', async function () {
    const t = '| {d.cars[sort, i].brand} | {d.cars[sort, i].qty:cumSum} |\n| {d.cars[sort+1, i+1].brand} | |';
    assert.strictEqual(await text(t, SIX), '| Lexus | 1 |\n| Aptera | 2 |\n| Faraday | 6 |\n| Venturi | 9 |\n| Faraday | 11 |\n| Venturi | 21 |');
  });
  it('группировка циклом [brand]: aggSum(.brand) по всем элементам группы', async function () {
    const t = '| {d.cars[brand].brand} | {d.cars[brand].qty:aggSum(.brand)} | {d.cars[brand].qty:aggCount(.brand)} |\n| {d.cars[brand+1].brand} | | |';
    assert.strictEqual(await text(t, SIX), '| Aptera | 1 | 1 |\n| Faraday | 6 | 2 |\n| Lexus | 1 | 1 |\n| Venturi | 13 | 2 |');
  });
  it('цепочка aggSum:cumSum в цикле строк', async function () {
    assert.deepStrictEqual(column(await text(loop('.qty:aggSum(.brand):cumSum'), SIX)), ['1', '7', '20', '26', '27', '40']);
  });
  it('агрегатор в строке-разделителе [i+1] ничего не ломает', async function () {
    const t = '| {d.cars[i].qty:cumSum} |\n| {d.cars[i+1].qty:cumSum} |';
    assert.strictEqual(await text(t, { cars: [{ qty: 1 }, { qty: 2 }] }), '| 1 |\n| 3 |');
  });
  it('вложенный цикл: cumSum сквозной, cumSum(..country) — по родителю', async function () {
    const t = '| {d[i].cities[i].name} | {d[i].cities[i].cars:cumSum} | {d[i].cities[i].cars:cumSum(..country)} |\n| {d[i].cities[i+1].name} | | |\n| {d[i+1].country} | | |';
    assert.strictEqual(await text(t, COUNTRIES), '| Paris | 100 | 100 |\n| Lyon | 151 | 151 |\n| Rome | 173 | 22 |');
  });
});

describe('EE платные: подытоги по вложенному массиву', function () {
  const t = '| {d[i].country} | {d[i].cities[].cars:aggSum} | {d[i].cities[].cars:aggSum:cumSum} |\n| {d[i+1].country} | | |';
  it('{d[i].cities[].cars:aggSum} — подытог страны; :cumSum — нарастающим итогом', async function () {
    assert.strictEqual(await text(t, COUNTRIES), '| France | 151 | 151 |\n| Italy | 22 | 173 |');
  });
  it('внутренний массив пустой или отсутствует — 0 у своей строки', async function () {
    const data = [{ country: 'France', cities: [] }, { country: 'Italy' }, { country: 'Spain', cities: [{ cars: 5 }] }];
    assert.strictEqual(await text(t, data), '| France | 0 | 0 |\n| Italy | 0 | 0 |\n| Spain | 5 | 5 |');
  });
  it('фильтр внутреннего и внешнего уровня', async function () {
    const f = '| {d[i, country=\'France\'].country} | {d[i, country=\'France\'].cities[cars>60].cars:aggSum} |\n| {d[i+1].country} | |';
    assert.strictEqual(await text(f, COUNTRIES), '| France | 100 |');
  });
  it('подытог рядом со строками вложенного цикла (группа + детали)', async function () {
    const g = '| {d[i].country} | {d[i].cities[].cars:aggSum} |\n| {d[i].cities[i].name} | {d[i].cities[i].cars} |\n| {d[i].cities[i+1].name} | |\n| {d[i+1].country} | |';
    assert.strictEqual(await text(g, COUNTRIES), '| France | 151 |\n| Paris | 100 |\n| Lyon | 51 |\n| Italy | 22 |\n| Rome | 22 |');
  });
});

describe('EE платные: count()', function () {
  it('count() — сплошная нумерация 1…N', async function () {
    const t = '{d.cars[i].brand:count()} {d.cars[i].brand}\n{d.cars[i+1].brand}';
    assert.strictEqual(await text(t, { cars: [{ brand: 'Лада' }, { brand: 'Тесла' }] }), '1 Лада\n2 Тесла');
  });
  it('count() в цикле с фильтром — без пропусков', async function () {
    const t = '| {d.cars[i, sort>1].brand:count()} | {d.cars[i, sort>1].brand} |\n| {d.cars[i+1].brand} | |';
    assert.strictEqual(await text(t, SIX), '| 1 | Faraday |\n| 2 | Venturi |\n| 3 | Faraday |\n| 4 | Venturi |');
  });
  it('count() с форматтером после', async function () {
    const t = '| {d.cars[i].brand:count():formatN(1)} |\n| {d.cars[i+1].brand} |';
    assert.strictEqual(await text(t, { cars: [{ brand: 'a' }, { brand: 'b' }] }), '| 1,0 |\n| 2,0 |');
  });
});

describe('EE платные: решения §31.1 (пустые, null, нечисловые)', function () {
  const mixed = { cars: [{ qty: 1 }, { qty: null }, {}, { qty: '' }, { qty: 'x' }, { qty: '2' }, { qty: { a: 1 } }, { qty: [5] }, { qty: 1 }] };
  it('числовые агрегаторы берут только конечные числа (строка «2» — число), остальное пропускают', async function () {
    assert.strictEqual(await text('{d.cars[].qty:aggSum} {d.cars[].qty:aggAvg} {d.cars[].qty:aggMin} {d.cars[].qty:aggMax}', mixed), '4 1.3333333333333333 1 2');
  });
  it('aggCount считает элементы независимо от значения', async function () {
    assert.strictEqual(await text('{d.cars[].qty:aggCount}', mixed), '9');
  });
  it('aggCountD сравнивает строго (1 и «1» различны), пропускает пустые значения и объекты', async function () {
    assert.strictEqual(await text('{d.v[]:aggCountD}', { v: [1, '1', 1, null, '', { a: 1 }, [1], 'a'] }), '3');
  });
  it('aggStr пропускает null, undefined, пустую строку и объекты', async function () {
    assert.strictEqual(await text('{d.cars[].qty:aggStr}', mixed), '1, x, 2, 1');
  });
  it('cumSum: нечисловые строки не меняют итог', async function () {
    const t = '| {d.v[i]:cumSum} |\n| {d.v[i+1]} |';
    assert.strictEqual(await text(t, { v: [1, null, 'x', 2] }), '| 1 |\n| 1 |\n| 1 |\n| 3 |');
  });
  it('пустой набор: sum/count — 0, avg/min/max/str — пусто, без ошибки (Review Focus 3)', async function () {
    const t = '[{d.cars[].qty:aggSum}|{d.cars[].qty:aggCount}|{d.cars[].qty:aggCountD}|{d.cars[].qty:aggAvg}|{d.cars[].qty:aggMin}|{d.cars[].qty:aggMax}|{d.cars[].qty:aggStr}|{d.cars[].qty:aggStrD}]';
    const want = '[0|0|0|||||]';
    assert.strictEqual(await text(t, { cars: [] }), want);
    assert.strictEqual(await text(t, {}), want);
    assert.strictEqual(await text(t, { cars: null }), want);
    assert.strictEqual(await text(t, { cars: [{ qty: null }] }), '[0|1|0|||||]');
  });
  it('фильтр, отбросивший всё, — пустой набор', async function () {
    assert.strictEqual(await text('[{d.cars[sort>100].qty:aggSum}|{d.cars[sort>100].qty:aggAvg}]', SIX), '[0|]');
  });
});

describe('EE платные: независимость от порядка меток (Review Focus 2)', function () {
  const rows = '| {d.cars[i].brand} | {d.cars[i].qty} |\n| {d.cars[i+1].brand} | |';
  it('итог до цикла и после цикла по тому же массиву', async function () {
    const before = await text('Итого {d.cars[].qty:aggSum}\n' + rows, SIX);
    const after = await text(rows + '\nИтого {d.cars[].qty:aggSum}', SIX);
    assert.strictEqual(before.split('\n')[0], 'Итого 21');
    assert.strictEqual(after.split('\n').pop(), 'Итого 21');
    assert.strictEqual(before.split('\n').slice(1).join('\n'), after.split('\n').slice(0, -1).join('\n'));
  });
  it('фильтр цикла в документе не влияет на итог «[]»', async function () {
    const t = '{d.cars[].qty:aggSum}\n| {d.cars[i, sort>1].brand} |\n| {d.cars[i+1].brand} |\n{d.cars[].qty:aggSum}';
    assert.strictEqual(await text(t, SIX), '21\n| Faraday |\n| Venturi |\n| Faraday |\n| Venturi |\n21');
  });
  it('итог внутри строки цикла того же массива', async function () {
    const t = '| {d.cars[i].brand} | {d.cars[].qty:aggSum} |\n| {d.cars[i+1].brand} | |';
    assert.deepStrictEqual(column(await text(t, SIX)), ['21', '21', '21', '21', '21', '21']);
  });
  it('итоги с одинаковой меткой в разных местах документа', async function () {
    const t = '{d.cars[].qty:aggSum}\n{d.cars[].qty:aggSum:formatN(2)}\n{d.cars[sort>1].qty:aggSum}';
    assert.strictEqual(await text(t, SIX), '21\n21,00\n19');
  });
});

describe('EE платные: ошибки агрегаторов', function () {
  it('значение во вложенном объекте под «[]» — ошибка с подсказкой print', async function () {
    const m = await rawError('{d[].sub.qty:aggSum}', [{ sub: { qty: 1 } }]);
    assert.strictEqual(m, 'Агрегатор aggSum не читает значение во вложенном объекте (sub.qty): используйте {d[]:print(.sub.qty):aggSum}. Source: "{d[].sub.qty:aggSum}"');
  });
  it('обход через print(.sub.qty) работает', async function () {
    assert.strictEqual(await text('{d[]:print(.sub.qty):aggSum}', [{ sub: { qty: 1 } }, { sub: { qty: 2 } }]), '3');
  });
  it('в цикле [i] вложенный путь обычный', async function () {
    const t = '| {d[i].sub.qty:cumSum} |\n| {d[i+1].sub.qty} |';
    assert.strictEqual(await text(t, [{ sub: { qty: 1 } }, { sub: { qty: 2 } }]), '| 1 |\n| 3 |');
  });
  it('cum* по «[]» — ошибка: нужен цикл [i]', async function () {
    assert.strictEqual(normalizeError(await rawError('{d.cars[].qty:cumSum}', SIX)), 'cumSum считает по строкам цикла: используйте [i], например {d.cars[i].qty:cumSum}.');
  });
  it('partition-by с «[]» — ошибка: группировка только в цикле', async function () {
    assert.strictEqual(normalizeError(await rawError('{d.cars[].qty:aggSum(.brand)}', SIX)), 'Группировка aggSum(.brand) работает только внутри цикла [i], например {d.cars[i].qty:aggSum(.brand)}.');
  });
  it('аргумент группировки без точки — ошибка', async function () {
    assert.strictEqual(normalizeError(await rawError('| {d.cars[i].qty:aggSum(brand)} |\n| {d.cars[i+1].qty} |', SIX)), 'Аргумент группировки aggSum — путь с точкой, например aggSum(.brand).');
  });
  it('агрегаторы в цепочке не подряд — ошибка', async function () {
    assert.strictEqual(normalizeError(await rawError('{d.cars[].qty:aggSum:mul(2):cumSum}', SIX)), 'Агрегаторы в цепочке форматтеров должны идти подряд.');
  });
  it('неизвестный форматтер до или после агрегатора — Source с исходной меткой, без служебных имён', async function () {
    const after = await rawError('{d.cars[].qty:aggSum:nope}', SIX);
    assert.match(after, /^Formatter "nope" does not exist\. Do you mean "[^"_]+"\? Source: "\{d\.cars\[\]\.qty:aggSum:nope\}"$/);
    const before = await rawError('{d.cars[].qty:nope:aggSum}', SIX);
    assert.match(before, /^Formatter "nope" does not exist\. Do you mean "[^"_]+"\? Source: "\{d\.cars\[\]\.qty:nope:aggSum\}"$/);
  });
  it('внутренние форматтеры не остаются в реестре', async function () {
    await text('{d.cars[].qty:aggSum}', SIX);
    assert.strictEqual(carbone.formatters.__aggOut, undefined);
    assert.strictEqual(carbone.formatters.__aggCollect, undefined);
  });
});

describe('EE платные: прочее', function () {
  it('агрегатор в колонтитуле (buildXML)', async function () {
    const builder = require('../lib/builder');
    const input = require('../lib/input');
    const result = await new Promise(function (resolve, reject) {
      input.parseOptions({}, reject, function (options) {
        builder.buildXML('<w:hdr><w:p><w:r><w:t>{d.cars[].qty:aggSum}</w:t></w:r></w:p></w:hdr>', SIX, options, function (err, xml) {
          return err ? reject(err) : resolve(xml);
        });
      });
    });
    assert.strictEqual(result, '<w:hdr><w:p><w:r><w:t>21</w:t></w:r></w:p></w:hdr>');
  });
  it('шаблон без агрегаторов: метки не переписываются', function (done) {
    const aggregate = require('../lib/aggregate');
    const markers = [{ pos: 1, name: '_root.d.cars[i].qty:formatN(2)' }];
    aggregate.run(markers, {}, { formatters: carbone.formatters }, null, function (err, result, formatters) {
      assert.strictEqual(err, null);
      assert.strictEqual(result, markers);
      assert.strictEqual(formatters, null);
      done();
    });
  });
  it('итог агрегатора записывается через :set', async function () {
    assert.strictEqual(await text('{d.cars[].qty:aggSum:set(c.t)}[{c.t}]', SIX), '[21]');
  });
  it('ODT: итог и нарастающий итог', async function () {
    const xml = '<office:text><text:p>{d.cars[].qty:aggSum}</text:p><table:table-row><table:table-cell><text:p>{d.cars[i].qty:cumSum}</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>{d.cars[i+1].qty}</text:p></table:table-cell></table:table-row></office:text>';
    const out = await new Promise((resolve, reject) => carbone.renderXML(xml, { cars: [{ qty: 1 }, { qty: 2 }] }, { extension: 'odt' }, (err, res) => err ? reject(err) : resolve(res)));
    assert.strictEqual(out, '<office:text><text:p>3</text:p><table:table-row><table:table-cell><text:p>1</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>3</text:p></table:table-cell></table:table-row></office:text>');
  });
});
