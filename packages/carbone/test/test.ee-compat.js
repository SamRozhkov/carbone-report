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
