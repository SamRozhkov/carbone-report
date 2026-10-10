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

// ревью 2.2.0, раунд 1
function renderXml (xml, data) {
  return new Promise((resolve, reject) => carbone.renderXML(xml, data, {}, (err, res) => err ? reject(err) : resolve(res)));
}

describe('EE платные: циклы по ключу ([brand], [q]) — cum* и count() по видимым строкам', function () {
  const cars = { cars: [{ brand: 'A', q: 1 }, { brand: 'B', q: 2 }, { brand: 'A', q: 3 }, { brand: 'B', q: 4 }, { brand: 'C', q: 5 }] };
  const t = (marker) => '| {d.cars[brand].brand} | {d.cars[brand]' + marker + '} |\n| {d.cars[brand+1].brand} | |';
  it('count() — 1…N без пропусков', async function () {
    assert.deepStrictEqual(column(await text(t('.q:count()'), cars)), ['1', '2', '3']);
  });
  it('aggSum(.brand) — по всем элементам группы, :cumSum — по видимым строкам', async function () {
    assert.deepStrictEqual(column(await text(t('.q:aggSum(.brand)'), cars)), ['4', '6', '5']);
    assert.deepStrictEqual(column(await text(t('.q:aggSum(.brand):cumSum'), cars)), ['4', '10', '15']);
  });
  it('cumSum в цикле [q]: повтор ключа не считается', async function () {
    const s = '| {d.cars[q].q} | {d.cars[q].q:cumSum} |\n| {d.cars[q+1].q} | |';
    assert.strictEqual(await text(s, { cars: [{ q: 5 }, { q: 1 }, { q: 3 }, { q: 3 }] }), '| 1 | 1 |\n| 3 | 4 |\n| 5 | 9 |');
  });
  it('вложенный цикл под [brand]: cumSum по выведенным строкам', async function () {
    const data = { cars: [{ brand: 'A', items: [{ q: 1 }, { q: 2 }] }, { brand: 'A', items: [{ q: 100 }] }, { brand: 'B', items: [{ q: 10 }] }] };
    const s = '| {d.cars[brand].items[i].q} | {d.cars[brand].items[i].q:cumSum} |\n| {d.cars[brand].items[i+1].q} | |\n| {d.cars[brand+1].brand} | |';
    assert.strictEqual(await text(s, data), '| 1 | 1 |\n| 2 | 3 |\n| 10 | 13 |');
  });
});

