// :html (2.5.0, спецификация §34.3–34.4): независимая от формата модель HTML.
const assert = require('assert');
const model = require('../lib/html-model');

const SRC = '{d.x:html}';

// ---------------------------------------------------------------------------------------------------------------
// Конструкторы ожидаемых объектов

function M (over) {
  return Object.assign({
    bold: false, italic: false, underline: false, strike: false, sup: false, sub: false, mark: false, mono: false,
    color: null, background: null
  }, over || {});
}
function T (text, marks) {
  return { type: 'text', text: text, marks: M(marks) };
}
const BR = { type: 'break' };
function IMG (src, width, height) {
  return { type: 'image', src: src, width: width === undefined ? null : width, height: height === undefined ? null : height };
}
function CB (checked) {
  return { type: 'checkbox', checked: checked };
}
function A (href, children) {
  return { type: 'link', href: href, children: children };
}
function blockFields (opts) {
  return {
    quote: (opts && opts.quote) || 0,
    breakBefore: !!(opts && opts.breakBefore),
    breakAfter: !!(opts && opts.breakAfter)
  };
}
function P (inlines, opts) {
  return Object.assign({ type: 'para', inlines: inlines }, blockFields(opts));
}
function H (level, inlines, opts) {
  return Object.assign({ type: 'heading', level: level, inlines: inlines }, blockFields(opts));
}
function PRE (lines, opts) {
  return Object.assign({ type: 'pre', lines: lines }, blockFields(opts));
}
function HR (opts) {
  return Object.assign({ type: 'hr' }, blockFields(opts));
}
function LIST (ordered, items, opts) {
  return Object.assign({ type: 'list', ordered: ordered, items: items }, blockFields(opts));
}
function LI (blocks, checkbox) {
  return { blocks: blocks, checkbox: checkbox === undefined ? null : checkbox };
}
function TABLE (rows, caption, opts) {
  return Object.assign({ type: 'table', rows: rows, caption: caption || null }, blockFields(opts));
}
function ROW (cells) {
  return { cells: cells };
}
function TD (blocks, colspan, rowspan) {
  return { header: false, colspan: colspan || 1, rowspan: rowspan || 1, blocks: blocks };
}
function TH (blocks, colspan, rowspan) {
  return { header: true, colspan: colspan || 1, rowspan: rowspan || 1, blocks: blocks };
}

function parse (html) {
  return model.parse(html, SRC);
}

