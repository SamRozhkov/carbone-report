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
  for (const f of ['aggSum', 'aggAvg', 'aggMin', 'aggMax', 'aggCount', 'aggCountD', 'aggStr', 'aggStrD', 'cumSum', 'cumCount', 'cumCountD']) {
    it(f, async function () {
      assert.strictEqual(await error('Итого: {d.cars[].qty:' + f + '}', cars), 'Formatter "' + f + '" is disabled in the Community Edition.');
    });
  }
  for (const f of ['drop', 'keep', 'html', 'color', 'barcode', 'chart', 'formatR', 'defaultURL', 'autoOrient']) {
    it(f, async function () {
      assert.strictEqual(await error('{d.v:' + f + '()}', { v: 'x' }), 'Formatter "' + f + '" is disabled in the Community Edition.');
    });
  }
  it('count() называется cumCount, как в EE', async function () {
    const t = '| {d.cars[i].brand:count()} |\n| {d.cars[i+1].brand} |';
    assert.strictEqual(await error(t, cars), 'Formatter "cumCount" is disabled in the Community Edition.');
  });
  it('imageFit не отключён, а неизвестен', async function () {
    assert.match(await error('{d.v:imageFit()}', { v: 'x' }), /^Formatter "imageFit" does not exist/);
  });
  it('сообщение несёт суффикс Source с меткой, как в EE', async function () {
    assert.ok((await rawError('{d.v:html()}', { v: 'x' })).endsWith(' Source: "{d.v:html()}"'));
    assert.ok((await rawError('Итого: {d.cars[].qty:mul(2):aggSum:formatN(2)}', cars)).endsWith(' Source: "{d.cars[].qty:mul(2):aggSum:formatN(2)}"'));
  });
  it('Source для count() показывает метку уже с cumCount, как в EE', async function () {
    const t = '| {d.cars[i].brand:count()} |\n| {d.cars[i+1].brand} |';
    assert.strictEqual(await rawError(t, cars), 'Formatter "cumCount" is disabled in the Community Edition. Source: "{d.cars[i].brand:cumCount}"');
  });
  it('отключённые функции не подсказываются в «Do you mean»', async function () {
    assert.doesNotMatch(await error('{d.v:aggSun}', { v: 1 }), /aggSum/);
  });
  it('disabledName: имя для сообщения или null', function () {
    const { disabledName } = require('../lib/community');
    assert.strictEqual(disabledName('count'), 'cumCount');
    assert.strictEqual(disabledName('aggSum'), 'aggSum');
    assert.strictEqual(disabledName('formatN'), null);
  });
  it('отключённая функция в колонтитуле тоже даёт ошибку', async function () {
    // Колонтитул: отдельный word/header1.xml. Собрать DOCX с header через buildDocx не получится —
    // проверяется на уровне buildXML, как это делают тесты апстрима test.builder.buildXML.js.
    const builder = require('../lib/builder');
    const input = require('../lib/input');
    await new Promise(function (resolve, reject) {
      input.parseOptions({}, reject, function (options) {
        builder.buildXML('<w:hdr><w:p><w:r><w:t>{d.n:aggSum}</w:t></w:r></w:p></w:hdr>', { n: 1 }, options, function (err) {
          try {
            assert.match(String(err && err.message), /Formatter "aggSum" is disabled in the Community Edition\./);
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