describe('EE платные: ревью — ошибки и большие наборы', function () {
  it('условный вывод (show/elseShow) до агрегатора — ошибка с подсказкой фильтра', async function () {
    assert.strictEqual(normalizeError(await rawError('{d.x[].v:ifGT(1):show(5):aggSum}', { x: [{ v: 1 }, { v: 2 }] })),
      'Форматтер show перед агрегатором aggSum не поддерживается: отберите элементы фильтром в скобках, например {d.cars[qty>1].qty:aggSum}.');
    const m = await rawError('| {d.x[i].v:ifEQ(1):show(10):elseShow(0):cumSum} |\n| {d.x[i+1].v} |', { x: [{ v: 1 }] });
    assert.ok(m.endsWith(' Source: "{d.x[i].v:ifEQ(1):show(10):elseShow(0):cumSum}"'), m);
  });
  it('условие без show до агрегатора допустимо', async function () {
    assert.strictEqual(await text('{d.x[].v:ifGT(1):aggSum}', { x: [{ v: 1 }, { v: 2 }] }), '3');
  });
  it('метка в цикле без [i+1]: в ошибке исходная метка, без служебных имён', async function () {
    const m = await rawError('{d.cars[i].qty:cumSum:formatN(2)}', { cars: [{ qty: 1 }] });
    assert.ok(m.indexOf('{d.cars[i].qty:cumSum:formatN(2)}') !== -1 && m.indexOf('__agg') === -1, m);
    const g = await rawError('{d[i].c[].q:aggSum}', [{ c: [{ q: 1 }] }]);
    assert.ok(g.indexOf('{d[i].c[].q:aggSum}') !== -1 && g.indexOf('__agg') === -1, g);
  });
  it('строки из пробелов и шестнадцатеричные — не числа; экспонента — число', async function () {
    assert.strictEqual(await text('{d.x[].v:aggSum} {d.x[].v:aggMin}', { x: [{ v: '1e3' }, { v: '0x10' }, { v: ' ' }, { v: ' 2 ' }, { v: 'Infinity' }] }), '1002 2');
  });
  it('200 тыс. значений: aggMin/aggMax без переполнения стека', async function () {
    this.timeout(20000);
    const data = { r: Array.from({ length: 200000 }, (_, i) => ({ q: i })) };
    assert.strictEqual(await renderXml('<x>{d.r[].q:aggMin}|{d.r[].q:aggMax}</x>', data), '<x>0|199999</x>');
  });
  describe('50 тыс. строк — линейное время (каждая метка заметно быстрее 1,5 с)', function () {
    const rows = { r: Array.from({ length: 50000 }, (_, i) => ({ brand: 'b' + i, q: i })) };
    const cases = [
      '<x>{d.r[].brand:aggStrD}</x>',
      '<x>{d.r[].brand:aggCountD}</x>',
      '<x><t>{d.r[i].brand:cumCountD}</t><t>{d.r[i+1].brand}</t></x>',
      '<x><t>{d.r[i].q:aggSum}</t><t>{d.r[i+1].q}</t></x>'
    ];
    for (const xml of cases) {
      it(xml, async function () {
        this.timeout(30000);
        const start = Date.now();
        await renderXml(xml, rows);
        const ms = Date.now() - start;
        assert.ok(ms < 1500, xml + ': ' + ms + ' мс');
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// drop / keep (спецификация §31.2, справочник §2)

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

// XML правильно вложен (без парсера: стек тегов)
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
  assert.ok(!/[]/.test(xml), 'жетон drop остался в ' + xml);
}

const wp = (t) => '<w:p><w:r><w:t>' + t + '</w:t></w:r></w:p>';
const wtc = (t) => '<w:tc>' + wp(t) + '</w:tc>';
const wtr = (...cells) => '<w:tr>' + cells.map(wtc).join('') + '</w:tr>';
const wtbl = (cols, ...rows) => '<w:tbl><w:tblPr/><w:tblGrid>' + '<w:gridCol w:w="1"/>'.repeat(cols) + '</w:tblGrid>' + rows.join('') + '</w:tbl>';
const docx = (inner) => renderAs('docx', '<w:body>' + inner + '</w:body>', DROP_DATA);
const DROP_DATA = { yes: true, no: false, empty: '', text: 'x', cars: [{ n: 'A', ok: true }, { n: 'B', ok: false }, { n: 'C', ok: true }, { n: 'D', ok: false }] };

describe('EE платные: drop/keep — условие', function () {
  const cases = [
    // [метка, удалён ли абзац]
    ['{d.yes:ifEQ(true):drop(p)}', true],
    ['{d.no:ifEQ(true):drop(p)}', false],
    ['{d.yes:drop(p)}', true],
    ['{d.no:drop(p)}', false],
    ['{d.text:drop(p)}', true],
    ['{d.empty:drop(p)}', false],
    ['{d.missing:drop(p)}', false],
    ['{d.empty:ifEM:drop(p)}', true],
    ['{d.yes:ifEQ(true):keep(p)}', false],
    ['{d.no:ifEQ(true):keep(p)}', true],
    ['{d.no:keep(p)}', true],
    ['{d.yes:ifEQ(true):and(.no):ifEQ(true):drop(p)}', false],
    ['{d.yes:ifEQ(true):or(.no):ifEQ(true):drop(p)}', true]
  ];
  // правило истинности без ifXX (§31.2): флаги 0/1 и 'false' из БД
  const values = [
    [0, false], [1, true], [-2, true], [0.5, true], [NaN, false],
    ['0', false], ['1', true], ['false', false], ['FALSE', false], [' false ', false], ['  ', false], ['true', true], ['нет', true],
    [null, false], [[], false], [[0], true], [{}, false], [{ a: 1 }, true]
  ];
  for (const [v, removed] of values) {
    it('{d.v:drop(p)} при v = ' + JSON.stringify(v) + (Number.isNaN(v) ? ' (NaN)' : '') + (removed ? ' → удалён' : ' → остался'), async function () {
      const out = await renderAs('docx', '<w:body>' + wp('a{d.v:drop(p)}') + wp('b') + '</w:body>', { v });
      assert.strictEqual(out, '<w:body>' + (removed ? '' : wp('a')) + wp('b') + '</w:body>');
    });
  }
  it('флаг 0/1 в цикле: {d.rows[i].archived:drop(row)} удаляет только archived = 1, keep — наоборот', async function () {
    const rows = { rows: [{ n: 'A', archived: 0 }, { n: 'B', archived: 1 }, { n: 'C', archived: 0 }, { n: 'D', archived: '1' }, { n: 'E', archived: 'false' }] };
    const t = (f) => '<w:body>' + wtbl(1, wtr('{d.rows[i].n}{d.rows[i].archived:' + f + '(row)}'), wtr('{d.rows[i+1].n}')) + '</w:body>';
    assert.strictEqual(await renderAs('docx', t('drop'), rows), '<w:body>' + wtbl(1, wtr('A'), wtr('C'), wtr('E')) + '</w:body>');
    assert.strictEqual(await renderAs('docx', t('keep'), rows), '<w:body>' + wtbl(1, wtr('B'), wtr('D')) + '</w:body>');
  });
  for (const [marker, removed] of cases) {
    it(marker + (removed ? ' → удалён' : ' → остался'), async function () {
      const out = await docx(wp('до') + wp('a' + marker + 'b') + wp('после'));
      assert.strictEqual(out, '<w:body>' + wp('до') + (removed ? '' : wp('ab')) + wp('после') + '</w:body>');
    });
  }
  it('метка ничего не печатает и не оставляет жетонов', async function () {
    const out = await docx(wp('x{d.no:drop(p)}y'));
    assert.strictEqual(out, '<w:body>' + wp('xy') + '</w:body>');
    assertWellFormed(out);
  });
  it('аргумент в кавычках и пробелы: drop(\'p\', 2)', async function () {
    assert.strictEqual(await docx(wp('1{d.yes:drop( \'p\' , 2 )}') + wp('2') + wp('3')), '<w:body>' + wp('3') + '</w:body>');
  });
});

describe('EE платные: drop/keep — DOCX', function () {
  it('drop(p, 3): текущий и два следующих абзаца', async function () {
    const out = await docx(wp('0') + wp('1{d.yes:drop(p, 3)}') + wp('2') + wp('3') + wp('4'));
    assert.strictEqual(out, '<w:body>' + wp('0') + wp('4') + '</w:body>');
  });
  it('drop(p, 3) у последних абзацев — удаляется сколько есть', async function () {
    assert.strictEqual(await docx(wp('0') + wp('1{d.yes:drop(p, 3)}') + wp('2')), '<w:body>' + wp('0') + '</w:body>');
  });
  it('drop(row) в цикле [i] — удаляются только строки, где условие истинно', async function () {
    const out = await docx(wtbl(1, wtr('H'), wtr('{d.cars[i].n}{d.cars[i].ok:ifEQ(false):drop(row)}'), wtr('{d.cars[i+1].n}')));
    assert.strictEqual(out, '<w:body>' + wtbl(1, wtr('H'), wtr('A'), wtr('C')) + '</w:body>');
  });
  it('keep(row) в цикле — обратное', async function () {
    const out = await docx(wtbl(1, wtr('{d.cars[i].n}{d.cars[i].ok:keep(row)}'), wtr('{d.cars[i+1].n}')));
    assert.strictEqual(out, '<w:body>' + wtbl(1, wtr('A'), wtr('C')) + '</w:body>');
  });
  it('drop(row, 2): строка и следующая', async function () {
    const out = await docx(wtbl(1, wtr('1{d.yes:drop(row, 2)}'), wtr('2'), wtr('3')));
    assert.strictEqual(out, '<w:body>' + wtbl(1, wtr('3')) + '</w:body>');
  });
  it('drop(row) ложно — строка остаётся', async function () {
    const out = await docx(wtbl(1, wtr('1{d.no:drop(row)}'), wtr('2')));
    assert.strictEqual(out, '<w:body>' + wtbl(1, wtr('1'), wtr('2')) + '</w:body>');
  });
  it('Review Focus 4: drop(row) во всех строках — таблица удаляется целиком', async function () {
    const out = await docx(wp('до') + wtbl(1, wtr('{d.cars[i].n}{d.cars[i].n:drop(row)}'), wtr('{d.cars[i+1].n}')) + wp('после'));
    assert.strictEqual(out, '<w:body>' + wp('до') + wp('после') + '</w:body>');
  });
  it('Review Focus 4: заголовок остаётся — таблица с одной строкой заголовка', async function () {
    const out = await docx(wtbl(1, wtr('H'), wtr('{d.cars[i].n}{d.cars[i].n:drop(row)}'), wtr('{d.cars[i+1].n}')));
    assert.strictEqual(out, '<w:body>' + wtbl(1, wtr('H')) + '</w:body>');
  });
  it('Review Focus 4: таблица внутри ячейки удалена — ячейка всё равно кончается абзацем', async function () {
    const inner = wtbl(1, wtr('{d.yes:drop(row)}'));
    const out = await docx(wtbl(1, '<w:tr><w:tc>' + wp('x') + inner + wp('') + '</w:tc></w:tr>'));
    assert.strictEqual(out, '<w:body>' + wtbl(1, '<w:tr><w:tc>' + wp('x') + wp('') + '</w:tc></w:tr>') + '</w:body>');
    const out2 = await docx(wtbl(1, '<w:tr><w:tc>' + inner + '<w:p/>' + '</w:tc></w:tr>'));
    assertWellFormed(out2);
    assert.ok(/<w:tc><w:p\/><\/w:tc>/.test(out2), out2);
  });
  it('drop(p) единственного абзаца ячейки — в ячейке остаётся пустой абзац', async function () {
    const out = await docx(wtbl(1, wtr('{d.yes:drop(p)}')));
    assert.strictEqual(out, '<w:body>' + wtbl(1, '<w:tr><w:tc><w:p/></w:tc></w:tr>') + '</w:body>');
  });
  it('drop(table)', async function () {
    assert.strictEqual(await docx(wp('до') + wtbl(1, wtr('x{d.yes:drop(table)}')) + wp('после')), '<w:body>' + wp('до') + wp('после') + '</w:body>');
    assert.strictEqual(await docx(wtbl(1, wtr('x{d.no:drop(table)}'))), '<w:body>' + wtbl(1, wtr('x')) + '</w:body>');
  });
  it('drop(col): ячейки столбца во всех строках и w:gridCol', async function () {
    const out = await docx(wtbl(3, wtr('a', 'b{d.yes:drop(col)}', 'c'), wtr('{d.cars[i].n}', '{d.cars[i].ok}', 'z'), wtr('{d.cars[i+1].n}', '', '')));
    const want = wtbl(2, wtr('a', 'c'), wtr('A', 'z'), wtr('B', 'z'), wtr('C', 'z'), wtr('D', 'z'));
    assert.strictEqual(out, '<w:body>' + want + '</w:body>');
  });
  it('drop(col) двух столбцов и keep(col)', async function () {
    const out = await docx(wtbl(3, wtr('a{d.yes:drop(col)}', 'b', 'c{d.no:keep(col)}'), wtr('1', '2', '3')));
    assert.strictEqual(out, '<w:body>' + wtbl(1, wtr('b'), wtr('2')) + '</w:body>');
  });
  it('drop(col) всех столбцов — таблица удаляется', async function () {
    assert.strictEqual(await docx(wp('до') + wtbl(1, wtr('a{d.yes:drop(col)}'), wtr('1'))), '<w:body>' + wp('до') + '</w:body>');
  });
  it('drop(col) в таблице с объединёнными ячейками — ошибка', async function () {
    const merged = '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' + wp('ab') + '</w:tc></w:tr>';
    const msg = await renderError('docx', '<w:body>' + wtbl(2, wtr('a{d.yes:drop(col)}', 'b'), merged) + '</w:body>', DROP_DATA);
    assert.match(msg, /^drop\(col\) не поддерживается в таблицах с объединёнными по горизонтали ячейками\. Source: "\{d\.yes:drop\(col\)\}"$/);
  });
  const drawing = (inner, descr) => '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="x" descr="' + descr + '"/><a:graphic><a:graphicData>' + inner + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>' + '<w:r><w:t>текст</w:t></w:r></w:p>';
  const pic = '<pic:pic><pic:blipFill/></pic:pic>';
  const chart = '<c:chart r:id="rId5"/>';
  it('drop(img): метка в замещающем тексте, удаляется w:drawing', async function () {
    assert.strictEqual(await docx(drawing(pic, '{d.yes:drop(img)}')), '<w:body><w:p><w:r></w:r><w:r><w:t>текст</w:t></w:r></w:p></w:body>');
    assert.strictEqual(await docx(drawing(pic, 'фото{d.no:drop(img)}')), '<w:body>' + drawing(pic, 'фото') + '</w:body>');
  });
  it('drop(chart)', async function () {
    assert.strictEqual(await docx(drawing(chart, '{d.yes:drop(chart)}')), '<w:body><w:p><w:r></w:r><w:r><w:t>текст</w:t></w:r></w:p></w:body>');
  });
  it('drop(shape): удаляется mc:AlternateContent вместе с запасным VML', async function () {
    const shape = '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr id="2" name="s" descr="{d.yes:drop(shape)}"/><a:graphic><a:graphicData><wps:wsp/></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:rect alt="{d.yes:drop(shape)}"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>';
    assert.strictEqual(await docx(shape), '<w:body><w:p><w:r></w:r></w:p></w:body>');
  });
  it('drop(img) у диаграммы — метка не в изображении, ошибка', async function () {
    const msg = await renderError('docx', '<w:body>' + drawing(chart, '{d.yes:drop(img)}') + '</w:body>', DROP_DATA);
    assert.strictEqual(msg, 'Для drop(img) метка должна стоять в замещающем тексте (названии или описании) изображения. Source: "{d.yes:drop(img)}"');
  });
  it('шаблон собран из DOCX: renderBuffer, текст результата', async function () {
    const t = 'до\n{d.yes:drop(p)}удалить\n| H |\n| {d.cars[i].n}{d.cars[i].ok:ifEQ(false):drop(row)} |\n| {d.cars[i+1].n} |\n{d.no:keep(p)}тоже удалить\nпосле';
    assert.strictEqual(await text(t, DROP_DATA), 'до\n| H |\n| A |\n| C |\nпосле');
  });
  it('Review Focus 4 на DOCX-файле: все строки удалены — таблицы нет, документ валиден', async function () {
    const t = 'до\n| {d.cars[i].n}{d.cars[i].n:drop(row)} |\n| {d.cars[i+1].n} |\nпосле';
    const out = await renderBuffer(await buildDocx(t), 'docx', DROP_DATA, RU);
    assert.strictEqual(await docxText(out), 'до\nпосле');
  });
});

describe('EE платные: drop/keep — ODT', function () {
  const odt = (xml) => renderAs('odt', '<office:text>' + xml + '</office:text>', DROP_DATA);
  const tp = (t) => '<text:p>' + t + '</text:p>';
  const row = (...cells) => '<table:table-row>' + cells.map((c) => '<table:table-cell>' + tp(c) + '</table:table-cell>').join('') + '</table:table-row>';
  it('text:p и drop(p, 3)', async function () {
    assert.strictEqual(await odt(tp('1') + tp('2{d.yes:drop(p)}') + tp('3')), '<office:text>' + tp('1') + tp('3') + '</office:text>');
    assert.strictEqual(await odt(tp('1{d.yes:drop(p, 3)}') + '<text:h>h</text:h>' + tp('2') + tp('3') + tp('4')), '<office:text><text:h>h</text:h>' + tp('4') + '</office:text>');
    assert.strictEqual(await odt(tp('2{d.no:drop(p)}')), '<office:text>' + tp('2') + '</office:text>');
  });
  it('text:h и drop(h)', async function () {
    assert.strictEqual(await odt('<text:h text:outline-level="1">Глава{d.yes:drop(h)}</text:h>' + tp('x')), '<office:text>' + tp('x') + '</office:text>');
  });
  it('text:list-item и drop(item) в цикле', async function () {
    const xml = '<text:list><text:list-item>' + tp('{d.cars[i].n}{d.cars[i].ok:keep(item)}') + '</text:list-item><text:list-item>' + tp('{d.cars[i+1].n}') + '</text:list-item></text:list>';
    assert.strictEqual(await odt(xml), '<office:text><text:list><text:list-item>' + tp('A') + '</text:list-item><text:list-item>' + tp('C') + '</text:list-item></text:list></office:text>');
  });
  it('table:table-row в цикле и drop(row, 2)', async function () {
    const loop = '<table:table><table:table-column/>' + row('{d.cars[i].n}{d.cars[i].ok:ifEQ(false):drop(row)}') + row('{d.cars[i+1].n}') + '</table:table>';
    assert.strictEqual(await odt(loop), '<office:text><table:table><table:table-column/>' + row('A') + row('C') + '</table:table></office:text>');
    const two = '<table:table><table:table-column/>' + row('1{d.yes:drop(row, 2)}') + row('2') + row('3') + '</table:table>';
    assert.strictEqual(await odt(two), '<office:text><table:table><table:table-column/>' + row('3') + '</table:table></office:text>');
  });
  it('все строки удалены — таблица удаляется', async function () {
    const xml = tp('до') + '<table:table><table:table-column/><table:table-header-rows>' + row('{d.yes:drop(row)}') + '</table:table-header-rows>' + row('x{d.yes:drop(row)}') + '</table:table>';
    assert.strictEqual(await odt(xml), '<office:text>' + tp('до') + '</office:text>');
  });
  it('drop(table)', async function () {
    assert.strictEqual(await odt('<table:table>' + row('{d.yes:drop(table)}') + '</table:table>' + tp('x')), '<office:text>' + tp('x') + '</office:text>');
  });
  it('drop(col) с повторёнными столбцами', async function () {
    const xml = '<table:table><table:table-column table:number-columns-repeated="3"/>' + row('a', 'b{d.yes:drop(col)}', 'c') + '<table:table-row><table:table-cell table:number-columns-repeated="3"/></table:table-row></table:table>';
    assert.strictEqual(await odt(xml), '<office:text><table:table><table:table-column table:number-columns-repeated="2"/>' + row('a', 'c') + '<table:table-row><table:table-cell table:number-columns-repeated="2"/></table:table-row></table:table></office:text>');
  });
  it('drop(col) с объединением по горизонтали — ошибка', async function () {
    const xml = '<office:text><table:table>' + row('a{d.yes:drop(col)}', 'b') + '<table:table-row><table:table-cell table:number-columns-spanned="2">' + tp('ab') + '</table:table-cell><table:covered-table-cell/></table:table-row></table:table></office:text>';
    assert.match(await renderError('odt', xml, DROP_DATA), /^drop\(col\) не поддерживается в таблицах с объединёнными/);
  });
  it('drop(img), drop(chart), drop(shape): метка в svg:title / svg:desc', async function () {
    const frame = (inner, title) => '<draw:frame draw:name="f"><svg:title>' + title + '</svg:title>' + inner + '</draw:frame>';
    assert.strictEqual(await odt(tp('a' + frame('<draw:image xlink:href="p.png"/>', '{d.yes:drop(img)}') + 'b')), '<office:text>' + tp('ab') + '</office:text>');
    assert.strictEqual(await odt(tp(frame('<draw:object xlink:href="./Object 1"/>', '{d.yes:drop(chart)}'))), '<office:text>' + tp('') + '</office:text>');
    assert.strictEqual(await odt(tp('<draw:custom-shape><svg:desc>{d.yes:drop(shape)}</svg:desc><draw:enhanced-geometry/></draw:custom-shape>')), '<office:text>' + tp('') + '</office:text>');
    assert.strictEqual(await odt(tp(frame('<draw:image/>', 'фото{d.no:drop(img)}'))), '<office:text>' + tp(frame('<draw:image/>', 'фото')) + '</office:text>');
  });
});

describe('EE платные: drop/keep — XLSX', function () {
  const c = (t) => '<c t="inlineStr"><is><t>' + t + '</t></is></c>';
  const row = (...cells) => '<row>' + cells.map(c).join('') + '</row>';
  const sheet = (inner, cols) => '<worksheet>' + (cols || '') + '<sheetData>' + inner + '</sheetData></worksheet>';
  it('row в цикле и drop(row, 2)', async function () {
    assert.strictEqual(await renderAs('xlsx', sheet(row('H') + row('{d.cars[i].n}{d.cars[i].ok:ifEQ(false):drop(row)}') + row('{d.cars[i+1].n}')), DROP_DATA), sheet(row('H') + row('A') + row('C')));
    assert.strictEqual(await renderAs('xlsx', sheet(row('1{d.yes:drop(row, 2)}') + row('2') + row('3')), DROP_DATA), sheet(row('3')));
  });
  it('все строки удалены — пустой sheetData допустим', async function () {
    assert.strictEqual(await renderAs('xlsx', sheet(row('{d.cars[i].n}{d.cars[i].n:drop(row)}') + row('{d.cars[i+1].n}')), DROP_DATA), sheet(''));
  });
  it('drop(col): ячейки и диапазоны <col min max>', async function () {
    const cols = '<cols><col min="1" max="1" width="5"/><col min="2" max="2" width="9"/><col min="3" max="5" width="7"/></cols>';
    const out = await renderAs('xlsx', sheet(row('a', 'b{d.yes:drop(col)}', 'c') + row('1', '2', '3'), cols), DROP_DATA);
    assert.strictEqual(out, sheet(row('a', 'c') + row('1', '3'), '<cols><col min="1" max="1" width="5"/><col min="2" max="4" width="7"/></cols>'));
  });
});

describe('EE платные: drop/keep — ODS', function () {
  const cell = (t) => '<table:table-cell office:value-type="string"><text:p>' + t + '</text:p></table:table-cell>';
  const row = (...cells) => '<table:table-row>' + cells.map(cell).join('') + '</table:table-row>';
  const ods = (...sheets) => '<office:spreadsheet>' + sheets.join('') + '</office:spreadsheet>';
  const sheet = (name, inner) => '<table:table table:name="' + name + '"><table:table-column table:number-columns-repeated="2"/>' + inner + '</table:table>';
  it('table:table-row в цикле', async function () {
    const out = await renderAs('ods', ods(sheet('L', row('{d.cars[i].n}{d.cars[i].ok:keep(row)}', 'x') + row('{d.cars[i+1].n}', ''))), DROP_DATA);
    assert.strictEqual(out, ods(sheet('L', row('A', 'x') + row('C', 'x'))));
  });
  it('все строки листа удалены — остаётся одна пустая строка', async function () {
    const out = await renderAs('ods', ods(sheet('L', row('{d.yes:drop(row)}', 'x'))), DROP_DATA);
    assert.strictEqual(out, ods(sheet('L', '<table:table-row><table:table-cell/></table:table-row>')));
  });
  it('drop(sheet)', async function () {
    const out = await renderAs('ods', ods(sheet('A', row('{d.yes:drop(sheet)}', '')), sheet('B', row('b', ''))), DROP_DATA);
    assert.strictEqual(out, ods(sheet('B', row('b', ''))));
  });
  it('drop(sheet) всех листов — ошибка', async function () {
    const msg = await renderError('ods', ods(sheet('A', row('{d.yes:drop(sheet)}', ''))), DROP_DATA);
    assert.strictEqual(msg, 'drop(sheet) удалил бы все листы: хотя бы один лист должен остаться. Source: "{d.yes:drop(sheet)}"');
  });
  it('drop(col) с повторёнными ячейками', async function () {
    const xml = ods('<table:table table:name="L"><table:table-column table:number-columns-repeated="3"/>' + row('a{d.yes:drop(col)}', 'b', 'c') + '<table:table-row><table:table-cell table:number-columns-repeated="3"/></table:table-row></table:table>');
    assert.strictEqual(await renderAs('ods', xml, DROP_DATA), ods('<table:table table:name="L"><table:table-column table:number-columns-repeated="2"/>' + row('b', 'c') + '<table:table-row><table:table-cell table:number-columns-repeated="2"/></table:table-row></table:table>'));
  });
  it('drop(img)', async function () {
    const xml = ods(sheet('L', '<table:table-row><table:table-cell><draw:frame><svg:title>{d.yes:drop(img)}</svg:title><draw:image/></draw:frame></table:table-cell></table:table-row>'));
    assert.strictEqual(await renderAs('ods', xml, DROP_DATA), ods(sheet('L', '<table:table-row><table:table-cell></table:table-cell></table:table-row>')));
  });
});

describe('EE платные: drop/keep — PPTX', function () {
  const ap = (t) => '<a:p><a:r><a:t>' + t + '</a:t></a:r></a:p>';
  const sp = (descr, ...paras) => '<p:sp><p:nvSpPr><p:cNvPr id="2" name="s" descr="' + descr + '"/></p:nvSpPr><p:txBody><a:bodyPr/>' + paras.join('') + '</p:txBody></p:sp>';
  const slide = (inner) => '<p:sld><p:cSld><p:spTree>' + inner + '</p:spTree></p:cSld></p:sld>';
  const pptx = (inner) => renderAs('pptx', slide(inner), DROP_DATA);
  const atr = (...cells) => '<a:tr h="1">' + cells.map((t) => '<a:tc><a:txBody><a:bodyPr/>' + ap(t) + '</a:txBody></a:tc>').join('') + '</a:tr>';
  const frame = (cols, ...rows) => '<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblGrid>' + '<a:gridCol w="1"/>'.repeat(cols) + '</a:tblGrid>' + rows.join('') + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  it('a:p и drop(p, 2)', async function () {
    assert.strictEqual(await pptx(sp('', ap('1'), ap('2{d.yes:drop(p, 2)}'), ap('3'), ap('4'))), slide(sp('', ap('1'), ap('4'))));
  });
  it('все абзацы фигуры удалены — остаётся пустой a:p', async function () {
    assert.strictEqual(await pptx(sp('', ap('1{d.yes:drop(p)}'))), slide(sp('', '<a:p/>')));
  });
  it('p:sp и drop(shape) в замещающем тексте; keep(shape)', async function () {
    assert.strictEqual(await pptx(sp('{d.yes:drop(shape)}', ap('x')) + sp('', ap('y'))), slide(sp('', ap('y'))));
    assert.strictEqual(await pptx(sp('{d.yes:keep(shape)}', ap('x'))), slide(sp('', ap('x'))));
  });
  it('p:pic и drop(img)', async function () {
    const pic = (descr) => '<p:pic><p:nvPicPr><p:cNvPr id="3" name="p" descr="' + descr + '"/></p:nvPicPr><p:blipFill/></p:pic>';
    assert.strictEqual(await pptx(pic('{d.yes:drop(img)}') + sp('', ap('y'))), slide(sp('', ap('y'))));
  });
  it('p:graphicFrame: drop(chart) и drop(table)', async function () {
    const chart = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="c" descr="{d.yes:drop(chart)}"/></p:nvGraphicFramePr><a:graphic><a:graphicData><c:chart r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>';
    assert.strictEqual(await pptx(chart + sp('', ap('y'))), slide(sp('', ap('y'))));
    assert.strictEqual(await pptx(frame(1, atr('{d.yes:drop(table)}')) + sp('', ap('y'))), slide(sp('', ap('y'))));
  });
  it('a:tr в цикле, все строки удалены — удаляется p:graphicFrame', async function () {
    assert.strictEqual(await pptx(frame(1, atr('{d.cars[i].n}{d.cars[i].ok:ifEQ(false):drop(row)}'), atr('{d.cars[i+1].n}'))), slide(frame(1, atr('A'), atr('C'))));
    assert.strictEqual(await pptx(frame(1, atr('{d.cars[i].n}{d.cars[i].n:drop(row)}'), atr('{d.cars[i+1].n}'))), slide(''));
  });
  it('drop(col)', async function () {
    assert.strictEqual(await pptx(frame(2, atr('a', 'b{d.yes:drop(col)}'), atr('1', '2'))), slide(frame(1, atr('a'), atr('1'))));
  });
});

describe('EE платные: drop/keep — ODP', function () {
  const page = (name, inner) => '<draw:page draw:name="' + name + '">' + inner + '</draw:page>';
  const odp = (...pages) => '<office:presentation>' + pages.join('') + '</office:presentation>';
  const box = (inner) => '<draw:frame><draw:text-box>' + inner + '</draw:text-box></draw:frame>';
  it('drop(slide)', async function () {
    const out = await renderAs('odp', odp(page('1', box('<text:p>{d.yes:drop(slide)}</text:p>')), page('2', box('<text:p>b</text:p>'))), DROP_DATA);
    assert.strictEqual(out, odp(page('2', box('<text:p>b</text:p>'))));
  });
  it('drop(slide) всех слайдов — ошибка', async function () {
    const msg = await renderError('odp', odp(page('1', box('<text:p>{d.yes:drop(slide)}</text:p>'))), DROP_DATA);
    assert.strictEqual(msg, 'drop(slide) удалил бы все слайды презентации: хотя бы один слайд должен остаться. Source: "{d.yes:drop(slide)}"');
  });
  it('drop(p), drop(item), drop(shape) в текстовом блоке', async function () {
    const out = await renderAs('odp', odp(page('1', box('<text:p>a{d.yes:drop(p)}</text:p><text:list><text:list-item><text:p>i{d.yes:drop(item)}</text:p></text:list-item></text:list><text:p>b</text:p>') + box('<text:p>{d.yes:drop(shape)}</text:p>'))), DROP_DATA);
    assert.strictEqual(out, odp(page('1', box('<text:list></text:list><text:p>b</text:p>'))));
  });
  it('drop(table) — удаляется фрейм таблицы; drop(row)', async function () {
    const tbl = (rows) => '<draw:frame><table:table>' + rows + '</table:table></draw:frame>';
    const row = (t) => '<table:table-row><table:table-cell><text:p>' + t + '</text:p></table:table-cell></table:table-row>';
    assert.strictEqual(await renderAs('odp', odp(page('1', tbl(row('{d.yes:drop(table)}')))), DROP_DATA), odp(page('1', '')));
    assert.strictEqual(await renderAs('odp', odp(page('1', tbl(row('a{d.yes:drop(row)}') + row('b')))), DROP_DATA), odp(page('1', tbl(row('b')))));
    assert.strictEqual(await renderAs('odp', odp(page('1', tbl(row('a{d.yes:drop(row)}')))), DROP_DATA), odp(page('1', '')));
  });
});

describe('EE платные: drop/keep — ошибки шаблона (Review Focus 5)', function () {
  const unsupported = [
    ['xlsx', '<worksheet><sheetData><row><c><is><t>{d.yes:drop(p)}</t></is></c></row></sheetData></worksheet>', 'drop(p) не поддерживается в XLSX. Доступно: row, col.', '{d.yes:drop(p)}'],
    ['xlsx', '<worksheet><sheetData><row><c><is><t>{d.yes:keep(img)}</t></is></c></row></sheetData></worksheet>', 'keep(img) не поддерживается в XLSX. Доступно: row, col.', '{d.yes:keep(img)}'],
    ['ods', '<office:spreadsheet><table:table><table:table-row><table:table-cell><text:p>{d.yes:drop(p)}</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>', 'drop(p) не поддерживается в ODS. Доступно: row, col, img, sheet.', '{d.yes:drop(p)}'],
    ['ods', '<office:spreadsheet><table:table><table:table-row><table:table-cell><text:p>{d.yes:drop(table)}</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>', 'drop(table) не поддерживается в ODS. Доступно: row, col, img, sheet.', '{d.yes:drop(table)}'],
    ['pptx', '<p:sld><a:p><a:r><a:t>{d.yes:drop(slide)}</a:t></a:r></a:p></p:sld>', 'drop(slide) не поддерживается в PPTX. Доступно: p, row, table, img, shape, chart, col.', '{d.yes:drop(slide)}'],
    ['docx', '<w:body><w:p><w:r><w:t>{d.yes:drop(h)}</w:t></w:r></w:p></w:body>', 'drop(h) не поддерживается в DOCX. Доступно: p, row, table, img, shape, chart, col.', '{d.yes:drop(h)}'],
    ['docx', '<w:body><w:p><w:r><w:t>{d.yes:drop(item)}</w:t></w:r></w:p></w:body>', 'drop(item) не поддерживается в DOCX. Доступно: p, row, table, img, shape, chart, col.', '{d.yes:drop(item)}'],
    ['odt', '<office:text><text:p>{d.yes:drop(slide)}</text:p></office:text>', 'drop(slide) не поддерживается в ODT. Доступно: p, row, table, img, shape, chart, col, item, h.', '{d.yes:drop(slide)}'],
    ['odp', '<office:presentation><draw:page><text:p>{d.yes:drop(sheet)}</text:p></draw:page></office:presentation>', 'drop(sheet) не поддерживается в ODP. Доступно: p, row, table, img, shape, chart, col, slide, item.', '{d.yes:drop(sheet)}'],
    ['docx', '<w:body><w:p><w:r><w:t>{d.yes:drop(div)}</w:t></w:r></w:p></w:body>', 'drop(div) не поддерживается в DOCX. Доступно: p, row, table, img, shape, chart, col.', '{d.yes:drop(div)}'],
    ['html', '<p>{d.yes:drop(p)}</p>', 'drop(p) не поддерживается в HTML.', '{d.yes:drop(p)}']
  ];
  for (const [ext, xml, message, source] of unsupported) {
    it(ext + ': ' + source, async function () {
      assert.strictEqual(await renderError(ext, xml, DROP_DATA), message + ' Source: "' + source + '"');
    });
  }
  it('ошибка не зависит от условия и данных (проверка до сборки)', async function () {
    const xml = '<worksheet><sheetData><row><c><is><t>{d.cars[i].n:drop(p)}</t></is></c></row><row><c><is><t>{d.cars[i+1].n}</t></is></c></row></sheetData></worksheet>';
    assert.match(await renderError('xlsx', xml, { cars: [] }), /^drop\(p\) не поддерживается в XLSX/);
  });
  it('неподдержанное сочетание в DOCX-файле — отклонённый промис, а не повреждённый файл', async function () {
    assert.strictEqual(normalizeError(await rawError('{d.yes:drop(slide)}', DROP_DATA)), 'drop(slide) не поддерживается в DOCX. Доступно: p, row, table, img, shape, chart, col.');
  });
  const docxErrors = [
    ['{d.yes:drop}', 'Укажите, что удалять: например drop(p) — абзац или drop(row) — строку таблицы.'],
    ['{d.yes:drop()}', 'Укажите, что удалять: например drop(p) — абзац или drop(row) — строку таблицы.'],
    ['{d.yes:drop(table, 2)}', 'Количество во втором аргументе drop задаётся только для p и row.'],
    ['{d.yes:drop(p, 0)}', 'Второй аргумент drop — целое число от 1: сколько элементов удалить, считая текущий.'],
    ['{d.yes:drop(p, x)}', 'Второй аргумент drop — целое число от 1: сколько элементов удалить, считая текущий.'],
    ['{d.yes:drop(p, 2, 3)}', 'У drop не больше двух аргументов: элемент и количество, например drop(p, 3).'],
    ['{d.yes:keep(p):upper}', 'keep должен быть последним форматтером метки: он ничего не печатает, а удаляет элемент документа.'],
    ['{d.yes:drop(row)}', 'Для drop(row) метка должна стоять внутри строки таблицы.'],
    ['{d.no:drop(table)}', 'Для drop(table) метка должна стоять внутри таблицы.'],
    ['{d.yes:drop(col)}', 'Для drop(col) метка должна стоять в ячейке таблицы.']
  ];
  for (const [marker, message] of docxErrors) {
    it(marker, async function () {
      // Source — метка после разбора: пробелы после запятых в аргументах убраны
      assert.strictEqual(await rawError('до\n' + marker + '\nпосле', DROP_DATA), message + ' Source: "' + marker.replace(/, /g, ',') + '"');
    });
  }
  it('ошибка в метке с агрегатором показывает исходную метку', async function () {
    assert.strictEqual(await rawError('{d.cars[].n:aggCount:ifGT(3):drop(row)}', DROP_DATA), 'Для drop(row) метка должна стоять внутри строки таблицы. Source: "{d.cars[].n:aggCount:ifGT(3):drop(row)}"');
  });
});

describe('EE платные: drop/keep — прочее', function () {
  it('агрегатор как условие: {d.cars[].n:aggCount:ifGT(3):drop(p)}', async function () {
    assert.strictEqual(await text('до\n{d.cars[].n:aggCount:ifGT(3):drop(p)}много\n{d.cars[].n:aggCount:ifGT(9):drop(p)}мало', DROP_DATA), 'до\nмало');
  });
  it('шаблон без drop/keep с символами частного использования в данных не меняется', async function () {
    assert.strictEqual(await renderAs('docx', '<w:p><w:r><w:t>{d.v}</w:t></w:r></w:p>', { v: '0' }), '<w:p><w:r><w:t>0</w:t></w:r></w:p>');
  });
  it('drop в колонтитуле (отдельный XML) — своя нумерация меток', async function () {
    const builder = require('../lib/builder');
    const opts = { formatters: carbone.formatters, extension: 'docx' };
    const run = (xml) => new Promise((resolve, reject) => builder.buildXML(xml, DROP_DATA, opts, (err, res) => err ? reject(err) : resolve(res)));
    assert.strictEqual(await run('<w:hdr>' + wp('a{d.yes:drop(p)}') + wp('b') + '</w:hdr>'), '<w:hdr>' + wp('b') + '</w:hdr>');
    assert.strictEqual(await run('<w:ftr>' + wp('c') + wp('d{d.no:drop(p)}') + '</w:ftr>'), '<w:ftr>' + wp('c') + wp('d') + '</w:ftr>');
  });
  it('10 тыс. строк с drop(row) — быстро', async function () {
    this.timeout(30000);
    const data = { r: Array.from({ length: 10000 }, (_, i) => ({ n: i, odd: i % 2 === 1 })) };
    const start = Date.now();
    const out = await renderAs('docx', '<w:body>' + wtbl(1, wtr('{d.r[i].n}{d.r[i].odd:drop(row)}'), wtr('{d.r[i+1].n}')) + '</w:body>', data);
    assert.ok(Date.now() - start < 3000, (Date.now() - start) + ' мс');
    assert.strictEqual((out.match(/<w:tr>/g) || []).length, 5000);
    assertWellFormed(out);
  });
});

describe('EE платные: drop/keep — ревью, раунд 1', function () {
  const c = (t) => '<c t="inlineStr"><is><t>' + t + '</t></is></c>';
  const row = (...cells) => '<row>' + cells.map(c).join('') + '</row>';
  it('XLSX: drop(col) единственного описанного столбца — <cols> без <col> удаляется', async function () {
    const xml = '<worksheet><cols><col min="2" max="2" width="9"/></cols><sheetData>' + row('a', 'b{d.yes:drop(col)}') + '</sheetData></worksheet>';
    assert.strictEqual(await renderAs('xlsx', xml, DROP_DATA), '<worksheet><sheetData>' + row('a') + '</sheetData></worksheet>');
  });
  it('XLSX: drop(col) остальные <col> сохраняют <cols>', async function () {
    const xml = '<worksheet><cols><col min="1" max="1" width="5"/><col min="2" max="2" width="9"/></cols><sheetData>' + row('a', 'b{d.yes:drop(col)}') + '</sheetData></worksheet>';
    assert.strictEqual(await renderAs('xlsx', xml, DROP_DATA), '<worksheet><cols><col min="1" max="1" width="5"/></cols><sheetData>' + row('a') + '</sheetData></worksheet>');
  });
  it('XLSX: drop(col) на листе с форматированной таблицей — ошибка шаблона, независимо от условия', async function () {
    const xml = (v) => '<worksheet><sheetData>' + row('a', 'b{d.' + v + ':drop(col)}') + '</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>';
    const want = 'drop(col) не поддерживается на листах XLSX с форматированными таблицами («Форматировать как таблицу»): преобразуйте таблицу в обычный диапазон или скрывайте столбец иначе.';
    assert.strictEqual(await renderError('xlsx', xml('yes'), DROP_DATA), want + ' Source: "{d.yes:drop(col)}"');
    assert.strictEqual(await renderError('xlsx', xml('no'), DROP_DATA), want + ' Source: "{d.no:drop(col)}"');
  });
  it('XLSX: drop(row) на листе с форматированной таблицей допустим', async function () {
    const xml = '<worksheet><sheetData>' + row('a{d.yes:drop(row)}') + row('b') + '</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>';
    assert.strictEqual(await renderAs('xlsx', xml, DROP_DATA), '<worksheet><sheetData>' + row('b') + '</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>');
  });
  it('drop(col) в таблице с объединёнными ячейками — ошибка и при ложном условии', async function () {
    const merged = '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' + wp('ab') + '</w:tc></w:tr>';
    assert.match(await renderError('docx', '<w:body>' + wtbl(2, wtr('a{d.no:drop(col)}', 'b'), merged) + '</w:body>', DROP_DATA), /^drop\(col\) не поддерживается в таблицах с объединёнными/);
  });
  it('show/elseShow/ifEqual перед drop — ошибка шаблона', async function () {
    assert.strictEqual(await rawError('{d.yes:ifEQ(true):show(a):drop(p)}', DROP_DATA), 'show перед drop не сочетается с ним: условие задаётся ifEQ, ifNE, ifGT, ifEM и т. п., например {d.x:ifEQ(1):drop(p)}. Source: "{d.yes:ifEQ(true):show(a):drop(p)}"');
    assert.match(await rawError('{d.yes:elseShow(a):keep(p)}', DROP_DATA), /^elseShow перед keep/);
    assert.match(await rawError('{d.yes:ifEqual(true, a):drop(p)}', DROP_DATA), /^ifEqual перед drop/);
  });
  it('жетон из данных отчёта ничего не удаляет', async function () {
    for (const v of ['01', 'k000000000000i01']) {
      const out = await renderAs('docx', '<w:body>' + wp('{d.v}') + wp('x{d.no:drop(p)}') + '</w:body>', { v, no: false });
      assert.strictEqual(out, '<w:body>' + wp(v) + wp('x') + '</w:body>');
    }
  });
  it('ODT: удалены все строки заголовка — table:table-header-rows удаляется', async function () {
    const r = (t) => '<table:table-row><table:table-cell><text:p>' + t + '</text:p></table:table-cell></table:table-row>';
    const xml = '<office:text><table:table><table:table-column/><table:table-header-rows>' + r('h{d.yes:drop(row)}') + '</table:table-header-rows>' + r('b') + '</table:table></office:text>';
    assert.strictEqual(await renderAs('odt', xml, DROP_DATA), '<office:text><table:table><table:table-column/>' + r('b') + '</table:table></office:text>');
  });
  it('DOCX: колонтитул, сноска и блок sdt не остаются без абзаца', async function () {
    const builder = require('../lib/builder');
    const run = (xml) => new Promise((resolve, reject) => builder.buildXML(xml, DROP_DATA, { formatters: carbone.formatters, extension: 'docx' }, (err, res) => err ? reject(err) : resolve(res)));
    assert.strictEqual(await run('<w:hdr>' + wp('{d.yes:drop(p)}') + '</w:hdr>'), '<w:hdr><w:p/></w:hdr>');
    assert.strictEqual(await run('<w:footnotes><w:footnote w:id="1">' + wp('{d.yes:drop(p)}') + '</w:footnote></w:footnotes>'), '<w:footnotes><w:footnote w:id="1"><w:p/></w:footnote></w:footnotes>');
    assert.strictEqual(await run('<w:body><w:sdt><w:sdtContent>' + wp('{d.yes:drop(p)}') + '</w:sdtContent></w:sdt>' + wp('x') + '</w:body>'), '<w:body><w:sdt><w:sdtContent><w:p/></w:sdtContent></w:sdt>' + wp('x') + '</w:body>');
  });
  it('callback вызывается один раз, даже если код вызывающего бросает исключение', function (done) {
    const builder = require('../lib/builder');
    let calls = 0;
    const listeners = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    process.once('uncaughtException', function (e) {
      listeners.forEach((l) => process.on('uncaughtException', l));
      assert.strictEqual(e.message, 'ошибка вызывающего');
      setTimeout(function () {
        assert.strictEqual(calls, 1);
        done();
      }, 20);
    });
    builder.buildXML(wp('{d.yes:drop(p)}') + '<w:p/>', DROP_DATA, { formatters: carbone.formatters, extension: 'docx' }, function () {
      calls++;
      throw new Error('ошибка вызывающего');
    });
  });
  it('drop(p, 2) на 40 тыс. абзацев — линейно', async function () {
    this.timeout(30000);
    // каждый третий удаляет себя и следующий — остаются i % 3 === 2
    const data = { r: Array.from({ length: 40000 }, (_, i) => ({ n: i, odd: i % 3 === 0 })) };
    const start = Date.now();
    const out = await renderAs('docx', '<w:body>' + wp('{d.r[i].n}{d.r[i].odd:drop(p, 2)}') + wp('{d.r[i+1].n}') + '</w:body>', data);
    assert.ok(Date.now() - start < 3000, (Date.now() - start) + ' мс');
    assert.strictEqual((out.match(/<w:p>/g) || []).length, 13333);
  });
});

// XLSX-файл целиком (renderBuffer): препроцессор переводит общие строки во встроенные и убирает r у строк и ячеек;
// после сборки (циклы, drop) текст снова уходит в sharedStrings.xml, номера ставятся заново. Со встроенными
// строками OnlyOffice Document Server 9.4 при конвертации оставлял только первую ячейку-текст (CI 38051370006).
describe('XLSX: общие строки и номера строк и ячеек после сборки', function () {
  const yazl = require('yazl');
  const yauzl = require('yauzl');
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const M = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const zip = (files) => new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    const parts = [];
    z.outputStream.on('data', (c) => parts.push(c)).on('error', reject).on('end', () => resolve(Buffer.concat(parts)));
    for (const [name, data] of Object.entries(files)) z.addBuffer(Buffer.from(data), name);
    z.end();
  });
  const entry = (buffer, name) => new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, z) => {
      if (err) return reject(err);
      z.on('entry', (e) => {
        if (e.fileName !== name) return z.readEntry();
        z.openReadStream(e, (err2, s) => {
          if (err2) return reject(err2);
          const parts = [];
          s.on('data', (c) => parts.push(c)).on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        });
      });
      z.on('end', () => reject(new Error('нет ' + name)));
      z.readEntry();
    });
  });
  // строки — массивы значений ячеек; общие строки, как в файле Excel (sharedStrings.xml)
  async function xlsx (rows, cols) {
    const strings = [];
    const cell = (v, r, c) => {
      const ref = String.fromCharCode(65 + c) + r;
      strings.push(v);
      return '<c r="' + ref + '" t="s"><v>' + (strings.length - 1) + '</v></c>';
    };
    const sheet = rows.map((cells, r) => '<row r="' + (r + 1) + '" spans="1:' + cells.length + '">' + cells.map((v, c) => cell(v, r + 1, c)).join('') + '</row>').join('');
    return zip({
      '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
      '_rels/.rels': XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': XML + '<workbook xmlns="' + M + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': XML + '<Relationships xmlns="' + RELS + '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
      'xl/sharedStrings.xml': XML + '<sst xmlns="' + M + '">' + strings.map((s) => '<si><t>' + s + '</t></si>').join('') + '</sst>',
      'xl/worksheets/sheet1.xml': XML + '<worksheet xmlns="' + M + '">' + (cols || '') + '<sheetData>' + sheet + '</sheetData></worksheet>'
    });
  }
  // [[ref, текст]] по строкам; проверка: строки 1…N подряд, ячейки A, B, C… с номером своей строки
  function grid (sheetXml, sst) {
    const strings = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) => [...si.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join(''));
    const rows = [];
    let expectRow = 1;
    for (const [, rowAttrs, body] of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = /\sr="(\d+)"/.exec(rowAttrs);
      assert.ok(r, 'у строки нет r: ' + rowAttrs);
      assert.strictEqual(Number(r[1]), expectRow++, 'номера строк не подряд');
      let col = 0;
      const cells = [];
      for (const [, cellAttrs, inner] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\sr="([A-Z]+)(\d+)"/.exec(cellAttrs);
        assert.ok(ref, 'у ячейки нет r: ' + cellAttrs);
        assert.strictEqual(ref[1], String.fromCharCode(65 + col++), 'столбцы не подряд');
        assert.strictEqual(ref[2], r[1], 'номер строки в ссылке ячейки');
        assert.ok(!/inlineStr/.test(cellAttrs), 'встроенная строка осталась: ' + cellAttrs);
        const v = ((inner || '').match(/<v>([^<]*)<\/v>/) || [])[1];
        cells.push(/\st="s"/.test(cellAttrs) ? strings[Number(v)] : (v || ''));
      }
      rows.push(cells);
    }
    return rows;
  }
  async function render (rows, data, cols) {
    const out = await renderBuffer(await xlsx(rows, cols), 'xlsx', data, RU);
    const sheet = await entry(out, 'xl/worksheets/sheet1.xml');
    const sst = await entry(out, 'xl/sharedStrings.xml');
    assert.match(await entry(out, '[Content_Types].xml'), /PartName="\/xl\/sharedStrings\.xml"/);
    assert.match(await entry(out, 'xl/_rels/workbook.xml.rels'), /relationships\/sharedStrings" Target="sharedStrings\.xml"/);
    return { sheet, sst, grid: grid(sheet, sst) };
  }
  const CARS = { cars: [{ n: 'Лада', ok: true }, { n: 'Тесла', ok: false }, { n: 'БМВ', ok: true }], hide: true };

  it('цикл без drop: общие строки без повторов, строки и ячейки пронумерованы подряд (до 2.2.0 — встроенные строки без r)', async function () {
    const out = await render([['H1', 'H2'], ['{d.cars[i].n}', 'x'], ['{d.cars[i+1].n}', '']], CARS);
    assert.deepStrictEqual(out.grid, [['H1', 'H2'], ['Лада', 'x'], ['Тесла', 'x'], ['БМВ', 'x']]);
    assert.strictEqual((out.sst.match(/<si>/g) || []).length, 6);
    assert.match(out.sst, /count="6" uniqueCount="6"/);
  });
  it('drop(row) в цикле и drop(col): номера пересчитаны после удаления', async function () {
    const cols = '<cols><col min="1" max="1" width="20"/><col min="2" max="2" width="9"/><col min="3" max="3" width="12"/></cols>';
    const out = await render([['{d.hide}', 'скрыть{d.hide:drop(col)}', 'марка'], ['{d.cars[i].n}{d.cars[i].ok:ifEQ(false):drop(row)}', 'x', '{d.cars[i].n}'], ['{d.cars[i+1].n}', '', '']], CARS, cols);
    assert.deepStrictEqual(out.grid, [['true', 'марка'], ['Лада', 'Лада'], ['БМВ', 'БМВ']]);
    assert.ok(!/скрыть|Тесла/.test(out.sst), out.sst);
    assert.match(out.sheet, /<cols><col min="1" max="1" width="20"\/><col min="2" max="2" width="12"\/><\/cols>/);
  });
  it('addRowCounterInWorksheet: пустые и самозакрытые ячейки, столбцы после Z, существующие r не трогаются', function () {
    const { addRowCounterInWorksheet, columnName } = require('../lib/preprocessor');
    assert.deepStrictEqual([1, 26, 27, 52, 703].map(columnName), ['A', 'Z', 'AA', 'AZ', 'AAA']);
    assert.strictEqual(addRowCounterInWorksheet('<x><cols><col min="1"/></cols><sheetData><row><c t="s"/><c><v>1</v></c></row><row/><row r="7"><c/></row></sheetData></x>'),
      '<x><cols><col min="1"/></cols><sheetData><row r="1"><c r="A1" t="s"/><c r="B1"><v>1</v></c></row><row r="2"/><row r="7"><c r="A7"/></row></sheetData></x>');
    assert.strictEqual(addRowCounterInWorksheet('<x/>'), '<x/>');
  });
});
