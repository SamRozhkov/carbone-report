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

  it('заголовок, список и таблица — текст на месте', async function () {
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
    assert.ok(xml.includes('<text:p><text:span text:style-name="CRh1">x</text:span> &amp; y</text:p><text:p/>'), xml);
    // автоматические стили и пространства имён style/fo появляются, если их не было
    assert.ok(xml.includes('<office:automatic-styles><style:style style:name="CRh1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles><office:body>'), xml);
    assert.ok(/<office:document-content [^>]*xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1\.0"/.test(xml), xml);
    assert.ok(/<office:document-content [^>]*xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1\.0"/.test(xml), xml);
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

describe('html: доработка 1', function () {
  it('форматтер после html — ошибка шаблона', async function () {
    for (const m of ['{d.h:html:upperCase}', '{d.h:html(inline):substr(0,2)}', '{d.h:html:print(x)}']) {
      assert.strictEqual(await rejection(renderDocx([mp(m)], { h: 'x' })), 'html должен быть последним форматтером. Source: "' + m + '"');
    }
    assert.strictEqual(await htmlBody('<b>x</b>', '{d.h:html:defaultURL(\'https://site.ru\')}'), wP(wR('x', '<w:b/>')) + wSP());
  });

  it('5000 строк таблицы с :html — без квадратичной проверки вложенных абзацев', async function () {
    this.timeout(30000);
    const rows = Array.from({ length: 5000 }, (v, i) => ({ h: '<b>' + i + '</b>' }));
    const tpl = await buildDocx('| {d.rows[i].h:html(nospace)} |\n| {d.rows[i+1].h:html(nospace)} |');
    const start = Date.now();
    const xml = await readEntry(await carbone.renderBuffer(tpl, 'docx', { rows }, {}), 'word/document.xml');
    const ms = Date.now() - start;
    assert.ok(xml.includes(wR('4999', '<w:b/>')), 'последняя строка');
    assert.ok(ms < 1500, 'сборка ' + ms + ' мс');
  });

  it('вложенный абзац (надпись) с жетоном внутри абзаца с жетоном', async function () {
    const raw = '<w:p><w:r><w:t>{d.a:html}</w:t></w:r><w:r><w:pict><w:txbxContent>' + mp('{d.b:html}') + '</w:txbxContent></w:pict></w:r></w:p>';
    const out = await bodyOf([raw], { a: 'x', b: 'y' });
    assert.ok(out.includes('<w:txbxContent>' + wP(wR('y')) + wSP() + '</w:txbxContent>'), out);
    assert.ok(out.startsWith(wP(wR('x')) + wSP()), out);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// :html в DOCX (Task 5): списки, заголовки, цитаты, pre, hr, разрывы, флажки

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NUM_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';
const STY_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';
const NUM_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';
const STY_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const W14_NS = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';

// ожидаемая разметка пунктов
const numPr = (ilvl, numId) => '<w:numPr><w:ilvl w:val="' + ilvl + '"/><w:numId w:val="' + numId + '"/></w:numPr>';
const ind = (left, hanging) => '<w:ind w:left="' + left + '"' + (hanging ? ' w:hanging="' + hanging + '"' : '') + '/>';
const wLI = (inner, ilvl, numId, left, more) => wP(inner, numPr(ilvl, numId) + ind(left, 360) + (more || ''));
const BOX = (checked, rPr) => '<w:sdt><w:sdtPr>' + (rPr ? '<w:rPr>' + rPr + '</w:rPr>' : '') + '<w14:checkbox><w14:checked w14:val="' + (checked ? 1 : 0) + '"/>'
  + '<w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr>'
  + '<w:sdtContent>' + wR(checked ? '☒' : '☐', rPr) + '</w:sdtContent></w:sdt>';

// уровни abstractNum, как их пишет html-docx-parts
function levels (ordered) {
  const fmt = ordered ? ['decimal', 'lowerLetter', 'lowerRoman'] : ['bullet', 'bullet', 'bullet'];
  const bullets = ['•', '◦', '▪'];
  let out = '';
  for (let i = 0; i < 9; i++) {
    out += '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + fmt[i % 3] + '"/>'
      + '<w:lvlText w:val="' + (ordered ? '%' + (i + 1) + '.' : bullets[i % 3]) + '"/><w:lvlJc w:val="left"/>'
      + '<w:pPr><w:ind w:left="' + (720 * (i + 1)) + '" w:hanging="360"/></w:pPr></w:lvl>';
  }
  return out;
}
const abstractNum = (id, ordered) => '<w:abstractNum w:abstractNumId="' + id + '"><w:multiLevelType w:val="hybridMultilevel"/>' + levels(ordered) + '</w:abstractNum>';

// сборка с частями: { doc, numbering, styles, rels, ct, header }
async function renderParts (raws, data, opts) {
  const o = opts || {};
  const tpl = await buildDocx(raws.map(() => '<<RAW>>').join('\n'), raws, o.rels || '', o.files);
  const out = await carbone.renderBuffer(tpl, 'docx', data, {});
  const get = (name) => readEntry(out, name).catch(() => null);
  const res = {
    doc: await get('word/document.xml'),
    numbering: await get('word/numbering.xml'),
    styles: await get('word/styles.xml'),
    rels: await get('word/_rels/document.xml.rels'),
    ct: await get('[Content_Types].xml'),
    header: await get('word/header1.xml')
  };
  for (const k of Object.keys(res)) {
    if (res[k] !== null) assertWellFormed(res[k]);
  }
  res.body = res.doc.slice(res.doc.indexOf('<w:body>') + 8, res.doc.lastIndexOf(BODY_END));
  return res;
}

const STYLES = (inner) => XML_HEAD + '<w:styles ' + W_NS + '>' + inner + '</w:styles>';
const NUMBERING = (inner) => XML_HEAD + '<w:numbering ' + W_NS + '>' + inner + '</w:numbering>';
const styleP = (id, name) => '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/></w:style>';

describe('html: DOCX — списки', function () {
  it('ul три уровня: пункты с w:numPr и отступом, маркеры •/◦/▪ в numbering.xml', async function () {
    const r = await renderParts([mp('{d.h:html}')], { h: '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>' });
    assert.strictEqual(r.body,
      wLI(wR('a'), 0, 1, 720) + wLI(wR('b'), 1, 2, 1440) + wLI(wR('c'), 2, 3, 2160) + wLI(wR('d'), 0, 1, 720) + wSP());
    assert.strictEqual(r.numbering, XML_HEAD + '<w:numbering ' + W_NS + '>' + abstractNum(0, false)
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num>'
      + '<w:num w:numId="3"><w:abstractNumId w:val="0"/></w:num></w:numbering>');
  });

  it('ol три уровня: 1./a./i., свой счёт каждого списка (startOverride)', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}')], { h: '<ol><li>a<ol><li>b<ol><li>c</li></ol></li></ol></li></ol>' });
    assert.strictEqual(r.body, wLI(wR('a'), 0, 1, 720) + wLI(wR('b'), 1, 2, 1440) + wLI(wR('c'), 2, 3, 2160));
    assert.ok(r.numbering.includes(abstractNum(0, true)), r.numbering);
    for (let i = 0; i < 3; i++) {
      assert.ok(r.numbering.includes('<w:num w:numId="' + (i + 1) + '"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="' + i + '">'
        + '<w:startOverride w:val="1"/></w:lvlOverride></w:num>'), r.numbering);
    }
  });

  it('два списка в одном значении — разные numId; ul и ol — свои abstractNum', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}')], { h: '<ol><li>a</li></ol><p>x</p><ol><li>b</li></ol><ul><li>c</li></ul>' });
    assert.strictEqual(r.body, wLI(wR('a'), 0, 1, 720) + wP(wR('x')) + wLI(wR('b'), 0, 2, 720) + wLI(wR('c'), 0, 3, 720));
    assert.ok(r.numbering.includes(abstractNum(0, true) + abstractNum(1, false)), r.numbering);
    assert.ok(r.numbering.includes('<w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>'), r.numbering);
  });

  it('шаблон без numbering.xml — часть, связь и тип создаются', async function () {
    const r = await renderParts([mp('{d.h:html}')], { h: '<ul><li>a</li></ul>' });
    assert.ok(r.numbering !== null);
    assert.ok(/<Relationship Id="[^"]+" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/numbering" Target="numbering\.xml"\/>/.test(r.rels), r.rels);
    assert.ok(r.ct.includes('<Override PartName="/word/numbering.xml" ContentType="' + NUM_CT + '"/>'), r.ct);
  });

  it('шаблон с numbering.xml — определения дописываются после существующих, номера выше максимума', async function () {
    const existing = '<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"/></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num>'
      + '<w:numIdMacAtCleanup w:val="2"/>';
    const r = await renderParts([mp('{d.h:html}')], { h: '<ul><li>a</li></ul>' }, {
      rels: '<Relationship Id="rId9" Type="' + NUM_REL + '" Target="numbering.xml"/>',
      files: { 'word/numbering.xml': NUMBERING(existing) }
    });
    assert.strictEqual(r.body, wLI(wR('a'), 0, 8, 720) + wSP());
    // пролог существующей части Carbone нормализует (перенос строки → пробел) — сравнивается корень
    assert.strictEqual(r.numbering.slice(r.numbering.indexOf('<w:numbering')), NUMBERING('<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"/></w:abstractNum>' + abstractNum(4, false)
      + '<w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num><w:num w:numId="8"><w:abstractNumId w:val="4"/></w:num><w:numIdMacAtCleanup w:val="2"/>').slice(XML_HEAD.length));
    assert.strictEqual((r.rels.match(/relationships\/numbering"/g) || []).length, 1, r.rels);
  });

  it('numbering.xml без w:num, но с w:numIdMacAtCleanup — порядок по схеме', async function () {
    const r = await renderParts([mp('{d.h:html}')], { h: '<ul><li>a</li></ul><ol><li>b</li></ol>' }, {
      rels: '<Relationship Id="rId9" Type="' + NUM_REL + '" Target="numbering.xml"/>',
      files: { 'word/numbering.xml': NUMBERING('<w:numIdMacAtCleanup w:val="2"/>') }
    });
    assert.strictEqual(r.numbering.slice(r.numbering.indexOf('<w:numbering')), NUMBERING(abstractNum(0, false) + abstractNum(1, true)
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/>'
      + '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num><w:numIdMacAtCleanup w:val="2"/>').slice(XML_HEAD.length));
  });

  it('связь numbering.xml с другим путём — пишется в него', async function () {
    const r = await renderParts([mp('{d.h:html}')], { h: '<ul><li>a</li></ul>' }, {
      rels: '<Relationship Id="rId9" Type="' + NUM_REL + '" Target="/word/num2.xml"/>',
      files: { 'word/num2.xml': NUMBERING('') }
    });
    assert.strictEqual(r.numbering, null);
    assert.strictEqual(r.body, wLI(wR('a'), 0, 1, 720) + wSP());
  });

  it('колонтитул и тело — общий numbering.xml, номера не повторяются', async function () {
    const header = XML_HEAD + '<w:hdr ' + W_NS + '>' + mp('{d.h:html(nospace)}') + '</w:hdr>';
    const r = await renderParts([mp('{d.h:html(nospace)}')], { h: '<ul><li>a</li></ul>' }, { files: { 'word/header1.xml': header } });
    const ids = [r.body, r.header].map((x) => /<w:numId w:val="(\d+)"\/>/.exec(x)[1]);
    assert.notStrictEqual(ids[0], ids[1]);
    assert.strictEqual((r.numbering.match(/<w:num /g) || []).length, 2);
    assert.strictEqual((r.numbering.match(/<w:abstractNum /g) || []).length, 1);
  });

  it('вложенные блоки пункта — абзацы с отступом пункта без номера', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}')], { h: '<ul><li><p>a</p><p>b</p><pre>c</pre></li></ul>' });
    assert.strictEqual(r.body, wLI(wR('a'), 0, 1, 720) + wP(wR('b'), ind(720)) + wP(wR('c', COURIER), ind(720)));
  });

  it('пункт со списком первым — пустой пункт с номером, затем вложенный список', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}')], { h: '<ul><ul><li>a</li></ul></ul>' });
    assert.strictEqual(r.body, wP('', numPr(0, 1) + ind(720, 360)) + wLI(wR('a'), 1, 2, 1440));
  });

  it('R7: пункты и заголовки берут у метки только jc, bidi, ind, spacing', async function () {
    const markerPPr = '<w:pStyle w:val="Body"/>' + numPr(0, 42) + '<w:bidi/><w:spacing w:after="80"/><w:ind w:left="100" w:firstLine="200"/>' + JC;
    const r = await renderParts([mp('{d.h:html(nospace)}', markerPPr)], { h: '<ul><li>a</li></ul><h2>b</h2><p>c</p>' });
    assert.strictEqual(r.body,
      wP(wR('a'), numPr(0, 1) + '<w:bidi/><w:spacing w:after="80"/><w:ind w:left="820" w:hanging="360"/>' + JC)
      + wP(wR('b'), '<w:pStyle w:val="Heading2"/><w:bidi/><w:spacing w:after="80"/><w:ind w:left="100" w:firstLine="200"/>' + JC)
      + wP(wR('c'), markerPPr));
  });

  it('Review Focus 3: список в ячейке цикла — свой numId в каждой строке, ячейка заканчивается w:p', async function () {
    const tpl = await buildDocx('| {d.rows[i].h:html} |\n| {d.rows[i+1].h:html} |');
    const rows = [1, 2, 3].map((n) => ({ h: '<p>r' + n + '</p><ol><li>a' + n + '</li><li>b' + n + '</li></ol>' }));
    const out = await carbone.renderBuffer(tpl, 'docx', { rows }, {});
    const xml = await readEntry(out, 'word/document.xml');
    assertWellFormed(xml);
    const cells = xml.match(/<w:tc>[\s\S]*?<\/w:tc>/g);
    assert.strictEqual(cells.length, 3);
    const ids = cells.map((c, i) => {
      assert.ok(c.endsWith('</w:p></w:tc>') || c.endsWith('<w:p/></w:tc>'), c);
      const found = [...new Set([...c.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]))];
      assert.strictEqual(found.length, 1, c);
      assert.ok(c.includes(wR('b' + (i + 1))), c);
      return found[0];
    });
    assert.strictEqual(new Set(ids).size, 3);
    const numbering = await readEntry(out, 'word/numbering.xml');
    for (const id of ids) {
      assert.ok(numbering.includes('<w:num w:numId="' + id + '"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>'), numbering);
    }
  });
});

describe('html: DOCX — заголовки', function () {
  it('h1–h6 без styles.xml: стили создаются (жирный, кегль, outlineLvl), часть, связь и тип', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}')], { h: '<h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6>' });
    const sizes = [40, 32, 28, 26, 24, 22];
    assert.strictEqual(r.body, sizes.map((s, i) => wP(wR(String(i + 1)), '<w:pStyle w:val="Heading' + (i + 1) + '"/>')).join(''));
    sizes.forEach((s, i) => {
      assert.ok(r.styles.includes('<w:style w:type="paragraph" w:styleId="Heading' + (i + 1) + '"><w:name w:val="heading ' + (i + 1) + '"/>'
        + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="' + i + '"/></w:pPr>'
        + '<w:rPr><w:b/><w:bCs/><w:sz w:val="' + s + '"/><w:szCs w:val="' + s + '"/></w:rPr></w:style>'), r.styles);
    });
    assert.ok(new RegExp('<Relationship Id="[^"]+" Type="' + STY_REL.replace(/[./]/g, '\\$&') + '" Target="styles\\.xml"/>').test(r.rels), r.rels);
    assert.ok(r.ct.includes('<Override PartName="/word/styles.xml" ContentType="' + STY_CT + '"/>'), r.ct);
  });

  it('стили шаблона используются, недостающие дописываются; русский Word — styleId по имени «heading N»', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}')], { h: '<h1>a</h1><h2>b</h2><h3>c</h3>' }, {
      rels: '<Relationship Id="rId2" Type="' + STY_REL + '" Target="styles.xml"/>',
      files: { 'word/styles.xml': STYLES(styleP('Heading1', 'heading 1') + styleP('2', 'heading 2')) }
    });
    assert.strictEqual(r.body, wP(wR('a'), '<w:pStyle w:val="Heading1"/>') + wP(wR('b'), '<w:pStyle w:val="2"/>') + wP(wR('c'), '<w:pStyle w:val="Heading3"/>'));
    assert.strictEqual((r.styles.match(/<w:style /g) || []).length, 3);
    assert.ok(r.styles.endsWith('</w:style></w:styles>'), r.styles);
    assert.ok(r.styles.includes('w:styleId="Heading3"'), r.styles);
    assert.strictEqual((r.rels.match(/relationships\/styles"/g) || []).length, 1, r.rels);
  });

  it('headingtheme:custom- — стили custom-1…, создаются при отсутствии', async function () {
    const r = await renderParts([mp('{d.h:html(nospace, headingtheme:custom-)}')], { h: '<h1>a</h1><h4>b</h4>' }, {
      rels: '<Relationship Id="rId2" Type="' + STY_REL + '" Target="styles.xml"/>',
      files: { 'word/styles.xml': STYLES(styleP('custom-1', 'custom-1') + styleP('Heading4', 'heading 4')) }
    });
    assert.strictEqual(r.body, wP(wR('a'), '<w:pStyle w:val="custom-1"/>') + wP(wR('b'), '<w:pStyle w:val="custom-4"/>'));
    assert.ok(r.styles.includes('<w:style w:type="paragraph" w:styleId="custom-4"><w:name w:val="custom-4"/><w:basedOn w:val="Normal"/>'), r.styles);
    assert.ok(r.styles.includes('<w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="26"/>'), r.styles);
  });

  it('заголовок в li — оформление заголовка в пункте, без стиля', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}', null, SZ)], { h: '<ul><li><h1>a</h1><h3>b</h3></li></ul>' });
    assert.strictEqual(r.body, wLI(wR('a', '<w:b/>' + SZ), 0, 1, 720) + wP(wR('b', '<w:b/>' + SZ), ind(720)));
    assert.strictEqual(r.styles, null);
    const r2 = await renderParts([mp('{d.h:html(nospace)}')], { h: '<ol><li><h2>a</h2></li></ol>' });
    assert.strictEqual(r2.body, wLI(wR('a', '<w:b/><w:sz w:val="32"/>'), 0, 1, 720));
  });
});

