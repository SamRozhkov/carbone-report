// Совместимость с Carbone EE 5.15.3 в бесплатном режиме: модульные тесты переноса синтаксиса (Tasks 4–7).
const assert = require('assert');
const { renderBuffer } = require('../lib/index');
const { buildDocx, docxText, normalizeError } = require('./golden-lib');

const RU = { lang: 'ru', timezone: 'Europe/Moscow' };

// eslint-disable-next-line no-unused-vars
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

async function error (template, data, options) {
  return normalizeError(await rawError(template, data, options));
}

describe('EE: отключённые функции', function () {
  const cars = { cars: [{ brand: 'Лада', qty: 3 }, { brand: 'Тесла', qty: 2 }] };
  // агрегаторы (aggSum … cumCountD, count()) реализованы в 2.2.0 — test/test.ee-paid.js
  for (const f of ['drop', 'keep', 'html', 'color', 'barcode', 'chart', 'formatR', 'defaultURL', 'autoOrient']) {
    it(f, async function () {
      assert.strictEqual(await error('{d.v:' + f + '()}', { v: 'x' }), 'Formatter "' + f + '" is disabled in the Community Edition.');
    });
  }
  it('imageFit не отключён, а неизвестен', async function () {
    assert.match(await error('{d.v:imageFit()}', { v: 'x' }), /^Formatter "imageFit" does not exist/);
  });
  it('сообщение несёт суффикс Source с меткой, как в EE', async function () {
    assert.ok((await rawError('{d.v:html()}', { v: 'x' })).endsWith(' Source: "{d.v:html()}"'));
    assert.ok((await rawError('Итого: {d.v:mul(2):html:formatN(2)}', { v: 1 })).endsWith(' Source: "{d.v:mul(2):html:formatN(2)}"'));
  });
  it('Source для count() показывает метку уже с cumCount, как в EE', async function () {
    const t = '| {d.cars[i].brand:count():nope} |\n| {d.cars[i+1].brand} |';
    assert.match(await rawError(t, cars), /^Formatter "nope" does not exist\. Do you mean "[^"]*"\? Source: "\{d\.cars\[i\]\.brand:cumCount:nope\}"$/);
  });
  it('отключённые функции не подсказываются в «Do you mean»', async function () {
    assert.doesNotMatch(await error('{d.v:aggSun}', { v: 1 }), /aggSum/);
  });
  it('disabledName: имя для сообщения или null', function () {
    const { disabledName } = require('../lib/community');
    assert.strictEqual(disabledName('drop'), 'drop');
    // агрегаторы и count() (= cumCount) с 2.2.0 не отключены
    assert.strictEqual(disabledName('count'), null);
    assert.strictEqual(disabledName('aggSum'), null);
    assert.strictEqual(disabledName('formatN'), null);
  });
  it('отключённая функция в колонтитуле тоже даёт ошибку', async function () {
    // Колонтитул: отдельный word/header1.xml. Собрать DOCX с header через buildDocx не получится —
    // проверяется на уровне buildXML, как это делают тесты апстрима test.builder.buildXML.js.
    const builder = require('../lib/builder');
    const input = require('../lib/input');
    await new Promise(function (resolve, reject) {
      input.parseOptions({}, reject, function (options) {
        builder.buildXML('<w:hdr><w:p><w:r><w:t>{d.n:html}</w:t></w:r></w:p></w:hdr>', { n: 1 }, options, function (err) {
          try {
            assert.match(String(err && err.message), /Formatter "html" is disabled in the Community Edition\./);
            resolve();
          }
          catch (e) {
            reject(e);
          }
        });
      });
    });
  });
});