describe('html: модель', function () {
  describe('parse: текст и пробелы', function () {
    it('пустая строка — ничего', function () {
      assert.deepStrictEqual(parse(''), []);
      assert.deepStrictEqual(parse('   \n\t '), []);
    });

    it('текст вне блоков — абзац, пробелы схлопываются и обрезаются', function () {
      assert.deepStrictEqual(parse('  Привет \n\t  мир  '), [P([T('Привет мир')])]);
    });

    it('пробелы между блоками отбрасываются, пустой p не создаёт абзац', function () {
      assert.deepStrictEqual(parse('<p> a </p>\n  <p></p>\n<p>b</p>'), [P([T('a')]), P([T('b')])]);
    });

    it('пробел между элементами строки сохраняется один', function () {
      assert.deepStrictEqual(parse('<p>a <b> b </b> c</p>'), [P([T('a '), T('b ', { bold: true }), T('c')])]);
    });

    it('сущности: &nbsp; — U+00A0 без схлопывания, &#9; — пробел, эмодзи, < и "', function () {
      assert.deepStrictEqual(parse('a&nbsp;&nbsp;b&#9;&#9;c &lt;&quot;&amp;&#169; &#x1F600;'), [
        P([T('a  b c <"&© 😀')])
      ]);
    });

    it('текст до и после вложенного блока в p — свои абзацы', function () {
      assert.deepStrictEqual(parse('<p>a<ul><li>b</li></ul>c</p>'), [
        P([T('a')]), LIST(false, [LI([P([T('b')])])]), P([T('c')])
      ]);
    });

    it('div, section и подобные — границы абзацев, span — только текст', function () {
      assert.deepStrictEqual(parse('a<div>b<span class="x">c</span></div><section>d</section>e'), [
        P([T('a')]), P([T('bc')]), P([T('d')]), P([T('e')])
      ]);
    });
  });

  describe('parse: оформление текста', function () {
    const cases = [
      ['b', { bold: true }], ['strong', { bold: true }], ['i', { italic: true }], ['em', { italic: true }],
      ['u', { underline: true }], ['s', { strike: true }], ['del', { strike: true }], ['sup', { sup: true }],
      ['sub', { sub: true }], ['mark', { mark: true }], ['code', { mono: true }], ['kbd', { mono: true }],
      ['samp', { mono: true }]
    ];
    cases.forEach(function (c) {
      it('<' + c[0] + '>', function () {
        assert.deepStrictEqual(parse('x<' + c[0] + '>y</' + c[0] + '>'), [P([T('x'), T('y', c[1])])]);
      });
    });

    it('вложенное оформление накапливается', function () {
      assert.deepStrictEqual(parse('<b>a<i>b<u>c</u></i></b>d'), [
        P([T('a', { bold: true }), T('b', { bold: true, italic: true }),
          T('c', { bold: true, italic: true, underline: true }), T('d')])
      ]);
    });

    it('style: color и background-color на любом элементе, неверные значения пропускаются', function () {
      assert.deepStrictEqual(parse(
        '<span style="color: #f00; background-color: rgb(0,0,255)">a</span>' +
        '<span style="color: nonsense; font-size: 20px">b</span>' +
        '<p style="color:green">c<span style="color:red">d</span></p>'
      ), [
        P([T('a', { color: 'FF0000', background: '0000FF' }), T('b')]),
        P([T('c', { color: '008000' }), T('d', { color: 'FF0000' })])
      ]);
    });

    it('mark: свой background-color не меняет фон, color работает', function () {
      assert.deepStrictEqual(parse('<mark style="background-color:red;color:blue">a</mark>'), [
        P([T('a', { mark: true, color: '0000FF' })])
      ]);
    });

    it('br: перенос, пробелы вокруг обрезаются, последний br абзаца отбрасывается', function () {
      assert.deepStrictEqual(parse('<p>a <br> b<br></p><p><br></p>'), [P([T('a'), BR, T('b')]), P([BR])]);
    });
  });

  describe('parse: блоки', function () {
    it('h1–h6', function () {
      assert.deepStrictEqual(parse('<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6>'), [
        H(1, [T('a')]), H(2, [T('b')]), H(3, [T('c')]), H(4, [T('d')]), H(5, [T('e')]), H(6, [T('f')])
      ]);
    });

    it('pre: пробелы и переносы сохраняются, первый перенос после <pre> и последний пустой — нет', function () {
      assert.deepStrictEqual(parse('<pre>\n  a  <b>b</b>\n\tc<br>d\n</pre>'), [
        PRE([[T('  a  ', { mono: true }), T('b', { mono: true, bold: true })], [T('\tc', { mono: true })],
          [T('d', { mono: true })]])
      ]);
    });

    it('pre: пустая строка внутри сохраняется, блоки внутри — только текст', function () {
      assert.deepStrictEqual(parse('<pre>a\n\n<p>b</p></pre>'), [
        PRE([[T('a', { mono: true })], [], [T('b', { mono: true })]])
      ]);
    });

    it('hr', function () {
      assert.deepStrictEqual(parse('a<hr>b'), [P([T('a')]), HR(), P([T('b')])]);
    });

    it('blockquote: уровень накапливается', function () {
      assert.deepStrictEqual(parse('<blockquote>a<blockquote><p>b</p></blockquote>c</blockquote>d'), [
        P([T('a')], { quote: 1 }), P([T('b')], { quote: 2 }), P([T('c')], { quote: 1 }), P([T('d')])
      ]);
    });

    it('blockquote: список и hr внутри получают уровень, блоки в пунктах — от 0', function () {
      assert.deepStrictEqual(parse('<blockquote><ul><li>a</li></ul><hr></blockquote>'), [
        LIST(false, [LI([P([T('a')])])], { quote: 1 }), HR({ quote: 1 })
      ]);
    });

    it('ul/ol/li с вложенностью, незакрытые li', function () {
      assert.deepStrictEqual(parse('<ul><li>a<ol><li>b<li>c</ol>d<li><p>e</p><p>f</p></ul>'), [
        LIST(false, [
          LI([P([T('a')]), LIST(true, [LI([P([T('b')])]), LI([P([T('c')])])]), P([T('d')])]),
          LI([P([T('e')]), P([T('f')])])
        ])
      ]);
    });

    it('текст прямо в ul — свой пункт, пустой список отбрасывается', function () {
      assert.deepStrictEqual(parse('<ul> x </ul><ol> </ol>'), [LIST(false, [LI([P([T('x')])])])]);
    });

    it('флажки: в начале li — item.checkbox, в тексте — inline', function () {
      assert.deepStrictEqual(parse(
        '<ul><li><input type="checkbox" checked> a</li><li><p><input type=checkbox>b</p></li>' +
        '<li>c <input type="checkbox" checked="checked"> d</li></ul><input type="text">x'
      ), [
        LIST(false, [
          LI([P([T('a')])], true),
          LI([P([T('b')])], false),
          LI([P([T('c '), CB(true), T(' d')])])
        ]),
        P([T('x')])
      ]);
    });

    it('флажок вне списка — inline', function () {
      assert.deepStrictEqual(parse('<input type="checkbox" checked="">a'), [P([CB(true), T('a')])]);
    });

    it('таблица: thead/tbody/tfoot, th жирный, colspan/rowspan, caption', function () {
      assert.deepStrictEqual(parse(
        '<table><caption>Итог <i>года</i></caption>' +
        '<thead><tr><th colspan="2">Заголовок</th></tr></thead>' +
        '<tbody><tr><td rowspan="2">a</td><td>b</td></tr><tr><td></td></tr></tbody>' +
        '<tfoot><tr><td colspan="x">c</td><td rowspan="0">d</td></tr></tfoot></table>'
      ), [
        TABLE([
          ROW([TH([P([T('Заголовок', { bold: true })])], 2)]),
          ROW([TD([P([T('a')])], 1, 2), TD([P([T('b')])])]),
          ROW([TD([])]),
          ROW([TD([P([T('c')])]), TD([P([T('d')])])])
        ], [T('Итог '), T('года', { italic: true })])
      ]);
    });

    it('таблица: незакрытые tr/td, вложенная таблица, список в ячейке', function () {
      assert.deepStrictEqual(parse(
        '<table><tr><td>a<td><ul><li>b</ul><tr><td><table><tr><td>c</table></table>'
      ), [
        TABLE([
          ROW([TD([P([T('a')])]), TD([LIST(false, [LI([P([T('b')])])])])]),
          ROW([TD([TABLE([ROW([TD([P([T('c')])])])])])])
        ])
      ]);
    });

    it('таблица без строк отбрасывается, подпись остаётся абзацем', function () {
      assert.deepStrictEqual(parse('<table></table><table><caption>c</caption></table>'), [P([T('c')])]);
    });

    it('break-before/break-after: page — у блока; прочие значения пропускаются', function () {
      assert.deepStrictEqual(parse(
        '<p style="break-before: page">a</p><h2 style="break-after:page">b</h2>' +
        '<div style="break-before:page"><p>c</p><p style="break-after:avoid">d</p></div>' +
        '<ul style="break-after: page"><li>e</li></ul><hr style="break-before:page">'
      ), [
        P([T('a')], { breakBefore: true }),
        H(2, [T('b')], { breakAfter: true }),
        P([T('c')], { breakBefore: true }),
        P([T('d')]),
        LIST(false, [LI([P([T('e')])])], { breakAfter: true }),
        HR({ breakBefore: true })
      ]);
    });
  });

  describe('parse: ссылки и изображения', function () {
    it('a href — ссылка с оформлением внутри, a без href — текст', function () {
      assert.deepStrictEqual(parse('x <a href="https://e.ru">s <b>b</b></a> <a name="q">y</a>'), [
        P([T('x '), A('https://e.ru', [T('s '), T('b', { bold: true })]), T(' y')])
      ]);
    });

    it('ссылка через границу блока продолжается в новом абзаце, пустая ссылка отбрасывается', function () {
      assert.deepStrictEqual(parse('<a href="#a">x<p>y</p></a><a href="#b"> </a>z'), [
        P([A('#a', [T('x')])]), P([A('#a', [T('y')])]), P([T('z')])
      ]);
    });

    it('img: src как есть, width/height — целые px, неверные — null, без src — пропуск', function () {
      assert.deepStrictEqual(parse(
        '<img src="data:image/png;base64,AAA" width="120" height="40px">' +
        '<img src=" https://e.ru/a.png " width="50%" height="abc"><img alt="x">'
      ), [
        P([IMG('data:image/png;base64,AAA', 120, 40), IMG('https://e.ru/a.png', null, null)])
      ]);
    });
  });

  describe('parse: мусор из внешних систем (Review Focus 2)', function () {
    it('script/style/head/title удаляются с содержимым', function () {
      assert.deepStrictEqual(parse(
        '<html><head><title>T</title><style>p{color:red}</style></head><body>' +
        'a<script>alert(1)</script>b</body></html>'
      ), [P([T('ab')])]);
    });

    it('перекрёстные и незакрытые теги, классы, неизвестные теги', function () {
      assert.deepStrictEqual(parse(
        '<div class="msg"><span class="x">Привет</span>, <b><i>мир</b></i>!</div><p>незакрыт<font color="red">ый'
      ), [
        P([T('Привет, '), T('мир', { bold: true, italic: true }), T('!')]),
        P([T('незакрытый')])
      ]);
    });

    it('лишние закрывающие теги игнорируются', function () {
      assert.deepStrictEqual(parse('</b></div>a</li></td>'), [P([T('a')])]);
    });
  });

  describe('parse: ограничения', function () {
    it('1 МБ — можно, больше — ошибка шаблона', function () {
      assert.doesNotThrow(function () {
        parse('a'.repeat(1048576));
      });
      assert.throws(function () {
        parse('a'.repeat(1048575) + 'я');
      }, /^Error: html: значение больше 1 МБ\. Source: "\{d\.x:html\}"$/);
    });

    it('вложенность 32 — можно, 33 — ошибка шаблона', function () {
      assert.doesNotThrow(function () {
        parse('<span>'.repeat(32) + 'x');
      });
      assert.throws(function () {
        parse('<span>'.repeat(33) + 'x');
      }, /^Error: html: вложенность тегов больше 32\. Source: "\{d\.x:html\}"$/);
      assert.throws(function () {
        parse('<div>'.repeat(32) + '<br>');
      }, /вложенность тегов больше 32/);
    });

    it('закрытые теги не увеличивают вложенность', function () {
      assert.doesNotThrow(function () {
        parse('<b>x</b>'.repeat(100));
      });
    });
  });

  describe('parse: регрессии ревью 1', function () {
    function fast (fn) {
      const start = Date.now();
      const result = fn();
      assert.ok(Date.now() - start < 100, 'дольше 100 мс: ' + (Date.now() - start));
      return result;
    }

    it('список прямо в списке — в блоки предыдущего пункта (вставка из Google Docs)', function () {
      assert.deepStrictEqual(parse('<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>'), [
        LIST(false, [LI([P([T('a')]), LIST(false, [LI([P([T('b')])])])]), LI([P([T('c')])])])
      ]);
    });

    it('список прямо в списке без предыдущего пункта — новый пункт', function () {
      assert.deepStrictEqual(parse('<ol><ul><li>b</li></ul></ol>'), [
        LIST(true, [LI([LIST(false, [LI([P([T('b')])])])])])
      ]);
    });

    it('width/height: ~200 КБ значения разбираются линейно', function () {
      const result = fast(function () {
        return parse('<img src="x" width="1' + ' '.repeat(200000) + 'x" height=" 30 px ">');
      });
      assert.deepStrictEqual(result, [P([IMG('x', null, 30)])]);
    });

    it('colspan и style: ~200 КБ значения разбираются линейно', function () {
      fast(function () {
        return parse('<table><tr><td colspan="1' + ' '.repeat(200000) + 'x">a</td></tr></table>');
      });
      const result = fast(function () {
        return parse('<span style="color: red !' + ' '.repeat(200000) + 'x">a</span>');
      });
      assert.deepStrictEqual(result, [P([T('a')])]);
    });

    it('cssColor: длинные числа и пробелы в rgb()/hsl() — линейно', function () {
      fast(function () {
        assert.strictEqual(model.cssColor('rgb(' + '1'.repeat(200000) + 'x 0 0)'), null);
      });
      fast(function () {
        assert.strictEqual(model.cssColor('rgb(' + ' '.repeat(200000) + 'x'), null);
      });
      fast(function () {
        assert.strictEqual(model.cssColor('hsl(1 2 3' + ' '.repeat(200000) + 'x'), null);
      });
      fast(function () {
        assert.strictEqual(model.cssColor('rgb(' + '1.'.repeat(100000) + ' 0 0)'), null);
      });
    });

    it('cssColor: бесконечные числа (1e999) — null, без исключения', function () {
      ['rgb(1e999 0 0)', 'rgb(0, 0, -1e999)', 'hsl(1e999 50% 50%)', 'hsl(120 1e999% 50%)', 'hsl(120, 50, 1e999)']
        .forEach(function (value) {
          assert.strictEqual(model.cssColor(value), null, value);
        });
    });
  });

  describe('inlineOnly', function () {
    it('только a, b, strong, em, i, s, del, u; прочее — текст; br и блоки — пробел; pre — пробелы', function () {
      assert.deepStrictEqual(model.inlineOnly(
        '<h1>Заголовок</h1><p>a <strong>b</strong> <span style="color:red">c</span></p><ul><li>d</li></ul>' +
        '<pre>e\nf</pre>x<br>y<img src="x.png"><input type="checkbox"><a href="https://e.ru"><u>l</u><em>m</em></a>' +
        '<sup>s</sup><mark>k</mark><del>z</del><s>q</s><i>w</i><b>v</b><script>alert(1)</script>', SRC
      ), [
        T('Заголовок a '), T('b', { bold: true }), T(' c d e f x y'),
        A('https://e.ru', [T('l', { underline: true }), T('m', { italic: true })]),
        T('sk'), T('zq', { strike: true }), T('w', { italic: true }), T('v', { bold: true })
      ]);
    });

    it('пустое значение — ничего; лимиты как у parse', function () {
      assert.deepStrictEqual(model.inlineOnly('  <p> </p> ', SRC), []);
      assert.throws(function () {
        model.inlineOnly('<b>'.repeat(33), SRC);
      }, /вложенность тегов больше 32/);
      assert.throws(function () {
        model.inlineOnly('a'.repeat(1048577), SRC);
      }, /больше 1 МБ/);
    });
  });

  describe('cssColor', function () {
    it('hex 3 и 6 цифр', function () {
      assert.strictEqual(model.cssColor('#abc'), 'AABBCC');
      assert.strictEqual(model.cssColor('#1F7a32'), '1F7A32');
      assert.strictEqual(model.cssColor('  #FFF  '), 'FFFFFF');
    });

    it('rgb() с пробелами и запятыми', function () {
      assert.strictEqual(model.cssColor('rgb(31 120 50)'), '1F7832');
      assert.strictEqual(model.cssColor('rgb(31,120,50)'), '1F7832');
      assert.strictEqual(model.cssColor('RGB( 31 , 120 , 50 )'), '1F7832');
      assert.strictEqual(model.cssColor('rgb(100%, 0%, 50%)'), 'FF0080');
    });

    it('hsl() с пробелами и запятыми', function () {
      assert.strictEqual(model.cssColor('hsl(120deg 75% 25%)'), '107010');
      assert.strictEqual(model.cssColor('hsl(120,75,25)'), '107010');
      assert.strictEqual(model.cssColor('hsl(0, 100%, 50%)'), 'FF0000');
      assert.strictEqual(model.cssColor('hsl(240 100% 50%)'), '0000FF');
    });

    it('148 именованных цветов, без учёта регистра', function () {
      assert.strictEqual(Object.keys(model.NAMED_COLORS).length, 148);
      assert.strictEqual(model.cssColor('red'), 'FF0000');
      assert.strictEqual(model.cssColor('RebeccaPurple'), '663399');
      assert.strictEqual(model.cssColor('lightgoldenrodyellow'), 'FAFAD2');
      assert.strictEqual(model.cssColor('grey'), '808080');
    });

    it('неверные значения — null', function () {
      ['', '#ab', '#abcd', '#abcdeg', '#aabbccdd', 'rgb(1,2)', 'rgb(a,b,c)', 'hsl(1 2)', 'blurple', 'transparent',
        'currentColor', 'rgb(1 2 3', null, undefined, 42].forEach(function (value) {
        assert.strictEqual(model.cssColor(value), null, String(value));
      });
    });
  });

  describe('parseOptions', function () {
    const DEFAULT = { inline: false, nospace: false, headingtheme: null, tabletheme: null, quotetheme: null };

    it('без параметров', function () {
      assert.deepStrictEqual(model.parseOptions([], SRC), DEFAULT);
      assert.deepStrictEqual(model.parseOptions(undefined, SRC), DEFAULT);
    });

    it('каждый параметр', function () {
      assert.deepStrictEqual(model.parseOptions(['inline'], SRC), Object.assign({}, DEFAULT, { inline: true }));
      assert.deepStrictEqual(model.parseOptions(['nospace'], SRC), Object.assign({}, DEFAULT, { nospace: true }));
      assert.deepStrictEqual(model.parseOptions(['headingtheme:Title'], SRC),
        Object.assign({}, DEFAULT, { headingtheme: 'Title' }));
      assert.deepStrictEqual(model.parseOptions(['tabletheme:GridTable4'], SRC),
        Object.assign({}, DEFAULT, { tabletheme: 'GridTable4' }));
      assert.deepStrictEqual(model.parseOptions(['quotetheme:Intense_20_Quote'], SRC),
        Object.assign({}, DEFAULT, { quotetheme: 'Intense_20_Quote' }));
    });

    it('комбинации через запятую, пробелы и кавычки', function () {
      const expected = { inline: false, nospace: true, headingtheme: 'My Heading', tabletheme: 'Grid', quotetheme: 'Quote' };
      assert.deepStrictEqual(model.parseOptions([' nospace', ' headingtheme: \'My Heading\'', 'tabletheme:Grid ',
        'quotetheme:Quote'], SRC), expected);
      assert.deepStrictEqual(model.parseOptions(['nospace, headingtheme:My Heading,tabletheme:Grid', 'quotetheme:Quote'],
        SRC), expected);
    });

    it('неизвестный параметр или тема без значения — ошибка шаблона', function () {
      assert.throws(function () {
        model.parseOptions(['inline', 'bold'], SRC);
      }, /^Error: html: неизвестный параметр «bold»\. Source: "\{d\.x:html\}"$/);
      assert.throws(function () {
        model.parseOptions(['inline:yes'], SRC);
      }, /неизвестный параметр «inline:yes»/);
      assert.throws(function () {
        model.parseOptions(['headingtheme'], SRC);
      }, /^Error: html: у параметра «headingtheme» нет значения\. Source: "\{d\.x:html\}"$/);
      assert.throws(function () {
        model.parseOptions(['tabletheme: '], SRC);
      }, /у параметра «tabletheme» нет значения/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// :html в DOCX (Task 4): конвейер и текст; сборка через renderBuffer — шаг finish выполняется только там

const carbone = require('../lib/index');
const { buildDocx, readEntry, zipBuffer } = require('./golden-lib');

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const COURIER = '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>';
const JC = '<w:jc w:val="center"/>';
const SZ = '<w:sz w:val="28"/>';

// XML правильно вложен, сущности допустимы, жетонов (символы частного использования) не осталось
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
  const text = xml.replace(re, '');
  assert.ok(!/[<>]/.test(text), 'символ < или > вне тега в ' + xml);
  assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xml), 'неверная сущность в ' + xml);
  assert.ok(!/[-]/.test(xml), 'жетон остался в ' + xml);
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml), 'недопустимый символ XML в ' + xml);
}

// ожидаемая разметка
const wR = (text, rPr) => '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + text + '</w:t></w:r>';
const wBR = (rPr) => '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w:br/></w:r>';
const wP = (inner, pPr) => '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + inner + '</w:p>';
const wSP = (pPr) => (pPr ? '<w:p><w:pPr>' + pPr + '</w:pPr></w:p>' : '<w:p/>');
// абзац шаблона с меткой
const mp = (text, pPr, rPr) => '<w:p>' + (pPr ? '<w:pPr>' + pPr + '</w:pPr>' : '') + '<w:r>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '')
  + '<w:t>' + text + '</w:t></w:r></w:p>';

const BODY_END = '<w:p/><w:sectPr/></w:body>';

async function renderDocx (raws, data, files, options) {
  const tpl = await buildDocx(raws.map(() => '<<RAW>>').join('\n'), raws, '', files);
  return carbone.renderBuffer(tpl, 'docx', data, options || {});
}

// содержимое w:body без хвоста buildDocx
async function bodyOf (raws, data, options) {
  const xml = await readEntry(await renderDocx(raws, data, undefined, options), 'word/document.xml');
  assertWellFormed(xml);
  return xml.slice(xml.indexOf('<w:body>') + 8, xml.lastIndexOf(BODY_END));
}

async function htmlBody (html, marker, pPr, rPr) {
  return bodyOf([mp(marker || '{d.h:html}', pPr, rPr)], { h: html });
}

async function rejection (promise) {
  try {
    await promise;
  }
  catch (e) {
    return e.message;
  }
  throw new Error('ожидалась ошибка');
}

function renderXml (extension, xml, data) {
  return new Promise((resolve, reject) => carbone.renderXML(xml, data, { extension }, (err, res) => err ? reject(err) : resolve(res)));
}

describe('html: DOCX — разметка текста', function () {
  const one = [
    ['b', '<w:b/>'], ['strong', '<w:b/>'], ['i', '<w:i/>'], ['em', '<w:i/>'], ['u', '<w:u w:val="single"/>'],
    ['s', '<w:strike/>'], ['del', '<w:strike/>'], ['sup', '<w:vertAlign w:val="superscript"/>'],
    ['sub', '<w:vertAlign w:val="subscript"/>'], ['mark', '<w:highlight w:val="yellow"/>'],
    ['code', COURIER], ['kbd', COURIER], ['samp', COURIER]
  ];
  for (const [tag, rPr] of one) {
    it('<' + tag + '>', async function () {
      assert.strictEqual(await htmlBody('<' + tag + '>x</' + tag + '>'), wP(wR('x', rPr)) + wSP());
    });
  }

  it('вложенные теги: порядок w:rPr по схеме', async function () {
    assert.strictEqual(await htmlBody('<u><s><i><b>x</b></i></s></u>'), wP(wR('x', '<w:b/><w:i/><w:strike/><w:u w:val="single"/>')) + wSP());
    assert.strictEqual(await htmlBody('<sup><mark><code>x</code></mark></sup>'),
      wP(wR('x', COURIER + '<w:highlight w:val="yellow"/><w:vertAlign w:val="superscript"/>')) + wSP());
  });

  it('color и background-color', async function () {
    assert.strictEqual(await htmlBody('<span style="color:red;background-color:#00ff00">x</span>'),
      wP(wR('x', '<w:color w:val="FF0000"/><w:shd w:val="clear" w:fill="00FF00"/>')) + wSP());
  });

  it('текст по частям: оформление меняется внутри абзаца, экранирование & < > "', async function () {
    assert.strictEqual(await htmlBody('a &amp; <b>b &lt;"&gt;</b> c'),
      wP(wR('a &amp; ') + wR('b &lt;&quot;&gt;', '<w:b/>') + wR(' c')) + wSP());
  });

  it('p и br', async function () {
    assert.strictEqual(await htmlBody('<p>a</p><p>b<br>c</p>'), wP(wR('a')) + wSP() + wP(wR('b') + wBR() + wR('c')) + wSP());
  });

  it('pre: табуляция — w:tab, пробелы сохраняются', async function () {
    assert.strictEqual(await htmlBody('<pre>a\tb\n  c</pre>'),
      wP('<w:r><w:rPr>' + COURIER + '</w:rPr><w:t xml:space="preserve">a</w:t><w:tab/><w:t xml:space="preserve">b</w:t></w:r>'
        + wBR() + wR('  c', COURIER)) + wSP());
  });

  it('прочие блоки (до Task 5–6) — абзацы с их текстом', async function () {
    const out = await htmlBody('<h1>H</h1><ul><li>x</li></ul><table><tr><td>c</td></tr></table>');
    assert.ok(out.includes(wR('H')) && out.includes(wR('x')) && out.includes(wR('c')), out);
  });
});

describe('html: DOCX — абзац метки', function () {
  it('метка одна в абзаце: пустые «до» и «после» не создаются', async function () {
    assert.strictEqual(await htmlBody('<p>a</p>'), wP(wR('a')) + wSP());
  });

  it('текст до и после метки — в своих абзацах с тем же w:pPr и w:rPr', async function () {
    assert.strictEqual(await htmlBody('<p>a</p>', 'До {d.h:html} после', JC, SZ),
      wP(wR('До ', SZ), JC) + wP(wR('a', SZ), JC) + wSP(JC) + wP(wR(' после', SZ), JC));
  });

  it('метка в своём w:r между другими: соседние w:r остаются, пустой w:r метки не остаётся', async function () {
    const raw = '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t>{d.h:html}</w:t></w:r><w:r><w:t>B</w:t></w:r></w:p>';
    assert.strictEqual(await bodyOf([raw], { h: 'x' }),
      '<w:p><w:r><w:t>A</w:t></w:r></w:p>' + wP(wR('x')) + wSP() + '<w:p><w:r><w:t>B</w:t></w:r></w:p>');
  });

  it('две метки в одном абзаце', async function () {
    assert.strictEqual(await bodyOf([mp('{d.a:html}-{d.b:html}')], { a: 'x', b: 'y' }),
      wP(wR('x')) + wSP() + wP(wR('-')) + wP(wR('y')) + wSP());
  });

  it('nospace: без пустых абзацев', async function () {
    assert.strictEqual(await htmlBody('<p>a</p><p>b</p>', '{d.h:html(nospace)}'), wP(wR('a')) + wP(wR('b')));
  });

  it('наследование w:rPr метки: шрифт, размер, цвет; свойство метки побеждает', async function () {
    const rPr = '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="0000FF"/>' + SZ;
    assert.strictEqual(await htmlBody('<span style="color:red"><b>x</b></span><code>y</code>', null, null, rPr),
      wP(wR('x', '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="0000FF"/>' + SZ) + wR('y', rPr)) + wSP());
  });

  it('w:sectPr метки (R7) — только в последнем созданном абзаце', async function () {
    const sect = '<w:sectPr><w:pgSz w:w="11906"/></w:sectPr>';
    assert.strictEqual(await htmlBody('<p>a</p><p>b</p>', null, JC + sect),
      wP(wR('a'), JC) + wSP(JC) + wP(wR('b'), JC) + wSP(JC + sect));
    assert.strictEqual(await htmlBody('<p>a</p><p>b</p>', '{d.h:html(nospace)}', JC + sect),
      wP(wR('a'), JC) + wP(wR('b'), JC + sect));
    assert.strictEqual(await htmlBody('<p>a</p>', 'X{d.h:html}Y', JC + sect),
      wP(wR('X'), JC) + wP(wR('a'), JC) + wSP(JC) + wP(wR('Y'), JC + sect));
  });

  it('разрыв страницы до и после блока', async function () {
    assert.strictEqual(await htmlBody('<p style="break-before: page">a</p><p style="break-after: page">b</p>'),
      wP('<w:r><w:br w:type="page"/></w:r>' + wR('a')) + wSP() + wP(wR('b')) + wSP() + wP('<w:r><w:br w:type="page"/></w:r>'));
  });

  it('null, undefined и \'\' — ничего, абзац как у обычной метки', async function () {
    const plain = await bodyOf([mp('{d.h}')], { h: '' });
    for (const h of [null, undefined, '']) {
      assert.strictEqual(await bodyOf([mp('{d.h:html}')], { h }), plain);
    }
  });

  it('HTML без содержимого (только script) — абзац метки остаётся пустым', async function () {
    assert.strictEqual(await htmlBody('<script>x</script>'), await bodyOf([mp('{d.h}')], { h: '' }));
  });

  it('ячейка таблицы: ячейка заканчивается w:p', async function () {
    const tpl = await buildDocx('| {d.h:html(nospace)} |');
    const xml = await readEntry(await carbone.renderBuffer(tpl, 'docx', { h: '<p>a</p><p>b</p>' }, {}), 'word/document.xml');
    assertWellFormed(xml);
    assert.ok(xml.includes('</w:tcPr>' + wP(wR('a')) + wP(wR('b')) + '</w:tc>'), xml);
  });

  it('колонтитул word/header1.xml', async function () {
    const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ' + W_NS + '>' + mp('{d.h:html}') + '</w:hdr>';
    const out = await renderDocx([mp('тело')], { h: '<b>x</b>' }, { 'word/header1.xml': header });
    const xml = await readEntry(out, 'word/header1.xml');
    assertWellFormed(xml);
    assert.ok(xml.endsWith('<w:hdr ' + W_NS + '>' + wP(wR('x', '<w:b/>')) + wSP() + '</w:hdr>'), xml);
  });

  it('inline: в том же абзаце, разметка внутри, блоки — текст', async function () {
    assert.strictEqual(await htmlBody('<p>a <b>b</b></p><h1>c <code>d</code></h1>', 'До {d.h:html(inline)} после', JC, SZ),
      wP(wR('До ', SZ) + wR('a ', SZ) + wR('b', '<w:b/>' + SZ) + wR(' c d', SZ) + wR(' после', SZ), JC));
  });

  it('Review Focus 2: мусорный HTML — корректный XML, текст сохранён, скрипт удалён', async function () {
    const html = '<div>Начало <span class="x">спан</span><script>alert(1)</script> <b><i>x</b></i> &nbsp;&lt; " 😀 a\u0001b <p>незакрыт';
    const out = await htmlBody(html);
    assert.ok(!out.includes('alert'), out);
    for (const s of ['Начало ', 'спан', '&lt;', '&quot;', '😀', ' ', 'ab', 'незакрыт']) {
      assert.ok(out.includes(s), s + ' в ' + out);
    }
  });

  it('{o.preReleaseFeatureIn=…} в шаблоне не мешает', async function () {
    assert.strictEqual(await bodyOf([mp('{o.preReleaseFeatureIn=5011000}'), mp('{d.h:html}')], { h: 'x' }),
      '<w:p><w:r><w:t></w:t></w:r></w:p>' + wP(wR('x')) + wSP());
  });

  it('defaultURL + html (R4): значение не меняется', async function () {
    assert.strictEqual(await htmlBody('<b>x</b>', '{d.h:defaultURL(\'https://site.ru\'):html}'), wP(wR('x', '<w:b/>')) + wSP());
  });
});

describe('html: HTML-шаблон и ODT', function () {
  it('HTML-шаблон: значение без экранирования', async function () {
    const out = await carbone.renderBuffer(Buffer.from('<html><body>{d.h:html}|{d.e:html}</body></html>'), 'html', { h: '<b>X</b> & "y"', e: null }, {});
    assert.strictEqual(out.toString(), '<html><body><b>X</b> & "y"|</body></html>');
  });

  it('ODT: допускается, жетон не остаётся', async function () {
    const content = '<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"'
      + ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>{d.h:html}</text:p>'
      + '</office:text></office:body></office:document-content>';
    const tpl = await zipBuffer([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' }, { name: 'content.xml', data: content }]);
    const xml = await readEntry(await carbone.renderBuffer(tpl, 'odt', { h: '<b>x</b> &amp; y' }, {}), 'content.xml');
    assertWellFormed(xml);
    assert.ok(xml.includes('x &amp; y'), xml);
  });
});

describe('html: ошибки шаблона', function () {
  it('XLSX, PPTX, ODS, ODP, XML — html не поддерживается', async function () {
    for (const ext of ['xlsx', 'pptx', 'ods', 'odp', 'xml']) {
      assert.strictEqual(await rejection(renderXml(ext, '<a>{d.h:html}</a>', { h: 'x' })),
        'html не поддерживается в ' + ext.toUpperCase() + '. Source: "{d.h:html}"');
    }
    assert.strictEqual(await rejection(carbone.renderBuffer(Buffer.from('<a>{d.h:html}</a>'), 'xml', { h: 'x' }, {})),
      'html не поддерживается в XML. Source: "{d.h:html}"');
  });

  it('неизвестный параметр — ошибка до сборки, даже если метка не выполняется', async function () {
    assert.strictEqual(await rejection(renderDocx([mp('{d.h:html(foo)}')], {})), 'html: неизвестный параметр «foo». Source: "{d.h:html(foo)}"');
  });

  it('жетон в замещающем тексте картинки (R6)', async function () {
    const drawing = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="1" name="p" descr="{d.h:html}"/>'
      + '</wp:inline></w:drawing></w:r></w:p>';
    assert.strictEqual(await rejection(renderDocx([drawing], { h: '<b>x</b>' })), 'html ставится в текст абзаца. Source: "{d.h:html}"');
  });

  it('значение больше 1 МБ', async function () {
    assert.strictEqual(await rejection(renderDocx([mp('{d.h:html}')], { h: 'a'.repeat(1024 * 1024 + 1) })),
      'html: значение больше 1 МБ. Source: "{d.h:html}"');
  });

  it('вложенность глубже 32', async function () {
    assert.strictEqual(await rejection(renderDocx([mp('{d.h:html}')], { h: '<span>'.repeat(33) + 'x' })),
      'html: вложенность тегов больше 32. Source: "{d.h:html}"');
  });
});