describe('html: DOCX — цитаты, pre, hr, разрывы', function () {
  it('blockquote: 600 twips на уровень, вложенный — 1200; список в цитате — отступ цитаты плюс уровень', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}')], { h: '<blockquote>a<blockquote>b</blockquote></blockquote><blockquote><ul><li>c</li></ul></blockquote>' });
    assert.strictEqual(r.body, wP(wR('a'), ind(600)) + wP(wR('b'), ind(1200)) + wLI(wR('c'), 0, 1, 1320));
  });

  it('blockquote: отступ прибавляется к отступу метки', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}', '<w:ind w:left="100" w:right="50"/>')], { h: '<blockquote>a</blockquote>' });
    assert.strictEqual(r.body, wP(wR('a'), '<w:ind w:left="700" w:right="50"/>'));
  });

  it('quotetheme:Quote — стиль вместо отступа, создаётся при отсутствии', async function () {
    const r = await renderParts([mp('{d.h:html(nospace, quotetheme:Quote)}')], { h: '<blockquote>a<blockquote>b</blockquote></blockquote><p>c</p>' }, {
      rels: '<Relationship Id="rId2" Type="' + STY_REL + '" Target="styles.xml"/>',
      files: { 'word/styles.xml': STYLES(styleP('Quote', 'Quote')) }
    });
    assert.strictEqual(r.body, wP(wR('a'), '<w:pStyle w:val="Quote"/>') + wP(wR('b'), '<w:pStyle w:val="Quote"/>') + wP(wR('c')));
    assert.strictEqual((r.styles.match(/<w:style /g) || []).length, 1);
    const r2 = await renderParts([mp('{d.h:html(nospace, quotetheme:Cite)}')], { h: '<blockquote>a</blockquote>' });
    assert.ok(r2.styles.includes('<w:style w:type="paragraph" w:styleId="Cite"><w:name w:val="Cite"/><w:basedOn w:val="Normal"/><w:qFormat/>'
      + '<w:pPr><w:ind w:left="600"/></w:pPr></w:style>'), r2.styles);
  });

  it('pre: пробелы и переносы сохраняются, Courier New', async function () {
    const r = await renderParts([mp('{d.h:html}')], { h: '<pre>  a  b\n\n c </pre>' });
    assert.strictEqual(r.body, wP(wR('  a  b', COURIER) + wBR() + wBR() + wR(' c ', COURIER)) + wSP());
  });

  it('hr — пустой абзац с нижней линией и отступами 120, без пустого абзаца после', async function () {
    const r = await renderParts([mp('{d.h:html}', '<w:spacing w:after="80"/>' + JC)], { h: '<p>a</p><hr><blockquote><hr></blockquote>' });
    const HR = '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr><w:spacing w:before="120" w:after="120"/>';
    const sp = '<w:spacing w:after="80"/>' + JC;
    assert.strictEqual(r.body, wP(wR('a'), sp) + wSP(sp) + wSP(HR + JC) + wSP(HR + ind(600) + JC));
  });

  it('break-before/break-after у заголовка, списка и hr', async function () {
    const PB = '<w:r><w:br w:type="page"/></w:r>';
    const r = await renderParts([mp('{d.h:html(nospace)}')], {
      h: '<h1 style="break-before:page">a</h1><ul style="break-before:page;break-after:page"><li>b</li></ul><hr style="break-before:page">'
    });
    const HR = '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr><w:spacing w:before="120" w:after="120"/>';
    assert.strictEqual(r.body, wP(PB + wR('a'), '<w:pStyle w:val="Heading1"/>')
      + wP(wR('b'), '<w:pageBreakBefore/>' + numPr(0, 1) + ind(720, 360)) + wP(PB)
      + wP(PB, HR));
  });
});