describe('EE: форматтеры', function () {
  // эталоны снимались с настройками по умолчанию: другие тесты могли поменять глобальные params
  beforeEach(function () { require('../lib/index').reset(); });
  after(function () { require('../lib/index').reset(); });
  const RURU = { lang: 'ru-ru', timezone: 'Europe/Moscow' };

  it('ellipsis', async function () {
    assert.strictEqual(await text('{d.s:ellipsis(7)}', { s: 'Длинная строка' }), 'Длинная...');
    assert.strictEqual(await text('{d.s:ellipsis(6)}', { s: 'abcdef' }), 'abcdef');
  });
  it('append', async function () {
    assert.strictEqual(await text("{d.s:append('!')}", { s: 'a' }), 'a!');
  });
  it('replace', async function () {
    assert.strictEqual(await text("{d.s:replace('-','/')}", { s: '2026-03-08' }), '2026/03/08');
    assert.strictEqual(await text("{d.s:replace('cd')}", { s: 'abcdef abcde' }), 'abef abe');
  });
  it('split', async function () {
    assert.strictEqual(await text("{d.s:split(',')}", { s: 'a,b' }), 'a,b');
    assert.strictEqual(await text("{d.s:split('/'):arrayJoin('', 1, 1)}", { s: 'ab/cd/ef' }), 'cd');
  });
  it('mod', async function () {
    assert.strictEqual(await text('{d.n:mod(3)}', { n: 10 }), '1');
  });
  it('abs', async function () {
    assert.strictEqual(await text('{d.n:abs()}', { n: -5 }), '5');
  });
  it('ceil / floor', async function () {
    assert.strictEqual(await text('{d.n:ceil()} / {d.n:floor()}', { n: 1.5 }), '2 / 1');
  });
  it("formatI('human') и 'human+'", async function () {
    assert.strictEqual(await text("{d.n:formatI('human')}", { n: 7200000 }), '2 часа');
    assert.strictEqual(await text("{d.n:formatI('human+')}", { n: 7200000 }), 'через 2 часа');
    assert.strictEqual(await text("{d.n:formatI('human+')}", { n: -7200000 }), '2 часа назад');
  });
  it('formatI: единицы', async function () {
    assert.strictEqual(await text("{d.n:formatI('days','hours')}", { n: 48 }), '2');
    assert.strictEqual(await text("{d.n:formatI('ms','weeks')}", { n: 4 }), '2419200000');
    assert.strictEqual(await text("{d.n:formatI('minute')}", { n: 3600000 }), '60');
  });
  it('diffD', async function () {
    assert.strictEqual(await text("{d.d:diffD('2026-12-31','days')}", { d: '2026-03-08' }), '298');
    assert.strictEqual(await text("{d.d:diffD('20101201')}", { d: '20101001' }), '5270400000');
    assert.strictEqual(await text("{d.d:diffD('20101201', 'weeks')}", { d: '20101001' }), '8');
    assert.strictEqual(await text("{d.d:diffD('2010=12=01', 'ms', 'YYYY+MM+DD', 'YYYY=MM=DD')}", { d: '2010+10+01' }), '5270400000');
  });
  it('ifTE', async function () {
    const t = "{d.v:ifTE('number'):show('number'):elseShow('string')}";
    assert.strictEqual(await text(t, { v: 1 }), 'number');
    assert.strictEqual(await text(t, { v: 'x' }), 'string');
    assert.strictEqual(await text("{d.v:ifTE('binary'):show('да'):elseShow('нет')}", { v: '0' }), 'да');
    assert.strictEqual(await text("{d.v:ifTE('integer'):show('да'):elseShow('нет')}", { v: 1.5 }), 'нет');
  });
  it('printJSON', async function () {
    assert.strictEqual(await text('{d.o:printJSON()}', { o: { a: 1 } }), '{"a":1}');
  });
  it('t', async function () {
    const opts = Object.assign({}, RU, { translations: { ru: { Hello: 'Привет' } } });
    assert.strictEqual(await text('{d.v:t}', { v: 'Hello' }, opts), 'Привет');
    assert.strictEqual(await text('{d.v:t}', { v: 'Bye' }, opts), 'Bye');
  });
  it('substr в режиме слов не режет слово', async function () {
    assert.strictEqual(await text('{d.s:substr(0,10,true)}', { s: 'Длинная строка' }), 'Длинная ');
    assert.strictEqual(await text('{d.s:substr(1,11,true)}', { s: 'abcd efg hijklm' }), 'abcd efg ');
    assert.strictEqual(await text("{d.s:substr(11,22,'last')}", { s: 'abcd efg hijklm' }), 'hijklm');
  });
  it('arrayJoin со срезом', async function () {
    assert.strictEqual(await text("{d.a:arrayJoin('; ',1,1)}", { a: ['a', 'b', 'c'] }), 'b');
    assert.strictEqual(await text("{d.a:arrayJoin('', 0, -1)}", { a: ['a', 'b', 'c'] }), 'ab');
    assert.strictEqual(await text("{d.a:arrayJoin('', 1)}", { a: ['a', 'b', 'c'] }), 'bc');
  });
  it('formatC: второй аргумент — целевая валюта (эталон matrix/s2/formatc-2-usd-1000)', async function () {
    assert.strictEqual(await text("[{d.v:formatC(2, 'USD')}]", { v: 1000 }, RURU), '[1,140.30 $]');
  });
  it('курсы по умолчанию как в EE (с RUB)', async function () {
    assert.strictEqual(await text("{d.v:convCurr('USD')}", { v: 1000 }), '14.679643146796433');
  });
  it("padr/padl: '.' в кавычках — литерал, а не путь", async function () {
    assert.strictEqual(await text("{d.s:padr(6,'.')}", { s: 'ab' }), 'ab....');
    assert.strictEqual(await text("{d.s:padl(4,'.')}", { s: 'ab' }), '..ab');
  });
  it('относительный путь без кавычек по-прежнему путь', async function () {
    assert.strictEqual(await text('{d.a:add(.b)}', { a: 1, b: 2 }), '3');
  });
  it('ifEmpty не обрывает цепочку', async function () {
    assert.strictEqual(await text("{d.v:ifEmpty('—'):formatD('DD.MM.YYYY')}", { v: null }), 'Invalid Date');
    assert.strictEqual(await text("{d.v:formatD('DD.MM.YYYY'):ifEmpty('—')}", { v: null }), '—');
  });
  it('неизвестный форматтер: подсказка mod и суффикс Source', async function () {
    assert.strictEqual(await error('{d.n:fooBar()}', { n: 1 }), 'Formatter "fooBar" does not exist. Do you mean "mod"?');
    assert.ok((await rawError('{d.n:fooBar()}', { n: 1 })).endsWith(' Source: "{d.n:fooBar()}"'));
  });
});

