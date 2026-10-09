// Эталоны Carbone EE 5.15.3: каждый случай должен совпасть с записанным ответом EE (или с deviation.ours).
// Случаи из golden/known-gaps.json обязаны НЕ совпадать — иначе тест просит убрать их из списка.
const assert = require('assert');
const carbone = require('../lib/index');
const { renderBuffer } = carbone;
const { buildDocx, docxText, normalizeError } = require('./golden-lib');

const GAPS = new Set(require('./golden/known-gaps.json').ids);

async function run (c) {
  const tpl = await buildDocx(c.template, c.raw, c.rels);
  try {
    const out = await renderBuffer(tpl, 'docx', c.data, c.options);
    return { text: await docxText(out) };
  }
  catch (e) {
    const got = { error: normalizeError(e.message) };
    // метку из суффикса « Source: "{…}"» сравниваем, только если эталон её записал (в справке её нет)
    if (c.expect && c.expect.errorSource !== undefined) {
      const m = / Source: "([\s\S]*)"$/.exec(e.message);
      got.errorSource = m ? m[1] : null;
    }
    return got;
  }
}

function expected (c) {
  return c.deviation ? { text: c.deviation.ours } : c.expect;
}

describe('эталоны EE: харнесс', function () {
  it('docxText(buildDocx(t)) === t для абзацев и таблицы', async function () {
    const t = 'первый\nвторой\nтретий\n| a | b |\n| c | d |';
    assert.strictEqual(await docxText(await buildDocx(t)), t);
  });
  it('normalizeError убирает префикс и Source', function () {
    assert.strictEqual(normalizeError('Unable to generate the document. Error: Formatter "x" is disabled. Source: "{d.a:x}"'), 'Formatter "x" is disabled.');
  });
});

for (const name of ['help', 'matrix']) {
  const set = require('./golden/' + name + '.json');
  describe('эталоны EE: ' + name, function () {
    // глобальные настройки (курсы валют, язык) могут остаться от других тестов — эталоны снимались с настройками по умолчанию
    beforeEach(function () { carbone.reset(); });
    after(function () { carbone.reset(); });
    for (const c of set.cases) {
      if (c.skip) {
        it.skip(c.id + ' — ' + c.skip);
        continue;
      }
      it(c.id, async function () {
        const got = await run(c);
        if (c.volatile) {
          const ok = !got.error;
          if (GAPS.has(c.id)) return assert.ok(!ok, c.id + ' теперь рендерится без ошибки — уберите его из test/golden/known-gaps.json');
          return assert.ok(ok, c.id + ': ' + got.error);
        }
        const want = expected(c);
        const same = JSON.stringify(got) === JSON.stringify(want);
        if (GAPS.has(c.id)) {
          assert.ok(!same, c.id + ' теперь совпадает с эталоном — уберите его из test/golden/known-gaps.json');
        }
        else {
          assert.deepStrictEqual(got, want);
        }
      });
    }
  });
}