describe('html: DOCX — флажки', function () {
  it('отмеченный и нет — w14:checkbox, w14 объявляется на корне части', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}', null, SZ)], { h: '<p><input type="checkbox" checked> да <input type="checkbox"> нет</p>' });
    assert.strictEqual(r.body, wP(BOX(true, SZ) + wR(' да ', SZ) + BOX(false, SZ) + wR(' нет', SZ)));
    assert.ok(/<w:document [^>]*xmlns:w14="http:\/\/schemas\.microsoft\.com\/office\/word\/2010\/wordml"/.test(r.doc), r.doc.slice(0, 600));
  });

  it('w14 уже объявлен — второй раз не добавляется', async function () {
    const header = XML_HEAD + '<w:hdr ' + W_NS + ' ' + W14_NS + '>' + mp('{d.h:html(nospace)}') + '</w:hdr>';
    const r = await renderParts([mp('x')], { h: '<input type="checkbox">' }, { files: { 'word/header1.xml': header } });
    assert.strictEqual((r.header.match(/xmlns:w14=/g) || []).length, 1, r.header);
    assert.ok(r.header.includes(BOX(false)), r.header);
    assert.ok(!r.doc.includes('xmlns:w14'), 'тело без флажков не меняется');
  });

  it('флажок в пункте списка — без номера, отступ уровня, флажок первым', async function () {
    const r = await renderParts([mp('{d.h:html(nospace)}')], { h: '<ul><li><input type="checkbox" checked>a</li><li>b<ul><li><input type="checkbox">c</li></ul></li></ul>' });
    assert.strictEqual(r.body, wP(BOX(true) + wR(' ') + wR('a'), ind(720)) + wLI(wR('b'), 0, 1, 720)
      + wP(BOX(false) + wR(' ') + wR('c'), ind(1440)));
  });
});