describe('EE: циклы', function () {
  const cars = {
    cars: [
      { brand: 'Лада', qty: 3, ok: true },
      { brand: 'Тесла', qty: 2, ok: false },
      { brand: 'Лада', qty: 5, ok: true },
      { brand: 'БМВ', qty: 1, ok: true }
    ]
  };

  it('print(.i) — индекс элемента (эталон matrix/tests2/iterator-via-print-i)', async function () {
    assert.strictEqual(await text('| {d.cars[i].brand:print(.i)} |\n| {d.cars[i+1].brand} |', cars), '| 0 |\n| 1 |\n| 2 |\n| 3 |');
  });
  it('print(.i):add(1) — нумерация с единицы (эталон help/tables-numbering)', async function () {
    assert.strictEqual(await text('| {d.cars[i].brand:print(.i):add(1)} |\n| {d.cars[i+1].brand} |', cars), '| 1 |\n| 2 |\n| 3 |\n| 4 |');
  });
  it('mul(0):add(.i):add(1) (эталон matrix/tests2/iterator-via-qty-mul-0-add-i-add-1)', async function () {
    assert.strictEqual(await text('{d.cars[i].qty:mul(0):add(.i):add(1)}\n{d.cars[i+1].qty}', cars), '1\n2\n3\n4');
  });
  it('с фильтром .i — индекс в исходном массиве (эталон matrix/tests3/numbering-with-filter)', async function () {
    assert.strictEqual(
      await text('{d.cars[i, ok=true].brand:print(.i):add(1)}. {d.cars[i, ok=true].brand}\n{d.cars[i+1, ok=true].brand}', cars),
      '1. Лада\n3. Лада\n4. БМВ'
    );
  });
  it('.i во вложенном цикле — индекс своего уровня, ..i — родителя', async function () {
    const data = { a: [{ b: [{ v: 'x' }, { v: 'y' }] }, { b: [{ v: 'z' }] }] };
    assert.strictEqual(
      await text('{d.a[i].b[i].v:print(.i)}-{d.a[i].b[i].v:print(..i)}\n{d.a[i].b[i+1].v}\n{d.a[i+1].b[0].v}', data),
      '0-0\n1-0\n0-1'
    );
  });
  it('{d.cars[i].i} и {d.cars[i]..i} печатают пустоту', async function () {
    assert.strictEqual(await text('[{d.cars[i].i}]\n[{d.cars[i+1].i}]', cars), '[]\n[]\n[]\n[]');
    assert.strictEqual(await text('[{d.cars[i]..i}]\n[{d.cars[i+1]..i}]', cars), '[]\n[]\n[]\n[]');
  });
  it('массив строк (эталон matrix/s1/loop-over-string-array)', async function () {
    assert.strictEqual(await text('{d.tags[i]}\n{d.tags[i+1]}', { tags: ['a', 'b', 'c'] }), 'a\nb\nc');
    assert.strictEqual(await text('{d.n[i]}\n{d.n[i+1]}', { n: [1, 0, true] }), '1\n0\ntrue');
  });
  it('{d.list[i]} над объектами остаётся невидимым якорем цикла', async function () {
    assert.strictEqual(await text('{d.cars[i]}{d.cars[i].brand}\n{d.cars[i+1]}', cars), 'Лада\nТесла\nЛада\nБМВ');
  });
  it('повтор внутри одного абзаца (эталон matrix/s1/inline-loop-same-paragraph)', async function () {
    assert.strictEqual(await text('[{d.cars[i].brand}, {d.cars[i+1].brand}]', cars), '[Лада, Тесла, Лада, БМВ, ]');
  });
  it('повтор в одном абзаце: массив строк и вложенный цикл', async function () {
    assert.strictEqual(await text('[{d.t[i]}, {d.t[i+1]}]', { t: ['x', 'y'] }), '[x, y, ]');
    const data = { a: [{ n: 'A', b: ['x', 'y'] }, { n: 'B', b: ['z'] }] };
    assert.strictEqual(await text('{d.a[i].n}: [{d.a[i].b[i]}, {d.a[i].b[i+1]}]\n{d.a[i+1].n}', data), 'A: [x, y, ]\nB: [z, ]');
  });
  it('useHighPrecisionArithmetic: sub, mul, div', async function () {
    const t = '{o.useHighPrecisionArithmetic=true}{d.x:mul(.y)} {d.x:sub(.y)} {d.one:div(.y)}';
    assert.strictEqual(await text(t, { x: 1.1, y: 3, one: 1 }), '3.3 -1.9 0.3333333333333333');
  });
  it('{o.useHighPrecisionArithmetic=true} (эталон matrix/s2/usehighprecisionarithmetic-0-1-0-2)', async function () {
    assert.strictEqual(await text('[{o.useHighPrecisionArithmetic=true}{d.a:add(.b)}]', { a: 0.1, b: 0.2 }), '[0.3]');
    assert.strictEqual(await text('[{d.a:add(.b)}]', { a: 0.1, b: 0.2 }), '[0.30000000000000004]');
  });
  it('{o.preReleaseFeatureIn=…} ничего не печатает (эталон matrix/s5/o-prereleasefeaturein)', async function () {
    assert.strictEqual(await text('[{o.preReleaseFeatureIn=5002000}{d.v}]', { v: 'ok' }), '[ok]');
  });
  it('цикл без [i+1] — ошибка EE (эталон matrix/tests3/bad-loop-missing-i-1)', async function () {
    assert.strictEqual(
      await error('{d.cars[i].brand}', cars),
      'The marker {d.cars[i].brand} has no corresponding [i+1] for array "cars". Add at least one tag with cars[i+1] to describe where is the i+1-th item.'
    );
  });
});

