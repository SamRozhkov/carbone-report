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