describe('html: DOCX — части и производительность (Task 5)', function () {
  it('без списков и заголовков numbering.xml и styles.xml не создаются', async function () {
    const r = await renderParts([mp('{d.h:html}')], { h: '<p>a</p><blockquote>b</blockquote><hr><pre>c</pre>' });
    assert.strictEqual(r.numbering, null);
    assert.strictEqual(r.styles, null);
    assert.ok(!r.rels.includes('numbering') && !r.rels.includes('styles'), r.rels);
  });

  it('3000 строк таблицы со списком и заголовком — линейно', async function () {
    this.timeout(30000);
    const rows = Array.from({ length: 3000 }, (v, i) => ({ h: '<h2>' + i + '</h2><ol><li>a</li><li>b<ul><li>c</li></ul></li></ol>' }));
    const tpl = await buildDocx('| {d.rows[i].h:html(nospace)} |\n| {d.rows[i+1].h:html(nospace)} |');
    const start = Date.now();
    const out = await carbone.renderBuffer(tpl, 'docx', { rows }, {});
    const ms = Date.now() - start;
    const numbering = await readEntry(out, 'word/numbering.xml');
    assert.strictEqual((numbering.match(/<w:num /g) || []).length, 6000);
    assert.strictEqual((numbering.match(/<w:abstractNum /g) || []).length, 2);
    assert.ok(ms < 3000, 'сборка ' + ms + ' мс');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// :html в DOCX (Task 6): таблицы, ссылки, изображения

const http = require('http');
const zlib = require('zlib');
const { renderBufferWithWarnings } = carbone;

const HYPERLINK_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const DOC_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

// ожидаемая таблица
const TBL_LOOK = '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>';
const tblPr = (style, more) => '<w:tblPr><w:tblStyle w:val="' + style + '"/><w:tblW w:w="5000" w:type="pct"/>' + (more || '') + TBL_LOOK + '</w:tblPr>';
const grid = (n, w) => '<w:tblGrid>' + ('<w:gridCol w:w="' + w + '"/>').repeat(n) + '</w:tblGrid>';
const tc = (inner, w, o) => '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (o && o.span ? '<w:gridSpan w:val="' + o.span + '"/>' : '')
  + (o && o.merge ? (o.merge === 'restart' ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>') : '') + '</w:tcPr>' + inner + '</w:tc>';
const tr = (cells) => '<w:tr>' + cells.join('') + '</w:tr>';
const TABLE_GRID = '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>'
  + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="000000"/>').join('')
  + '</w:tblBorders></w:tblPr></w:style>';
const LINK_RPR = '<w:color w:val="0563C1"/><w:u w:val="single"/>';

/** Настоящий PNG w×h (RGB); seed меняет пиксель */
function pngChunk (type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png (w, h, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  raw[1] = seed || 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
/** PNG-заголовок с «хвостом» до size байт */
function bigPng (size, seed) {
  const buf = Buffer.alloc(size);
  png(1, 1, seed).copy(buf);
  buf[size - 1] = seed || 0;
  return buf;
}
const dataUri = (buf) => 'data:image/png;base64,' + buf.toString('base64');

/** DOCX со своим w:body (sectPr — как задан) */
function rawDocx (bodyXml, opts) {
  const o = opts || {};
  const extra = Object.entries(o.files || {}).map(([name, data]) => ({ name, data }));
  return zipBuffer([
    { name: '[Content_Types].xml', data: XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + (o.rels || '') + '</Relationships>' },
    { name: 'word/document.xml', data: XML_HEAD + '<w:document ' + (o.ns || DOC_NS) + '><w:body>' + bodyXml + '</w:body></w:document>' },
    ...extra
  ]);
}

async function renderOut (tpl, data, options) {
  const res = await renderBufferWithWarnings(tpl, 'docx', data, options || {});
  const get = (name) => readEntry(res.buffer, name).catch(() => null);
  const r = {
    out: res.buffer,
    warnings: res.warnings,
    doc: await get('word/document.xml'),
    rels: await get('word/_rels/document.xml.rels'),
    styles: await get('word/styles.xml'),
    ct: await get('[Content_Types].xml')
  };
  for (const k of ['doc', 'rels', 'styles', 'ct']) {
    if (r[k] !== null) assertWellFormed(r[k]);
  }
  r.body = r.doc.slice(r.doc.indexOf('<w:body>') + 8, r.doc.lastIndexOf('</w:body>'));
  return r;
}

/** Рендер одной метки в шаблоне buildDocx; body — без хвоста buildDocx */
async function renderHtml (html, marker, options, opts) {
  const o = opts || {};
  const tpl = await buildDocx('<<RAW>>', [mp(marker || '{d.h:html}')], o.rels || '', o.files);
  const r = await renderOut(tpl, { h: html }, options);
  r.body = r.body.slice(0, r.body.lastIndexOf(BODY_END.replace('</w:body>', '')));
  return r;
}

/** Target связи Id в rels */
function relOf (rels, id) {
  const m = new RegExp('<Relationship [^>]*Id="' + id + '"[^>]*/>').exec(rels);
  assert.ok(m, 'нет связи ' + id + ' в ' + rels);
  return m[0];
}

describe('html: DOCX — таблицы', function () {
  it('th, colspan, rowspan: сетка, gridSpan, vMerge, пустой w:p в объединённых ячейках; TableGrid создаётся', async function () {
    const r = await renderHtml('<table><tr><th>A</th><th colspan="2">B</th></tr><tr><td rowspan="2">c</td><td>d</td><td>e</td></tr>'
      + '<tr><td>f</td><td>g</td></tr></table>');
    const w = 3212;
    assert.strictEqual(r.body, '<w:tbl>' + tblPr('TableGrid') + grid(3, w)
      + tr([tc(wP(wR('A', '<w:b/>')), w), tc(wP(wR('B', '<w:b/>')), w * 2, { span: 2 })])
      + tr([tc(wP(wR('c')), w, { merge: 'restart' }), tc(wP(wR('d')), w), tc(wP(wR('e')), w)])
      + tr([tc('<w:p/>', w, { merge: 'cont' }), tc(wP(wR('f')), w), tc(wP(wR('g')), w)])
      + '</w:tbl>' + wSP());
    assert.ok(r.styles.includes(TABLE_GRID), r.styles);
  });

  it('tabletheme:GridTable2 — стиль создаётся при отсутствии; есть в шаблоне — используется без копии', async function () {
    let r = await renderHtml('<table><tr><td>a</td></tr></table>', '{d.h:html(tabletheme:GridTable2)}');
    assert.ok(r.body.startsWith('<w:tbl>' + tblPr('GridTable2')), r.body);
    assert.ok(r.styles.includes('<w:style w:type="table" w:styleId="GridTable2"><w:name w:val="GridTable2"/>'), r.styles);
    const style = '<w:style w:type="table" w:styleId="GridTable2"><w:name w:val="Grid Table 2"/></w:style>';
    r = await renderHtml('<table><tr><td>a</td></tr></table>', '{d.h:html(tabletheme:GridTable2)}', {}, {
      rels: '<Relationship Id="rId2" Type="' + STY_REL + '" Target="styles.xml"/>', files: { 'word/styles.xml': STYLES(style) }
    });
    assert.ok(r.body.startsWith('<w:tbl>' + tblPr('GridTable2')), r.body);
    assert.strictEqual((r.styles.match(/<w:style /g) || []).length, 1, r.styles);
  });

  it('стиль таблиц по умолчанию документа (w:default) важнее TableGrid', async function () {
    const style = '<w:style w:type="table" w:default="1" w:styleId="MyTable"><w:name w:val="My Table"/></w:style>';
    const r = await renderHtml('<table><tr><td>a</td></tr></table>', null, {}, {
      rels: '<Relationship Id="rId2" Type="' + STY_REL + '" Target="styles.xml"/>', files: { 'word/styles.xml': STYLES(style) }
    });
    assert.ok(r.body.startsWith('<w:tbl>' + tblPr('MyTable')), r.body);
    assert.ok(!r.styles.includes('TableGrid'), r.styles);
  });

  it('стиль по умолчанию «Normal Table» (любой styleId, без учёта регистра) — не берётся, TableGrid', async function () {
    for (const style of ['<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>',
      '<w:style w:type="table" w:default="1" w:styleId="a1"><w:name w:val="normal table"/></w:style>']) {
      const r = await renderHtml('<table><tr><td>a</td></tr></table>', null, {}, {
        rels: '<Relationship Id="rId2" Type="' + STY_REL + '" Target="styles.xml"/>', files: { 'word/styles.xml': STYLES(style) }
      });
      assert.ok(r.body.startsWith('<w:tbl>' + tblPr('TableGrid')), r.body);
      assert.ok(r.styles.includes(TABLE_GRID), r.styles);
    }
  });

  it('ширина столбцов — по w:pgSz и w:pgMar последнего w:sectPr документа', async function () {
    const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"/></w:sectPr>';
    const first = '<w:p><w:pPr><w:sectPr><w:pgSz w:w="20000"/><w:pgMar w:left="0" w:right="0"/></w:sectPr></w:pPr></w:p>';
    const r = await renderOut(await rawDocx(first + mp('{d.h:html(nospace)}') + sect), { h: '<table><tr><td>a</td><td colspan="2">b</td></tr></table>' });
    const w = Math.floor((11906 - 1701 - 850) / 3);
    assert.ok(r.body.includes(grid(3, w) + tr([tc(wP(wR('a')), w), tc(wP(wR('b')), w * 2, { span: 2 })])), r.body);
  });

  it('thead/tbody/tfoot — строки по порядку, caption — абзацем перед таблицей', async function () {
    const r = await renderHtml('<table><caption>Подпись</caption><thead><tr><th>h</th></tr></thead><tbody><tr><td>b</td></tr></tbody>'
      + '<tfoot><tr><td>f</td></tr></tfoot></table>', null, {}, {});
    const w = 9638;
    assert.strictEqual(r.body, wP(wR('Подпись')) + '<w:tbl>' + tblPr('TableGrid') + grid(1, w)
      + tr([tc(wP(wR('h', '<w:b/>')), w)]) + tr([tc(wP(wR('b')), w)]) + tr([tc(wP(wR('f')), w)]) + '</w:tbl>' + wSP());
  });

  it('неровные строки дополняются пустой ячейкой; rowspan за последнюю строку обрезается; пустая ячейка — w:p', async function () {
    const r = await renderHtml('<table><tr><td>a</td><td rowspan="9">b</td><td>c</td></tr><tr><td></td></tr></table>', '{d.h:html(nospace)}');
    const w = 3212;
    assert.strictEqual(r.body, '<w:tbl>' + tblPr('TableGrid') + grid(3, w)
      + tr([tc(wP(wR('a')), w), tc(wP(wR('b')), w, { merge: 'restart' }), tc(wP(wR('c')), w)])
      + tr([tc('<w:p/>', w), tc('<w:p/>', w, { merge: 'cont' }), tc('<w:p/>', w)])
      + '</w:tbl>' + '<w:p/>');
  });

  it('больше 63 столбцов: сетка 63, содержимое лишних ячеек — в последнюю ячейку строки', async function () {
    const cells = Array.from({ length: 70 }, (v, i) => '<td>c' + i + '</td>').join('');
    const r = await renderHtml('<table><tr>' + cells + '</tr><tr><td colspan="1000">x</td></tr></table>', '{d.h:html(nospace)}');
    const w = Math.floor(9638 / 63);
    assert.strictEqual((r.body.match(/<w:gridCol /g) || []).length, 63);
    const rows = r.body.match(/<w:tr>[\s\S]*?<\/w:tr>/g);
    assert.strictEqual((rows[0].match(/<w:tc>/g) || []).length, 63);
    const last = [62, 63, 64, 65, 66, 67, 68, 69].map((i) => wP(wR('c' + i))).join('');
    assert.ok(rows[0].endsWith(tc(last, w) + '</w:tr>'), rows[0]);
    assert.ok(rows[1].includes(tc(wP(wR('x')), w * 63, { span: 63 })), rows[1]);
  });

  it('вложенная таблица и таблица в ячейке шаблона — ячейка заканчивается w:p', async function () {
    const tpl = await buildDocx('| {d.h:html(nospace)} |');
    const r = await renderOut(tpl, { h: '<table><tr><td>a<table><tr><td>b</td></tr></table></td></tr></table>' });
    const cells = r.body.match(/<w:tc>(?:(?!<w:tc>)[\s\S])*?<\/w:tc>/g);
    for (const c of cells) assert.ok(c.endsWith('</w:p></w:tc>') || c.endsWith('<w:p/></w:tc>'), c);
    assert.strictEqual((r.body.match(/<w:tbl>/g) || []).length, 3);
    assert.ok(r.body.includes('</w:tbl><w:p/></w:tc>'), r.body);
  });

  it('список в ячейке внутри пункта — с уровня 0; заголовок в ячейке — стиль заголовка', async function () {
    const r = await renderHtml('<ul><li>x<table><tr><td><ul><li>a</li></ul><h2>h</h2></td></tr></table></li></ul>', '{d.h:html(nospace)}');
    assert.ok(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="2"\/><\/w:numPr><w:ind w:left="720" w:hanging="360"\/><\/w:pPr><w:r><w:t xml:space="preserve">a</.test(r.body), r.body);
    assert.ok(r.body.includes(wP(wR('h'), '<w:pStyle w:val="Heading2"/>')), r.body);
    // таблица в пункте — с отступом пункта
    assert.ok(r.body.includes(tblPr('TableGrid', '<w:tblInd w:w="720" w:type="dxa"/>')), r.body);
  });

  it('таблица в цитате — отступ цитаты; разрыв страницы до таблицы — отдельным абзацем перед ней', async function () {
    const r = await renderHtml('<blockquote><table style="break-before: page"><tr><td>a</td></tr></table></blockquote>', '{d.h:html(nospace)}');
    assert.ok(r.body.startsWith(wP('<w:r><w:br w:type="page"/></w:r>') + '<w:tbl>' + tblPr('TableGrid', '<w:tblInd w:w="600" w:type="dxa"/>')), r.body);
  });

  it('Review Focus 3: в ячейке цикла список и таблица — свой numId, каждая ячейка заканчивается w:p', async function () {
    const tpl = await buildDocx('| {d.rows[i].h:html} |\n| {d.rows[i+1].h:html} |');
    const rows = [1, 2, 3].map((n) => ({ h: '<ol><li>a' + n + '</li></ol><table><tr><td>t' + n + '</td><td><ul><li>u' + n + '</li></ul></td></tr></table>' }));
    const r = await renderOut(tpl, { rows });
    const outer = r.body.match(/<w:tr>[\s\S]*?<\/w:tbl>[\s\S]*?<\/w:tr>/g);
    assert.strictEqual(outer.length, 3);
    const ids = new Set();
    outer.forEach((row, i) => {
      assert.ok(row.endsWith('</w:p></w:tc></w:tr>') || row.endsWith('<w:p/></w:tc></w:tr>'), row);
      assert.ok(row.includes(wR('t' + (i + 1))) && row.includes(wR('u' + (i + 1))), row);
      const found = [...new Set([...row.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]))];
      assert.strictEqual(found.length, 2, row);
      found.forEach((id) => ids.add(id));
      // список во вложенной ячейке — с уровня 0
      assert.ok(!row.includes('<w:ilvl w:val="1"/>'), row);
    });
    assert.strictEqual(ids.size, 6);
    for (const c of r.body.match(/<w:tc>(?:(?!<w:tc>)[\s\S])*?<\/w:tc>/g)) assert.ok(/(?:<\/w:p>|<w:p\/>)<\/w:tc>$/.test(c), c);
  });

  it('5000 ячеек в 1000 строках — линейно', async function () {
    this.timeout(20000);
    const rows = Array.from({ length: 1000 }, (v, i) => '<tr><td rowspan="2">' + i + '</td><td>a</td><td>b</td><td>c</td><td>d</td></tr>').join('');
    const start = Date.now();
    const r = await renderHtml('<table>' + rows + '</table>');
    assert.ok(Date.now() - start < 3000, (Date.now() - start) + ' мс');
    assert.strictEqual((r.body.match(/<w:tr>/g) || []).length, 1000);
  });
});

describe('html: DOCX — ссылки', function () {
  const link = (id, inner) => '<w:hyperlink r:id="' + id + '">' + inner + '</w:hyperlink>';

  it('допустимая ссылка — w:hyperlink со связью External, оформление цветом и подчёркиванием', async function () {
    const r = await renderHtml('<p>см. <a href="https://site.ru/a?b=1&amp;c=2"><b>тут</b></a></p>');
    const m = /<w:hyperlink r:id="([^"]+)">/.exec(r.body);
    assert.ok(m, r.body);
    assert.strictEqual(r.body, wP(wR('см. ') + link(m[1], wR('тут', '<w:b/>' + LINK_RPR))) + wSP());
    assert.strictEqual(relOf(r.rels, m[1]), '<Relationship Id="' + m[1] + '" Type="' + HYPERLINK_REL + '" Target="https://site.ru/a?b=1&amp;c=2" TargetMode="External"/>');
  });

  it('адрес без схемы — https://; javascript:, пустой и якорь — #; одинаковые адреса — одна связь', async function () {
    const r = await renderHtml('<a href="site.ru">a</a><a href="javascript:alert(1)">b</a><a href="">c</a><a href="#x">d</a><a href="site.ru">e</a>');
    const ids = [...r.body.matchAll(/<w:hyperlink r:id="([^"]+)">/g)].map((m) => m[1]);
    assert.strictEqual(ids.length, 5);
    assert.ok(relOf(r.rels, ids[0]).includes('Target="https://site.ru"'), r.rels);
    for (const id of ids.slice(1, 4)) assert.ok(relOf(r.rels, id).includes('Target="#" TargetMode="External"'), r.rels);
    assert.strictEqual(ids[4], ids[0]);
    assert.strictEqual(ids[1], ids[2]);
    assert.ok(!r.body.includes('w:anchor'), r.body);
  });

  it('defaultURL(\'https://site.ru\') — запасной адрес недопустимых ссылок (R4); недопустимый запасной — #', async function () {
    let r = await renderHtml('<a href="javascript:x">a</a><a href="https://ok.ru">b</a>', '{d.h:defaultURL(\'https://site.ru\'):html}');
    let ids = [...r.body.matchAll(/<w:hyperlink r:id="([^"]+)">/g)].map((m) => m[1]);
    assert.ok(relOf(r.rels, ids[0]).includes('Target="https://site.ru"'), r.rels);
    assert.ok(relOf(r.rels, ids[1]).includes('Target="https://ok.ru"'), r.rels);
    r = await renderHtml('<a href="javascript:x">a</a>', '{d.h:defaultURL(\'javascript:y\'):html}');
    ids = [...r.body.matchAll(/<w:hyperlink r:id="([^"]+)">/g)].map((m) => m[1]);
    assert.ok(relOf(r.rels, ids[0]).includes('Target="#"'), r.rels);
  });

  it('стиль Hyperlink в styles.xml — w:rStyle вместо цвета; свойство метки побеждает', async function () {
    const style = '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/></w:style>';
    const r = await renderHtml('<a href="https://a.ru">x</a>', null, {}, {
      rels: '<Relationship Id="rId2" Type="' + STY_REL + '" Target="styles.xml"/>', files: { 'word/styles.xml': STYLES(style) }
    });
    assert.ok(r.body.includes(wR('x', '<w:rStyle w:val="Hyperlink"/>') + '</w:hyperlink>'), r.body);
    const r2 = await renderHtml('<a href="https://a.ru">x</a>', null, {}, {});
    assert.ok(r2.body.includes(wR('x', LINK_RPR)), r2.body);
    assert.strictEqual(r2.styles, null);
  });

  it('ссылка с флажком и переносом внутри; inline — w:hyperlink в абзаце метки', async function () {
    const r = await renderHtml('<a href="https://a.ru">x<br>y</a>', 'До {d.h:html(inline)}');
    assert.ok(/<w:hyperlink r:id="[^"]+">/.test(r.body), r.body);
    assert.strictEqual((r.body.match(/<w:p>/g) || []).length, 1, r.body);
  });

  it('inline внутри w:hyperlink шаблона — без вложенного w:hyperlink, текст ссылки с оформлением', async function () {
    const raw = '<w:p><w:hyperlink r:id="rIdT"><w:r><w:t>{d.h:html(inline)}</w:t></w:r></w:hyperlink></w:p>';
    const tpl = await buildDocx('<<RAW>>', [raw], '<Relationship Id="rIdT" Type="' + HYPERLINK_REL + '" Target="https://t.ru" TargetMode="External"/>');
    const r = await renderOut(tpl, { h: '<a href="https://a.ru"><b>x</b></a> y' });
    assert.strictEqual((r.body.match(/<w:hyperlink /g) || []).length, 1, r.body);
    assert.ok(r.body.includes('<w:hyperlink r:id="rIdT">' + wR('x', '<w:b/>') + wR(' y') + '</w:hyperlink>'), r.body);
    assert.ok(!r.rels.includes('https://a.ru'), r.rels);
  });
});

describe('html: DOCX — изображения', function () {
  const extent = (body) => [...body.matchAll(/<(wp:extent|a:ext) cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => m[1] + ' ' + m[2] + '×' + m[3]);

  it('data URI PNG 200×100 без размеров — ширина 5 см (1800000 EMU) с пропорциями; media-файл, связь, тип', async function () {
    const img = png(200, 100);
    const r = await renderHtml('<p>a<img src="' + dataUri(img) + '">b</p>');
    assert.deepStrictEqual(extent(r.body), ['wp:extent 1800000×900000', 'a:ext 1800000×900000']);
    const id = /<a:blip r:embed="([^"]+)"\/>/.exec(r.body)[1];
    const rel = relOf(r.rels, id);
    assert.ok(rel.includes('Type="' + IMAGE_REL + '"'), rel);
    const target = /Target="([^"]+)"/.exec(rel)[1];
    assert.match(target, /^media\/cr-img-\d+\.png$/);
    assert.ok(Buffer.from(await readEntry(r.out, 'word/' + target, true)).equals(img));
    assert.ok(r.ct.includes('<Default Extension="png" ContentType="image/png"/>'), r.ct);
    assert.ok(r.body.startsWith('<w:p>' + wR('a') + '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'), r.body);
  });

  it('width="300" — 2857500×1428750; height — ширина по пропорциям; оба — как заданы', async function () {
    const src = dataUri(png(200, 100));
    let r = await renderHtml('<img src="' + src + '" width="300">');
    assert.deepStrictEqual(extent(r.body), ['wp:extent 2857500×1428750', 'a:ext 2857500×1428750']);
    r = await renderHtml('<img src="' + src + '" height="50">');
    assert.deepStrictEqual(extent(r.body), ['wp:extent 952500×476250', 'a:ext 952500×476250']);
    r = await renderHtml('<img src="' + src + '" width="10" height="20">');
    assert.deepStrictEqual(extent(r.body), ['wp:extent 95250×190500', 'a:ext 95250×190500']);
  });

  it('размер: не больше 20116800 EMU по каждой стороне с пропорциями, не меньше 1 EMU', async function () {
    let r = await renderHtml('<img src="' + dataUri(png(200, 100)) + '" width="999999">');
    assert.deepStrictEqual(extent(r.body), ['wp:extent 20116800×10058400', 'a:ext 20116800×10058400']);
    r = await renderHtml('<img src="' + dataUri(png(200, 100)) + '" width="999999" height="5000000">');
    assert.deepStrictEqual(extent(r.body), ['wp:extent 4023356×20116800', 'a:ext 4023356×20116800']);
    r = await renderHtml('<img src="' + dataUri(png(1, 20000)) + '">');
    assert.deepStrictEqual(extent(r.body), ['wp:extent 1006×20116800', 'a:ext 1006×20116800']);
    r = await renderHtml('<img src="' + dataUri(png(20000, 1)) + '" width="1">');
    assert.deepStrictEqual(extent(r.body), ['wp:extent 9525×1', 'a:ext 9525×1']);
  });

  it('одинаковый src — один media-файл; wp:docPr и pic:cNvPr — уникальные id выше максимума части', async function () {
    const src = dataUri(png(2, 1));
    const pic = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="7" name="x"/></wp:inline></w:drawing></w:r></w:p>';
    const tpl = await buildDocx('<<RAW>>\n<<RAW>>', [pic, mp('{d.h:html}')]);
    const r = await renderOut(tpl, { h: '<img src="' + src + '"><img src="' + src + '">' });
    assert.deepStrictEqual([...r.body.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]), ['7', '8', '9']);
    assert.deepStrictEqual([...r.body.matchAll(/<pic:cNvPr id="(\d+)"/g)].map((m) => m[1]), ['8', '9']);
    const ids = [...r.body.matchAll(/<a:blip r:embed="([^"]+)"\/>/g)].map((m) => m[1]);
    assert.strictEqual(ids[0], ids[1]);
    const names = await require('./golden-lib').entryNames(r.out);
    assert.strictEqual(names.filter((n) => n.startsWith('word/media/')).length, 1);
  });

  it('изображение в ссылке; неверный data URI и SVG — пропуск с предупреждением', async function () {
    const r = await renderHtml('<a href="https://a.ru"><img src="' + dataUri(png(2, 1)) + '"></a><img src="data:image/png;base64,@@">'
      + '<img src="data:image/svg+xml;base64,PHN2Zz4=">x');
    assert.ok(/<w:hyperlink r:id="[^"]+"><w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:drawing>/.test(r.body), r.body);
    assert.strictEqual((r.body.match(/<w:drawing>/g) || []).length, 1);
    assert.deepStrictEqual(r.warnings, [
      'изображение не вставлено: неверный data URI изображения (ожидается data:image/png;base64,…) Метка: {d.h:html}',
      'изображение не вставлено: SVG не поддерживается (изображения: PNG, JPEG, GIF) Метка: {d.h:html}'
    ]);
  });

  it('100 млн пикселей — ошибка шаблона', async function () {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(10001, 0);
    ihdr.writeUInt32BE(10000, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const header = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr)]);
    assert.strictEqual(await rejection(renderHtml('<img src="' + dataUri(header) + '">')),
      'изображение больше 100 млн пикселей (ширина × высота) Source: "{d.h:html}"');
  });

  it('колонтитул: связь в word/_rels/header1.xml.rels', async function () {
    const header = XML_HEAD + '<w:hdr ' + W_NS + '>' + mp('{d.h:html}') + '</w:hdr>';
    const tpl = await buildDocx('<<RAW>>', [mp('тело')], '', { 'word/header1.xml': header });
    const r = await renderOut(tpl, { h: '<img src="' + dataUri(png(4, 2)) + '"><a href="https://a.ru">l</a>' });
    const xml = await readEntry(r.out, 'word/header1.xml');
    assertWellFormed(xml);
    const rels = await readEntry(r.out, 'word/_rels/header1.xml.rels');
    const id = /<a:blip r:embed="([^"]+)"\/>/.exec(xml)[1];
    assert.ok(relOf(rels, id).includes('Target="media/cr-img-'), rels);
    const lid = /<w:hyperlink r:id="([^"]+)">/.exec(xml)[1];
    assert.ok(relOf(rels, lid).includes('Target="https://a.ru"'), rels);
    // пространства имён r и wp объявлены на корне колонтитула
    assert.ok(/^<w:hdr [^>]*xmlns:r="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/.test(xml.slice(xml.indexOf('<w:hdr'))), xml);
    assert.ok(/^<w:hdr [^>]*xmlns:wp="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/wordprocessingDrawing"/.test(xml.slice(xml.indexOf('<w:hdr'))), xml);
    assert.ok(!r.rels.includes('cr-img'), r.rels);
  });

  describe('по адресу (локальный сервер)', function () {
    let server;
    let host;
    let base;
    before(async function () {
      server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname;
        if (p === '/ok.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(png(30, 10));
        }
        if (p === '/big11') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(bigPng(11 * 1024 * 1024, 1));
        }
        if (p.startsWith('/big/')) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(bigPng(9 * 1024 * 1024, Number(p.slice(5))));
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      host = '127.0.0.1:' + server.address().port;
      base = 'http://' + host;
    });
    after(function () {
      server.closeAllConnections();
      server.close();
    });

    it('URL из белого списка загружается', async function () {
      const r = await renderHtml('<img src="' + base + '/ok.png" width="30">', null, { imageUrlAllowlist: [host] });
      assert.deepStrictEqual(r.warnings, []);
      assert.deepStrictEqual(extent(r.body), ['wp:extent 285750×95250', 'a:ext 285750×95250']);
    });

    it('хост вне списка, загрузка выключена, 404 — пропуск и предупреждение', async function () {
      let r = await renderHtml('<p>a<img src="' + base + '/ok.png"></p>', null, { imageUrlAllowlist: ['example.org'] });
      assert.strictEqual(r.body, wP(wR('a')) + wSP());
      assert.deepStrictEqual(r.warnings, ['изображение не вставлено: хост «' + host + '» не входит в белый список IMAGE_URL_ALLOWLIST Метка: {d.h:html}']);
      r = await renderHtml('<img src="' + base + '/ok.png">x');
      assert.deepStrictEqual(r.warnings, ['изображение не вставлено: загрузка изображений по адресу выключена (IMAGE_URL_ALLOWLIST) Метка: {d.h:html}']);
      r = await renderHtml('<img src="' + base + '/none.png?k=1">x', null, { imageUrlAllowlist: [host] });
      assert.deepStrictEqual(r.warnings, ['изображение не загружено: ' + base + '/none.png — код ответа 404 Метка: {d.h:html}']);
    });

    it('11 МБ по адресу — ошибка шаблона', async function () {
      const msg = await rejection(renderHtml('<img src="' + base + '/big11">', null, { imageUrlAllowlist: [host] }));
      assert.strictEqual(msg, 'изображение больше 10 МБ (адрес ' + base + '/big11) Source: "{d.h:html}"');
    });

    it('общий лимит 50 МБ вместе с картинкой-заглушкой {d.img} — ошибка шаблона', async function () {
      this.timeout(20000);
      const pic = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="p" descr="{d.img}"/><a:graphic>'
        + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="p"/>'
        + '<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
      const tpl = await buildDocx('<<RAW>>\n<<RAW>>', [mp('{d.h:html}'), pic], '<Relationship Id="rIdImg" Type="' + IMAGE_REL + '" Target="media/p.png"/>', { 'word/media/p.png': png(1, 1) });
      const html = [1, 2, 3, 4, 5].map((n) => '<img src="' + base + '/big/' + n + '">').join('');
      const opts = { imageUrlAllowlist: [host] };
      // только :html (45 МБ) — можно
      const ok = await renderOut(tpl, { h: html, img: '' }, opts);
      assert.strictEqual((ok.body.match(/<w:drawing>/g) || []).length, 5);
      assert.strictEqual(await rejection(renderOut(tpl, { h: html, img: base + '/big/6' }, opts)),
        'изображения отчёта больше 50 МБ Source: "{d.img}"');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// :html в ODT (Task 7): абзацы, разметка, заголовки, цитаты, pre, hr, разрывы, флажки

const { buildOdt, ODF_NS } = require('./golden-lib');

const oA = (style) => (style ? ' text:style-name="' + style + '"' : '');
const oP = (inner, style) => '<text:p' + oA(style) + '>' + inner + '</text:p>';
const oSP = (style) => '<text:p' + oA(style) + '/>';
const oS = (style, inner) => '<text:span text:style-name="' + style + '">' + inner + '</text:span>';
const oH = (level, inner, style) => '<text:h text:style-name="' + (style || 'Heading_20_' + level) + '" text:outline-level="' + level + '">' + inner + '</text:h>';
const oLB = '<text:line-break/>';
const tStyle = (name, props) => '<style:style style:name="' + name + '" style:family="text"><style:text-properties ' + props + '/></style:style>';
const pStyle = (name, parent, props) => '<style:style style:name="' + name + '" style:family="paragraph"' + (parent ? ' style:parent-style-name="' + parent + '"' : '')
  + '><style:paragraph-properties ' + props + '/></style:style>';
const O_BOLD = 'fo:font-weight="bold"';
const O_ITALIC = 'fo:font-style="italic"';
const O_UNDER = 'style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"';
const O_STRIKE = 'style:text-line-through-style="solid"';
const O_MONO = 'style:font-name="Courier New"';
const O_HR = 'fo:border-bottom="0.5pt solid #000000" fo:margin-top="0.21cm" fo:margin-bottom="0.21cm"';
const O_COURIER = '<style:font-face style:name="Courier New" svg:font-family="\'Courier New\'" style:font-family-generic="modern" style:font-pitch="fixed"/>';
const O_STYLES = (o) => XML_HEAD + '<office:document-styles ' + ODF_NS + ' office:version="1.3">'
  + (o.styles !== undefined ? '<office:styles>' + o.styles + '</office:styles>' : '')
  + (o.automatic !== undefined ? '<office:automatic-styles>' + o.automatic + '</office:automatic-styles>' : '')
  + (o.master !== undefined ? '<office:master-styles>' + o.master + '</office:master-styles>' : '')
  + '</office:document-styles>';
const headingStyle = (name, level, size, display) => '<style:style style:name="' + name + '"' + (display ? ' style:display-name="' + display + '"' : '')
  + ' style:family="paragraph" style:default-outline-level="' + level + '"><style:text-properties fo:font-size="' + size + 'pt" fo:font-weight="bold"/></style:style>';

const between = (xml, a, b) => {
  const i = xml === null ? -1 : xml.indexOf(a);
  return i === -1 ? null : xml.slice(i + a.length, xml.indexOf(b, i + a.length));
};

// сборка ODT: opts { automatic, fonts — content.xml; styles — styles.xml целиком; options — опции рендера }
async function renderOdt (body, data, opts) {
  const o = opts || {};
  const tpl = await buildOdt(body, { automatic: o.automatic, fonts: o.fonts, files: o.styles !== undefined ? { 'styles.xml': o.styles } : {} });
  const out = await carbone.renderBuffer(tpl, 'odt', data, o.options || {});
  const content = await readEntry(out, 'content.xml');
  assertWellFormed(content);
  const styles = await readEntry(out, 'styles.xml').catch(() => null);
  if (styles !== null) assertWellFormed(styles);
  return {
    content,
    styles,
    manifest: await readEntry(out, 'META-INF/manifest.xml'),
    body: between(content, '<office:text>', '</office:text>'),
    auto: between(content, '<office:automatic-styles>', '</office:automatic-styles>'),
    fonts: between(content, '<office:font-face-decls>', '</office:font-face-decls>')
  };
}

async function odtBody (html, marker, opts) {
  return (await renderOdt(marker || oP('{d.h:html}'), { h: html }, opts)).body;
}

describe('html: ODT — разметка текста', function () {
  const one = [
    ['b', O_BOLD], ['strong', O_BOLD], ['i', O_ITALIC], ['em', O_ITALIC], ['u', O_UNDER], ['s', O_STRIKE], ['del', O_STRIKE],
    ['sup', 'style:text-position="super 58%"'], ['sub', 'style:text-position="sub 58%"'], ['mark', 'fo:background-color="#ffff00"'],
    ['code', O_MONO], ['kbd', O_MONO], ['samp', O_MONO]
  ];
  for (const [tag, props] of one) {
    it('<' + tag + '>', async function () {
      const r = await renderOdt(oP('{d.h:html}'), { h: '<' + tag + '>x</' + tag + '>' });
      assert.strictEqual(r.body, oP(oS('CRh1', 'x')) + oSP());
      assert.strictEqual(r.auto, tStyle('CRh1', props));
      assert.strictEqual(r.fonts, props === O_MONO ? O_COURIER : null);
    });
  }

  it('вложенные теги — один стиль со всеми свойствами', async function () {
    let r = await renderOdt(oP('{d.h:html}'), { h: '<u><s><i><b>x</b></i></s></u>' });
    assert.strictEqual(r.body, oP(oS('CRh1', 'x')) + oSP());
    assert.strictEqual(r.auto, tStyle('CRh1', O_BOLD + ' ' + O_ITALIC + ' ' + O_UNDER + ' ' + O_STRIKE));
    r = await renderOdt(oP('{d.h:html}'), { h: '<sup><mark><code>x</code></mark></sup>' });
    assert.strictEqual(r.auto, tStyle('CRh1', O_MONO + ' style:text-position="super 58%" fo:background-color="#ffff00"'));
  });

  it('color и background-color', async function () {
    const r = await renderOdt(oP('{d.h:html}'), { h: '<span style="color:red;background-color:#00ff00">x</span>' });
    assert.strictEqual(r.auto, tStyle('CRh1', 'fo:color="#ff0000" fo:background-color="#00ff00"'));
  });

  it('одинаковые наборы свойств — один стиль', async function () {
    const r = await renderOdt(oP('{d.h:html}'), { h: '<b>a</b> c <strong>d</strong><i>e</i>' });
    assert.strictEqual(r.body, oP(oS('CRh1', 'a') + ' c ' + oS('CRh1', 'd') + oS('CRh2', 'e')) + oSP());
    assert.strictEqual(r.auto, tStyle('CRh1', O_BOLD) + tStyle('CRh2', O_ITALIC));
  });

  it('текст по частям, экранирование & < > "', async function () {
    assert.strictEqual(await odtBody('a &amp; <b>b &lt;"&gt;</b> c'), oP('a &amp; ' + oS('CRh1', 'b &lt;&quot;&gt;') + ' c') + oSP());
  });

  it('p и br — text:line-break', async function () {
    assert.strictEqual(await odtBody('<p>a</p><p>b<br>c</p>'), oP('a') + oSP() + oP('b' + oLB + 'c') + oSP());
  });

  it('pre: табуляция — text:tab, повторы пробелов — text:s, Courier New', async function () {
    assert.strictEqual(await odtBody('<pre>a\tb\n  c</pre>'), oP(oS('CRh1', 'a<text:tab/>b') + oLB + oS('CRh1', '<text:s text:c="2"/>c')) + oSP());
    assert.strictEqual(await odtBody('<pre>  a  b\n\n c </pre>'),
      oP(oS('CRh1', '<text:s text:c="2"/>a <text:s/>b') + oLB + oLB + oS('CRh1', '<text:s/>c ')) + oSP());
    // пробел после пробела в соседнем тексте — тоже text:s
    assert.strictEqual(await odtBody('<pre>a <b> b</b></pre>'), oP(oS('CRh1', 'a ') + oS('CRh2', '<text:s/>b')) + oSP());
  });

  it('&emsp; остаётся символом, &nbsp; — U+00A0', async function () {
    assert.strictEqual(await odtBody('a&emsp;b&nbsp;c'), oP('a b c') + oSP());
  });

  it('флажки — символы ☒/☐', async function () {
    assert.strictEqual(await odtBody('<p><input type="checkbox" checked> да <input type="checkbox"> нет</p>'), oP('☒ да ☐ нет') + oSP());
  });
});

describe('html: ODT — абзац метки', function () {
  const AUTO = pStyle('P1', 'Standard', 'fo:text-align="center"') + tStyle('T1', 'fo:font-size="14pt"');

  it('метка одна в абзаце: пустые «до» и «после» не создаются', async function () {
    assert.strictEqual(await odtBody('<p>a</p>'), oP('a') + oSP());
  });

  it('текст до и после метки — свои абзацы с тем же стилем абзаца и span метки', async function () {
    assert.strictEqual(await odtBody('<p>a</p>', oP(oS('T1', 'До {d.h:html} после'), 'P1'), { automatic: AUTO }),
      oP(oS('T1', 'До '), 'P1') + oP(oS('T1', 'a'), 'P1') + oSP('P1') + oP(oS('T1', ' после'), 'P1'));
  });

  it('метка в своём span между текстом: пустой span метки не остаётся', async function () {
    assert.strictEqual(await odtBody('x', '<text:p>A<text:span text:style-name="T1">{d.h:html}</text:span>B</text:p>', { automatic: AUTO }),
      oP('A') + oP(oS('T1', 'x')) + oSP() + oP('B'));
  });

  it('метка в text:h шаблона — части остаются text:h, блоки — text:p с тем же стилем', async function () {
    const h = '<text:h text:style-name="Heading_20_2" text:outline-level="2">X {d.h:html}</text:h>';
    assert.strictEqual(await odtBody('a', h), '<text:h text:style-name="Heading_20_2" text:outline-level="2">X </text:h>' + oP('a', 'Heading_20_2') + oSP('Heading_20_2'));
  });

  it('две метки в одном абзаце', async function () {
    const r = await renderOdt(oP('{d.a:html}-{d.b:html}'), { a: 'x', b: 'y' });
    assert.strictEqual(r.body, oP('x') + oSP() + oP('-') + oP('y') + oSP());
  });

  it('вторая метка без содержимого — пустой абзац не остаётся', async function () {
    let r = await renderOdt(oP('{d.a:html}{d.b:html}'), { a: 'x', b: '<script>1</script>' });
    assert.strictEqual(r.body, oP('x') + oSP());
    r = await renderOdt(oP('{d.a:html} {d.b:html}'), { a: 'x', b: '' });
    assert.strictEqual(r.body, oP('x') + oSP());
  });

  it('закладки пустых частей переходят в соседние абзацы', async function () {
    const marker = oP('<text:bookmark-start text:name="b"/>{d.h:html}<text:bookmark-end text:name="b"/>');
    assert.strictEqual(await odtBody('<p>a</p>', marker),
      oP('<text:bookmark-start text:name="b"/>a') + oP('<text:bookmark-end text:name="b"/>'));
    assert.strictEqual(await odtBody('<p>a</p>', marker.replace('html}', 'html(nospace)}')),
      oP('<text:bookmark-start text:name="b"/>a<text:bookmark-end text:name="b"/>'));
  });

  it('nospace: без пустых абзацев', async function () {
    assert.strictEqual(await odtBody('<p>a</p><p>b</p>', oP('{d.h:html(nospace)}')), oP('a') + oP('b'));
  });

  it('R8: span метки — внешний, HTML — внутренний CRh без свойств метки', async function () {
    const auto = tStyle('T1', O_BOLD + ' fo:color="#0000ff"');
    const r = await renderOdt(oP(oS('T1', '{d.h:html}')), { h: '<i>x</i><b>y</b><b><i>z</i></b><span style="color:red">w</span>' }, { automatic: auto });
    assert.strictEqual(r.body, oP(oS('T1', oS('CRh1', 'x') + 'y' + oS('CRh1', 'z') + 'w')) + oSP());
    assert.strictEqual(r.auto, auto + tStyle('CRh1', O_ITALIC));
  });

  it('R8: текст автоматического стиля абзаца и стиль символов из styles.xml — тоже оформление метки', async function () {
    const styles = O_STYLES({ styles: tStyle('Strong_20_Emphasis', O_BOLD) });
    const auto = '<style:style style:name="P2" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties ' + O_ITALIC + '/></style:style>';
    const r = await renderOdt(oP(oS('Strong_20_Emphasis', '{d.h:html}'), 'P2'), { h: '<b><i><u>x</u></i></b>' }, { automatic: auto, styles });
    assert.strictEqual(r.body, oP(oS('Strong_20_Emphasis', oS('CRh1', 'x')), 'P2') + oSP('P2'));
    assert.strictEqual(r.auto, auto + tStyle('CRh1', O_UNDER));
  });

  it('стили CRh шаблона не повторяются; office:automatic-styles дописывается в конец', async function () {
    const auto = tStyle('CRh1', O_ITALIC) + pStyle('CRhp4', null, 'fo:margin-left="1cm"');
    const r = await renderOdt(oP('{d.h:html}'), { h: '<b>x</b><blockquote>q</blockquote>' }, { automatic: auto });
    assert.strictEqual(r.body, oP(oS('CRh2', 'x')) + oSP() + oP('q', 'CRhp5') + oSP());
    assert.strictEqual(r.auto, auto + tStyle('CRh2', O_BOLD) + pStyle('CRhp5', null, 'fo:margin-left="1.058cm"'));
  });

  it('Courier New уже объявлен — второй раз не добавляется', async function () {
    const r = await renderOdt(oP('{d.h:html}'), { h: '<code>x</code>' }, { fonts: O_COURIER });
    assert.strictEqual(r.fonts, O_COURIER);
  });

  it('разрыв страницы до и после блока — в стиле абзаца', async function () {
    let r = await renderOdt(oP('{d.h:html}'), { h: '<p style="break-before: page">a</p><p style="break-after: page">b</p>' });
    assert.strictEqual(r.body, oP('a', 'CRhp1') + oSP() + oP('b') + oSP('CRhp2'));
    assert.strictEqual(r.auto, pStyle('CRhp1', null, 'fo:break-before="page"') + pStyle('CRhp2', null, 'fo:break-after="page"'));
    r = await renderOdt(oP('{d.h:html(nospace)}', 'P1'), { h: '<p style="break-before: page">a</p><p style="break-after: page">b</p>' }, { automatic: AUTO });
    assert.strictEqual(r.body, oP('a', 'CRhp1') + oP('b', 'CRhp2'));
    // автоматический стиль метки не может быть родителем — копия его свойств с его родителем
    assert.strictEqual(r.auto, AUTO + pStyle('CRhp1', 'Standard', 'fo:text-align="center" fo:break-before="page"')
      + pStyle('CRhp2', 'Standard', 'fo:text-align="center" fo:break-after="page"'));
  });

  it('null, undefined и \'\' — ничего, абзац как у обычной метки', async function () {
    const plain = (await renderOdt(oP('{d.h}'), { h: '' })).body;
    for (const h of [null, undefined, '']) {
      assert.strictEqual((await renderOdt(oP('{d.h:html}'), { h })).body, plain);
    }
  });

  it('HTML без содержимого (только script) — абзац метки остаётся пустым, стилей нет', async function () {
    const r = await renderOdt(oP('{d.h:html}'), { h: '<script>x</script>' });
    assert.strictEqual(r.body, (await renderOdt(oP('{d.h}'), { h: '' })).body);
    assert.strictEqual(r.auto, null);
  });

  it('ячейка таблицы', async function () {
    const cell = (inner) => '<table:table table:name="T"><table:table-column/><table:table-row><table:table-cell>' + inner + '</table:table-cell></table:table-row></table:table>';
    assert.strictEqual(await odtBody('<p>a</p><p>b</p>', cell(oP('{d.h:html(nospace)}'))), cell(oP('a') + oP('b')));
  });

  it('колонтитул в styles.xml: автоматические стили — в office:automatic-styles styles.xml', async function () {
    const master = '<style:master-page style:name="Standard"><style:header>' + oP('{d.h:html}') + '</style:header></style:master-page>';
    const r = await renderOdt(oP('тело'), { h: '<b>x</b>' }, { styles: O_STYLES({ styles: '', master }) });
    assert.ok(r.styles.endsWith('<office:styles></office:styles><office:automatic-styles>' + tStyle('CRh1', O_BOLD) + '</office:automatic-styles>'
      + '<office:master-styles><style:master-page style:name="Standard"><style:header>' + oP(oS('CRh1', 'x')) + oSP()
      + '</style:header></style:master-page></office:master-styles></office:document-styles>'), r.styles);
    assert.strictEqual(r.body, oP('тело'));
    assert.strictEqual(r.auto, null);
  });

  it('inline: в том же абзаце внутри span метки, блоки — текст', async function () {
    const r = await renderOdt(oP(oS('T1', 'До {d.h:html(inline)} после'), 'P1'), { h: '<p>a <b>b</b></p><h1>c <code>d</code></h1>' }, { automatic: AUTO });
    assert.strictEqual(r.body, oP(oS('T1', 'До a ' + oS('CRh1', 'b') + ' c d после'), 'P1'));
    assert.strictEqual(r.auto, AUTO + tStyle('CRh1', O_BOLD));
  });

  it('Review Focus 2: мусорный HTML — корректный XML, текст сохранён, скрипт удалён', async function () {
    const html = '<div>Начало <span class="x">спан</span><script>alert(1)</script> <b><i>x</b></i> &nbsp;&lt; " 😀 a\u0001b￾c <p>незакрыт';
    const r = await renderOdt(oP('{d.h:html}'), { h: html });
    assert.strictEqual(r.body, oP('Начало спан ' + oS('CRh1', 'x') + '  &lt; &quot; 😀 abc') + oSP() + oP('незакрыт') + oSP());
    assert.strictEqual(r.auto, tStyle('CRh1', O_BOLD + ' ' + O_ITALIC));
  });

  it('{o.preReleaseFeatureIn=…} в шаблоне не мешает; defaultURL + html (R4)', async function () {
    const r = await renderOdt(oP('{o.preReleaseFeatureIn=5011000}') + oP('{d.h:defaultURL(\'https://site.ru\'):html}'), { h: '<b>x</b>' });
    assert.ok(r.body.endsWith(oP(oS('CRh1', 'x')) + oSP()), r.body);
  });

  it('R6: жетон в атрибуте или в замещающем тексте рамки — ошибка шаблона', async function () {
    const frame = '<text:p><draw:frame draw:name="f" text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:text-box><text:p>t</text:p></draw:text-box>'
      + '<svg:title>{d.h:html}</svg:title></draw:frame></text:p>';
    for (const body of ['<text:p><text:span text:style-name="{d.h:html}">l</text:span></text:p>', '<text:p><text:bookmark text:name="{d.h:html}"/>l</text:p>', frame]) {
      const tpl = await buildOdt(body);
      assert.strictEqual(await rejection(carbone.renderBuffer(tpl, 'odt', { h: '<b>x</b>' }, {})), 'html ставится в текст абзаца. Source: "{d.h:html}"');
    }
  });

  it('5000 строк таблицы с :html — линейно', async function () {
    this.timeout(30000);
    const rows = Array.from({ length: 5000 }, (v, i) => ({ h: '<b>' + i + '</b>' }));
    const body = '<table:table table:name="T"><table:table-column/><table:table-row><table:table-cell>' + oP('{d.rows[i].h:html(nospace)}')
      + '</table:table-cell></table:table-row><table:table-row><table:table-cell>' + oP('{d.rows[i+1].h:html(nospace)}')
      + '</table:table-cell></table:table-row></table:table>';
    const start = Date.now();
    const r = await renderOdt(body, { rows });
    const ms = Date.now() - start;
    assert.ok(r.body.includes(oP(oS('CRh1', '4999'))), 'последняя строка');
    assert.strictEqual(r.auto, tStyle('CRh1', O_BOLD));
    assert.ok(ms < 1500, 'сборка ' + ms + ' мс');
  });
});

describe('html: ODT — заголовки', function () {
  it('h1–h6 без styles.xml: text:h с outline-level, стили создаются в styles.xml (часть и manifest)', async function () {
    const r = await renderOdt(oP('{d.h:html(nospace)}'), { h: '<h1>1</h1><h2>2</h2><h3>3</h3><h4>4</h4><h5>5</h5><h6>6</h6>' });
    assert.strictEqual(r.body, [1, 2, 3, 4, 5, 6].map((n) => oH(n, String(n))).join(''));
    const sizes = [20, 16, 14, 13, 12, 11];
    assert.ok(r.styles.includes('<office:styles>' + sizes.map((s, i) => headingStyle('Heading_20_' + (i + 1), i + 1, s, 'Heading ' + (i + 1))).join('') + '</office:styles>'), r.styles);
    assert.ok(r.manifest.includes('<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>'), r.manifest);
  });

  it('стили шаблона используются, недостающие дописываются в office:styles', async function () {
    const existing = '<style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph"/>';
    const r = await renderOdt(oP('{d.h:html(nospace)}'), { h: '<h1>a</h1><h3>b</h3>' }, { styles: O_STYLES({ styles: existing, automatic: '' }) });
    assert.strictEqual(r.body, oH(1, 'a') + oH(3, 'b'));
    assert.ok(r.styles.includes('<office:styles>' + existing + headingStyle('Heading_20_3', 3, 14, 'Heading 3') + '</office:styles><office:automatic-styles></office:automatic-styles>'), r.styles);
    assert.strictEqual((r.manifest.match(/styles\.xml/g) || []).length, 1, r.manifest);
  });

  it('headingtheme:custom- — стили custom-1…, создаются при отсутствии; span метки сохраняется', async function () {
    const existing = '<style:style style:name="custom-1" style:family="paragraph"/>';
    const r = await renderOdt(oP(oS('T1', '{d.h:html(nospace, headingtheme:custom-)}')), { h: '<h1>a</h1><h4>b</h4>' }, {
      automatic: tStyle('T1', 'fo:font-size="9pt"'), styles: O_STYLES({ styles: existing })
    });
    assert.strictEqual(r.body, oH(1, oS('T1', 'a'), 'custom-1') + oH(4, oS('T1', 'b'), 'custom-4'));
    assert.ok(r.styles.includes('<office:styles>' + existing + headingStyle('custom-4', 4, 13) + '</office:styles>'), r.styles);
  });
});

describe('html: ODT — цитаты, pre, hr, разрывы', function () {
  it('blockquote: 1.058cm на уровень, вложенный — 2.116cm', async function () {
    const r = await renderOdt(oP('{d.h:html(nospace)}'), { h: '<blockquote>a<blockquote>b</blockquote></blockquote><p>c</p>' });
    assert.strictEqual(r.body, oP('a', 'CRhp1') + oP('b', 'CRhp2') + oP('c'));
    assert.strictEqual(r.auto, pStyle('CRhp1', null, 'fo:margin-left="1.058cm"') + pStyle('CRhp2', null, 'fo:margin-left="2.116cm"'));
  });

  it('blockquote: отступ прибавляется к отступу стиля метки (автоматического и общего)', async function () {
    const auto = pStyle('P1', 'Standard', 'fo:margin-left="1cm" fo:text-align="center"');
    let r = await renderOdt(oP('{d.h:html(nospace)}', 'P1'), { h: '<blockquote>a</blockquote>' }, { automatic: auto });
    assert.strictEqual(r.body, oP('a', 'CRhp1'));
    assert.strictEqual(r.auto, auto + pStyle('CRhp1', 'Standard', 'fo:margin-left="2.058cm" fo:text-align="center"'));
    const styles = O_STYLES({ styles: pStyle('Text_20_body', null, 'fo:margin-left="0.5in"') });
    r = await renderOdt(oP('{d.h:html(nospace)}', 'Text_20_body'), { h: '<blockquote>a</blockquote>' }, { styles });
    assert.strictEqual(r.auto, pStyle('CRhp1', 'Text_20_body', 'fo:margin-left="2.328cm"'));
  });

  it('quotetheme:Intense_20_Quote — стиль абзаца вместо отступа; стиля нет в шаблоне — отступ', async function () {
    const marker = oP('{d.h:html(nospace, quotetheme:Intense_20_Quote)}');
    const h = { h: '<blockquote>a<blockquote>b</blockquote></blockquote><p>c</p>' };
    let r = await renderOdt(marker, h, { styles: O_STYLES({ styles: '<style:style style:name="Intense_20_Quote" style:family="paragraph"/>' }) });
    assert.strictEqual(r.body, oP('a', 'Intense_20_Quote') + oP('b', 'Intense_20_Quote') + oP('c'));
    assert.strictEqual(r.auto, null);
    r = await renderOdt(marker, h);
    assert.strictEqual(r.body, oP('a', 'CRhp1') + oP('b', 'CRhp2') + oP('c'));
    assert.strictEqual(r.auto, pStyle('CRhp1', null, 'fo:margin-left="1.058cm"') + pStyle('CRhp2', null, 'fo:margin-left="2.116cm"'));
  });

  it('tabletheme в ODT допускается и не влияет', async function () {
    assert.strictEqual(await odtBody('<p>a</p>', oP('{d.h:html(tabletheme:Grid)}')), oP('a') + oSP());
  });

  it('hr — пустой абзац с нижней линией и отступами 0.21cm, без пустого абзаца после', async function () {
    const r = await renderOdt(oP('{d.h:html}'), { h: '<p>a</p><hr><blockquote><hr></blockquote>' });
    assert.strictEqual(r.body, oP('a') + oSP() + oSP('CRhp1') + oSP('CRhp2'));
    assert.strictEqual(r.auto, pStyle('CRhp1', null, O_HR) + pStyle('CRhp2', null, 'fo:margin-left="1.058cm" ' + O_HR));
  });

  it('break-before/break-after у заголовка и hr', async function () {
    const r = await renderOdt(oP('{d.h:html(nospace)}'), { h: '<h1 style="break-before:page">a</h1><hr style="break-before:page;break-after:page">' });
    assert.strictEqual(r.body, oH(1, 'a', 'CRhp1') + oSP('CRhp2'));
    assert.strictEqual(r.auto, pStyle('CRhp1', 'Heading_20_1', 'fo:break-before="page"')
      + pStyle('CRhp2', null, O_HR + ' fo:break-before="page" fo:break-after="page"'));
  });
});

describe('html: ODT — разрывы и стиль страницы абзаца метки (доработка 1)', function () {
  // типичные автоматические стили LibreOffice: первый абзац документа и абзац после разрыва страницы
  const P1 = '<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="Standard">'
    + '<style:paragraph-properties style:page-number="auto"/></style:style>';
  const P2 = pStyle('P2', 'Standard', 'fo:break-before="page"');
  const P3 = pStyle('P3', 'Standard', 'fo:break-after="page"');
  const P1_REST = '<style:style style:name="CRhp1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name=""></style:style>';

  it('master-page-name и page-number — только у первого абзаца', async function () {
    const r = await renderOdt(oP('{d.h:html}', 'P1'), { h: '<p>a</p><p>b</p>' }, { automatic: P1 });
    assert.strictEqual(r.body, oP('a', 'P1') + oSP('CRhp1') + oP('b', 'CRhp1') + oSP('CRhp1'));
    assert.strictEqual(r.auto, P1 + P1_REST);
  });

  it('fo:break-before — только у первого абзаца («до»), прочие блоки, пустые абзацы и «после» — без разрыва', async function () {
    const r = await renderOdt(oP('X {d.h:html} Y', 'P2'), { h: '<p>a</p><blockquote>q</blockquote><pre>p</pre><hr><h2>h</h2>' }, { automatic: P2 });
    assert.strictEqual(r.body, oP('X ', 'P2') + oP('a', 'CRhp1') + oSP('CRhp1') + oP('q', 'CRhp2') + oSP('CRhp1') + oP(oS('CRh1', 'p'), 'CRhp1')
      + oSP('CRhp1') + oSP('CRhp3') + oH(2, 'h') + oSP('CRhp1') + oP(' Y', 'CRhp1'));
    assert.ok(r.auto.endsWith(pStyle('CRhp1', 'Standard', 'fo:break-before="auto"') + pStyle('CRhp2', 'Standard', 'fo:break-before="auto" fo:margin-left="1.058cm"')
      + pStyle('CRhp3', 'Standard', 'fo:break-before="auto" ' + O_HR)), r.auto);
    assert.strictEqual((r.auto.match(/fo:break-before="page"/g) || []).length, 1, r.auto);
  });

  it('первый абзац — заголовок: стиль страницы метки переходит к нему', async function () {
    const r = await renderOdt(oP('{d.h:html(nospace)}', 'P1'), { h: '<h1>h</h1><p>a</p>' }, { automatic: P1 });
    assert.strictEqual(r.body, oH(1, 'h', 'CRhp1') + oP('a', 'CRhp2'));
    assert.strictEqual(r.auto, P1 + '<style:style style:name="CRhp1" style:family="paragraph" style:parent-style-name="Heading_20_1" style:master-page-name="Standard">'
      + '<style:paragraph-properties style:page-number="auto"/></style:style>' + P1_REST.replace('CRhp1', 'CRhp2'));
  });

  it('fo:break-after — только у последнего абзаца', async function () {
    const r = await renderOdt(oP('{d.h:html}', 'P3'), { h: '<p>a</p><p>b</p>' }, { automatic: P3 });
    assert.strictEqual(r.body, oP('a', 'CRhp1') + oSP('CRhp1') + oP('b', 'CRhp1') + oSP('P3'));
    assert.strictEqual(r.auto, P3 + pStyle('CRhp1', 'Standard', 'fo:break-after="auto"'));
  });

  it('общий стиль с разрывом: прочие абзацы — автоматический стиль с fo:break-before="auto"', async function () {
    const styles = O_STYLES({ styles: pStyle('Break_20_style', null, 'fo:break-before="page"') });
    const r = await renderOdt(oP('{d.h:html(nospace)}', 'Break_20_style'), { h: '<p>a</p><p>b</p>' }, { styles });
    assert.strictEqual(r.body, oP('a', 'Break_20_style') + oP('b', 'CRhp1'));
    assert.strictEqual(r.auto, pStyle('CRhp1', 'Break_20_style', 'fo:break-before="auto"'));
  });

  it('один абзац — все свойства страницы у него', async function () {
    const r = await renderOdt(oP('{d.h:html(nospace)}', 'P1'), { h: '<blockquote>q</blockquote>' }, { automatic: P1 });
    assert.strictEqual(r.body, oP('q', 'CRhp1'));
    assert.strictEqual(r.auto, P1 + '<style:style style:name="CRhp1" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="Standard">'
      + '<style:paragraph-properties style:page-number="auto" fo:margin-left="1.058cm"/></style:style>');
  });

  it('две метки в абзаце с разрывом — разрыв один раз', async function () {
    const r = await renderOdt(oP('{d.a:html}-{d.b:html}', 'P2'), { a: 'x', b: 'y' }, { automatic: P2 });
    assert.strictEqual(r.body, oP('x', 'P2') + oSP('CRhp1') + oP('-', 'CRhp1') + oP('y', 'CRhp1') + oSP('CRhp1'));
  });
});