describe('EE: set и c.', function () {
  const cars = {
    cars: [
      { brand: 'Лада', qty: 3, ok: true },
      { brand: 'Тесла', qty: 2, ok: false },
      { brand: 'Лада', qty: 5, ok: true },
      { brand: 'БМВ', qty: 1, ok: true }
    ]
  };
  const RURU = { lang: 'ru-ru', timezone: 'Europe/Moscow' };
  const GROUP = '{d.cars[]:set(c.g[id=.brand].rows[])}\n{c.g[i].id}\n- {c.g[i].rows[i].brand} {c.g[i].rows[i].qty}\n- {c.g[i].rows[i+1].qty}\n{c.g[i+1].id}';

  it(':set сохраняет значение, сам тег ничего не печатает (эталон matrix/s5/set-store-value)', async function () {
    assert.strictEqual(await text('[{d.v:set(c.x)}{c.x}]', { v: 'stored' }), '[stored]');
  });
  it('группировка целых элементов в порядке первого появления (эталоны help/totals-set-group, matrix/tests2/group-via-set-whole-object)', async function () {
    assert.strictEqual(await text(GROUP, cars), 'Лада\n- Лада 3\n- Лада 5\nТесла\n- Тесла 2\nБМВ\n- БМВ 1');
  });
  it('группировка в таблице (эталон matrix/tests2/group-via-set-table)', async function () {
    const t = '{d.cars[]:set(c.g[id=.brand].rows[])}\n| {c.g[i].id} | |\n| | {c.g[i].rows[i].qty} |\n| | {c.g[i].rows[i+1].qty} |\n| {c.g[i+1].id} | |';
    assert.strictEqual(await text(t, cars), '| Лада | |\n| | 3 |\n| | 5 |\n| Тесла | |\n| | 2 |\n| БМВ | |\n| | 1 |');
  });
  it('rows[].поле — каждый :set добавляет новый элемент (эталон matrix/s4/grouping-via-set-v5-enterprise)', async function () {
    const t = '{d.cars[].brand:set(c.g[id=.brand].rows[].brand)}{d.cars[].qty:set(c.g[id=.brand].rows[].qty)}\n{c.g[i].id}\n- {c.g[i].rows[i].qty}\n- {c.g[i].rows[i+1].qty}\n{c.g[i+1].id}';
    assert.strictEqual(await text(t, cars), 'Лада\n- \n- \n- 3\n- 5\nТесла\n- \n- 2\nБМВ\n- \n- 1');
  });
  it('накопитель: особенность EE — первый элемент учитывается дважды (эталон help/totals-set-sum)', async function () {
    const data = Object.assign({ zero: 0 }, cars);
    assert.strictEqual(await text('{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}Итого: {c.total}', data), 'Итого: 14');
  });
  it('накопитель с начальным значением в complement, в отдельном абзаце, из одного элемента', async function () {
    const opts = Object.assign({ complement: { total: 0 } }, RURU);
    assert.strictEqual(await text('{d.cars[].qty:add(c.total):set(c.total)}Итого: {c.total}', cars, opts), 'Итого: 14');
    assert.strictEqual(await text('{d.cars[].qty:add(c.total):set(c.total)}\nИтого: {c.total}', cars, opts), 'Итого: 14');
    assert.strictEqual(await text('{d.cars[].qty:add(c.total):set(c.total)}Итого: {c.total}', { cars: [{ qty: 7 }] }, opts), 'Итого: 14');
  });
  it('накопитель без инициализации — NaN (эталон matrix/tests2/sum-via-set-accumulator-no-init)', async function () {
    assert.strictEqual(await text('{d.cars[].qty:add(c.total):set(c.total)}Итого: {c.total}', cars), 'Итого: NaN');
  });
  it('накопитель с mul(.price) (эталон matrix/tests2/sum-via-set-accumulator-mul)', async function () {
    const data = { cars: [{ qty: 3, price: 100.5 }, { qty: 1, price: 2000 }, { qty: 2, price: 120 }, { qty: 5, price: 1500 }] };
    const opts = Object.assign({ complement: { total: 0 } }, RURU);
    assert.strictEqual(await text('{d.cars[].qty:mul(.price):add(c.total):set(c.total)}Итого: {c.total:formatN(2)}', data, opts), 'Итого: 10,343.00');
  });
  it('путь c. с [ключ=.поле] в аргументе — ошибка EE (эталон matrix/tests2/group-via-set-subtotal-set)', async function () {
    const t = '{d.cars[]:set(c.g[id=.brand].rows[])}{d.cars[].qty:add(c.g[id=.brand].sum):set(c.g[id=.brand].sum)}\n{c.g[i].id}: {c.g[i].sum}\n{c.g[i+1].id}';
    const msg = await rawError(t, cars);
    assert.strictEqual(normalizeError(msg), 'Forbidden array access in "c.g[id=.brand].sum". Only positive integers are allowed in []');
    assert.ok(msg.endsWith(' Source: "{d.cars[i].qty:add(c.g[id=.brand].sum):_setInit(c.g):_setObj(c):_setArr(g):_setObjInArr(id,.brand):_setVal(sum)}"'), msg);
  });
  it('вложенный источник d.a[].b[] и источник с [i, фильтр] перебираются', async function () {
    const data = { a: [{ b: [{ v: 1 }, { v: 2 }] }, { b: [{ v: 4 }] }] };
    assert.strictEqual(await text('{d.a[].b[].v:set(c.all[])}{c.all[i]}\n{c.all[i+1]}', data), '1\n2\n4');
    assert.strictEqual(await text('{d.cars[i, ok=true].brand:set(c.ok[])}{c.ok[i]}\n{c.ok[i+1]}', cars), 'Лада\nЛада\nБМВ');
  });
  it('пустой массив: накопитель не меняется', async function () {
    assert.strictEqual(await text('{d.cars[].qty:add(c.total):set(c.total)}[{c.total}]', { cars: [] }, Object.assign({ complement: { total: 0 } }, RU)), '[0]');
  });
  it('аргумент c.путь читается из complement', async function () {
    assert.strictEqual(await text('{d.v:add(c.k)} {d.v:add(c.o.k)}', { v: 1 }, Object.assign({ complement: { k: 2, o: { k: 5 } } }, RU)), '3 6');
  });
  it(':set не меняет complement вызывающего', async function () {
    const complement = { total: 0, o: { a: 1 } };
    await text('{d.cars[].qty:add(c.total):set(c.total)}{d.v:set(c.o.a)}{c.total}', Object.assign({ v: 9 }, cars), Object.assign({ complement }, RU));
    assert.deepStrictEqual(complement, { total: 0, o: { a: 1 } });
  });
  const movies = { movies: [{ actorId: 2 }, { actorId: 1 }], actors: [{ id: 1, name: 'A1' }, { id: 2, name: 'A2' }] };
  it('поиск по ключу в аргументе без preReleaseFeatureIn — ошибка (эталон matrix/s1/lookup-in-loop-without-prerelease)', async function () {
    const msg = await rawError('{d.movies[i].actorId:print(..actors[id=.actorId].name)}\n{d.movies[i+1].actorId}', movies, RURU);
    assert.strictEqual(normalizeError(msg), 'Forbidden array access in "actors[id=.actorId].name". Only positive integers are allowed in []');
    assert.ok(msg.endsWith(' Source: "{d.movies[i].actorId:print(..actors[id=.actorId].name)}"'), msg);
  });
  it('поиск по ключу с {o.preReleaseFeatureIn=5002000} (эталон matrix/s1/lookup-prerelease-5-2)', async function () {
    assert.strictEqual(
      await text('{o.preReleaseFeatureIn=5002000}\n{d.movies[i].actorId:print(..actors[id=.actorId].name)}\n{d.movies[i+1].actorId}', movies, RURU),
      'A2\nA1'
    );
  });
  it('целочисленный индекс в пути аргумента разрешён', async function () {
    assert.strictEqual(await text('{d.v:print(.a[1].n)}', { v: 1, a: [{ n: 'x' }, { n: 'y' }] }), 'y');
  });
});

describe('EE: решения контроллера по Task 7', function () {
  const cars = { cars: [{ brand: 'Лада' }, { brand: 'Тесла' }, { brand: 'Лада' }, { brand: 'БМВ' }] };
  it('повтор внутри одного абзаца, разбитого на несколько run (шаблоны OnlyOffice)', async function () {
    const raw = '<w:p><w:r><w:t xml:space="preserve">[{d.cars[i].brand}</w:t></w:r><w:r><w:t xml:space="preserve">, {d.cars[i+1].brand}]</w:t></w:r></w:p>';
    const out = await docxText(await renderBuffer(await buildDocx('<<RAW>>', [raw]), 'docx', cars, RU));
    assert.strictEqual(out, '[Лада, Тесла, Лада, БМВ, ]');
  });
  it('повтор абзацами с несколькими run по-прежнему повторяет абзацы', async function () {
    const raw = '<w:p><w:r><w:t xml:space="preserve">{d.cars[i].brand}</w:t></w:r><w:r><w:t xml:space="preserve">!</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t xml:space="preserve">{d.cars[i+1].brand}</w:t></w:r></w:p>';
    const out = await docxText(await renderBuffer(await buildDocx('<<RAW>>', [raw]), 'docx', cars, RU));
    assert.strictEqual(out, 'Лада!\nТесла!\nЛада!\nБМВ!');
  });
  it('[i+1] без [i] — понятная ошибка шаблона, а не TypeError', async function () {
    const msg = await error('{d.cars[i+1].brand}', cars);
    assert.ok(/d\.cars\[i\+1\]\.brand/.test(msg) && !/reading/.test(msg), msg);
    const msg2 = await error('{d.cars[i].brand}{d.other[i+1].brand}', Object.assign({ other: [] }, cars));
    assert.ok(!/reading/.test(msg2), msg2);
  });
  it('форматтер на элементе-объекте: строка печатается, объект — пусто (поведение EE не проверено)', async function () {
    assert.strictEqual(await text('{d.cars[i]:print(\'Z\')}\n{d.cars[i+1]}', cars), 'Z\nZ\nZ\nZ');
    assert.strictEqual(await text('[{d.cars[i]:ifEmpty(\'E\')}]\n{d.cars[i+1]}', cars), '[]\n[]\n[]\n[]');
  });
});

describe('EE: Task 7, доработка 1 (граничные случаи)', function () {
  const cars = { cars: [{ brand: 'Лада' }, { brand: 'Тесла' }, { brand: 'БМВ' }] };
  const render = async (raw, data) => docxText(await renderBuffer(await buildDocx('<<RAW>>', [raw]), 'docx', data, RU));
  it('повтор в абзаце через ссылку w:hyperlink между метками сохраняет разделители', async function () {
    const raw = '<w:p><w:r><w:t xml:space="preserve">[{d.cars[i].brand}</w:t></w:r>'
      + '<w:hyperlink w:anchor="x"><w:r><w:t xml:space="preserve">; </w:t></w:r></w:hyperlink>'
      + '<w:r><w:t xml:space="preserve">{d.cars[i+1].brand}]</w:t></w:r></w:p>';
    assert.strictEqual(await render(raw, cars), '[Лада; Тесла; БМВ; ]');
  });
  it('повтор в абзаце через w:ins / w:smartTag', async function () {
    const raw = '<w:p><w:r><w:t xml:space="preserve">[{d.cars[i].brand}</w:t></w:r>'
      + '<w:ins w:id="1" w:author="a"><w:smartTag w:uri="u" w:element="e"><w:r><w:t xml:space="preserve">, </w:t></w:r></w:smartTag></w:ins>'
      + '<w:r><w:t xml:space="preserve">{d.cars[i+1].brand}]</w:t></w:r></w:p>';
    assert.strictEqual(await render(raw, cars), '[Лада, Тесла, БМВ, ]');
  });
  it('повтор строк таблицы и абзацев со ссылкой внутри по-прежнему повторяет строки и абзацы', async function () {
    assert.strictEqual(await text('| {d.cars[i].brand} |\n| {d.cars[i+1].brand} |', cars), '| Лада |\n| Тесла |\n| БМВ |');
    const raw = '<w:p><w:hyperlink w:anchor="x"><w:r><w:t xml:space="preserve">{d.cars[i].brand}</w:t></w:r></w:hyperlink></w:p>'
      + '<w:p><w:r><w:t xml:space="preserve">{d.cars[i+1].brand}</w:t></w:r></w:p>';
    assert.strictEqual(await render(raw, cars), 'Лада\nТесла\nБМВ');
  });
  it('строка [i] только с метками :set: разделитель [i+1] без пары убирается, значения записаны', async function () {
    const t = '| {d.cars[i].brand:set(c.b[])} |\n| {d.cars[i+1].brand} |\n{c.b[i]}\n{c.b[i+1]}';
    assert.strictEqual(await text(t, cars), '| |\n| |\nЛада\nТесла\nБМВ');
  });
  it(':set и на строке [i+1] — она ничего не записывает, ошибок нет', async function () {
    const t = '| {d.cars[i].brand:set(c.b[])} |\n| {d.cars[i+1].brand:set(c.b[])} |\n{c.b[i]}\n{c.b[i+1]}';
    assert.strictEqual(await text(t, cars), '| |\n| |\nЛада\nТесла\nБМВ');
  });
  it('ошибки меток :set не показывают служебный __set', async function () {
    const m1 = await rawError('{d.cars[].brand:nope:set(c.x)}', cars);
    assert.ok(/Source: "\{d\.cars\[\]\.brand:nope:set\(c\.x\)\}"$/.test(m1) && !/__set/.test(m1), m1);
    const m2 = await rawError('{d.cars[].brand:html:set(c.x)}', cars);
    assert.ok(!/__set/.test(m2), m2);
  });
  it('группировка: ключи 1 и \'1\' — одна группа, как в поиске по ключу', async function () {
    const data = { items: [{ k: 1, v: 'a' }, { k: '1', v: 'b' }, { k: 2, v: 'c' }] };
    const t = '{d.items[]:set(c.g[id=.k].rows[])}{c.g[i].id}\n{c.g[i+1].id}\n{c.g[0].rows[1].v}';
    assert.strictEqual(await text(t, data), '1\n2\nb');
  });
  it('ключ в последнем сегменте c.g[id=.id]: повторный ключ заменяет элемент, 1 и \'1\' — один элемент', async function () {
    const t = '{d.items[]:set(c.g[id=.id])}{c.g[i].id}-{c.g[i].v}\n{c.g[i+1].id}';
    assert.strictEqual(await text(t, { items: [{ id: 1, v: 'a' }, { id: 1, v: 'b' }] }), '1-b');
    assert.strictEqual(await text(t, { items: [{ id: 1, v: 'a' }, { id: '1', v: 'b' }, { id: 2, v: 'c' }] }), '1-b\n2-c');
  });
  it('группировка 10 000 разных ключей — быстро (индекс ключей, а не линейный поиск)', async function () {
    this.timeout(20000);
    const items = [];
    for (let n = 0; n < 10000; n++) items.push({ k: 'k' + n });
    const started = Date.now();
    assert.strictEqual(await text('{d.items[]:set(c.g[id=.k].rows[])}[{c.g[9999].id}]', { items }), '[k9999]');
    // с запасом: на рабочей машине — доли секунды
    assert.ok(Date.now() - started < 5000, 'слишком долго: ' + (Date.now() - started) + ' мс');
  });
});

describe('EE: метки в строке-разделителе [i+1] (2.0.1)', function () {
  const cars = { cars: [{ brand: 'Лада', qty: 3, ok: true }, { brand: 'Тесла', qty: 1, ok: false }], f: true };
  it('метка [i] в строке [i+1] не начинает новый цикл', async function () {
    assert.strictEqual(await text('| {d.cars[i].brand} |\n| {d.cars[i+1].brand} {d.cars[i].qty} |', cars), '| Лада |\n| Тесла |');
  });
  it('hideBegin в строке [i] и hideEnd того же элемента в строке [i+1] — пара отбрасывается', async function () {
    const t = '| {d.cars[i].brand} | {d.cars[i].qty}{d.cars[i].ok:ifEQ(false):hideBegin} |\n| {d.cars[i+1].brand} | {d.cars[i].ok:hideEnd} |';
    assert.strictEqual(await text(t, cars), '| Лада | 3 |\n| Тесла | 1 |');
  });
  it('как в базе: hideBegin в строке [i+1], hideEnd после таблицы', async function () {
    assert.strictEqual(await text('| {d.cars[i].brand} |\n| {d.cars[i+1].brand} {d.f:ifEQ(true):hideBegin} |\nX{d.f:hideEnd}', cars), '| Лада |\n| Тесла |');
  });
  it('как в базе: блоки одного объекта до таблицы, в строке [i+1] и после', async function () {
    const t = '{d.f:ifEQ(true):hideBegin}\n| {d.cars[i].brand} |\n| {d.cars[i+1].brand}{d.f:hideEnd}{d.f:ifEQ(true):hideBegin} |\n{d.f:hideEnd}Z';
    assert.strictEqual(await text(t, cars), 'Z');
  });
  it('как в базе: «новый цикл» из строки [i+1] с метками вне неё — ошибка', async function () {
    const t = '| {d.cars[i].brand} |\n| {d.cars[i+1].brand} {d.cars[i].qty} |\nafter {d.cars[i].brand} {d.t}';
    assert.ok(/has no corresponding \[i\+1\]/.test(await error(t, cars)));
  });
  it('непарный hideBegin вне строки [i+1] — по-прежнему ошибка', async function () {
    assert.strictEqual(await error('| {d.cars[i].brand}{d.cars[i].ok:ifEQ(false):hideBegin} |\n| {d.cars[i+1].brand} |', cars), 'Missing at least one showEnd or hideEnd');
  });
});

describe('EE: null и объект в массиве строк (2.0.2)', function () {
  it('null в таблице даёт пустую строку, а не теряет её', async function () {
    assert.strictEqual(await text('| {d.tags[i]} |\n| {d.tags[i+1]} |', { tags: ['x', null, 'z'] }), '| x |\n| |\n| z |');
  });
  it('[null] — одна пустая строка, ifEmpty срабатывает на null', async function () {
    assert.strictEqual(await text('[{d.tags[i]}]\n[{d.tags[i+1]}]', { tags: [null] }), '[]');
    assert.strictEqual(await text('[{d.tags[i]:ifEmpty(\'-\')}]\n[{d.tags[i+1]}]', { tags: [null, 'z'] }), '[-]\n[z]');
  });
});
