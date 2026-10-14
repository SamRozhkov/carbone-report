// Графики ECharts (2.6.0, спецификация §35.1–35.2). Эталона EE нет: ожидания — по §35 и решениям R1–R10 плана 2.6.0.
const assert = require('assert');
const echartsRender = require('../lib/echarts-render');

const NB = ' ';
const BAR = {
  xAxis: { type: 'category', data: ['Янв', 'Фев', 'Мар'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', name: 'Сумма', data: [10, 25, 7] }]
};
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** размер PNG по заголовку IHDR */
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
const parseError = (value) => {
  try {
    echartsRender.parse(value);
  }
  catch (e) {
    return e.message;
  }
  throw new Error('ожидалась ошибка');
};
const renderError = (value, frame) => {
  try {
    echartsRender.render(echartsRender.parse(value), frame || null);
  }
  catch (e) {
    return e.message;
  }
  throw new Error('ожидалась ошибка');
};
const withTitle = (title, fontFamily) => ({ option: Object.assign({}, BAR, { title: { text: title, textStyle: { fontFamily } } }) });

describe('echarts: разбор значения :chart (§35.1)', function () {
  it('пустое значение — null (заглушка удаляется)', function () {
    for (const v of [null, undefined, '', '   ']) {
      assert.strictEqual(echartsRender.parse(v), null);
    }
  });
  it('{ type, option }: тип по умолчанию echarts@v5, echarts@v5a допустим', function () {
    assert.deepStrictEqual(echartsRender.parse({ option: BAR }), { type: 'echarts@v5', width: null, height: null, theme: null, option: BAR });
    assert.strictEqual(echartsRender.parse({ type: 'echarts@v5a', option: BAR }).type, 'echarts@v5a');
  });
  it('голое описание с series (удобно для SQL)', function () {
    assert.deepStrictEqual(echartsRender.parse(BAR), { type: 'echarts@v5', width: null, height: null, theme: null, option: BAR });
  });
  it('строка разбирается как JSON; не JSON — ошибка', function () {
    assert.deepStrictEqual(echartsRender.parse(JSON.stringify({ option: BAR })).option, BAR);
    assert.strictEqual(parseError('{"option":'), 'описание графика — не JSON');
  });
  it('неизвестный тип', function () {
    assert.strictEqual(parseError({ type: 'echarts@v4', option: BAR }), 'неизвестный тип графика «echarts@v4» (echarts@v5 или echarts@v5a)');
  });
  it('не объект и объект без option и series — ошибка', function () {
    for (const v of [5, [BAR], { title: { text: 'x' } }, { type: 'echarts@v5' }]) {
      assert.strictEqual(parseError(v), 'описание графика — объект { type, option } или описание ECharts с series');
    }
  });
  it('width/height: 100–4000, дробное округляется; вне диапазона — ошибка', function () {
    const c = echartsRender.parse({ width: 800.4, height: 100, option: BAR });
    assert.deepStrictEqual([c.width, c.height], [800, 100]);
    for (const size of [99, 4001, '600', -1]) {
      assert.strictEqual(parseError({ width: size, option: BAR }), 'width и height графика — от 100 до 4000 пикселей');
    }
  });
  it('theme: null, dark, объект; иное — ошибка (Review Focus 3)', function () {
    assert.strictEqual(echartsRender.parse({ theme: 'dark', option: BAR }).theme, 'dark');
    assert.deepStrictEqual(echartsRender.parse({ theme: { color: ['#ff0000'] }, option: BAR }).theme, { color: ['#ff0000'] });
    assert.strictEqual(parseError({ theme: 'light', option: BAR }), 'theme графика — null, \'dark\' или объект темы ECharts');
  });
  it('лимиты: 1 МБ, 20 рядов, 10 000 точек в series.data и dataset.source (Review Focus 3)', function () {
    assert.strictEqual(parseError({ option: Object.assign({}, BAR, { pad: 'x'.repeat(1024 * 1024) }) }), 'описание графика больше 1 МБ');
    assert.strictEqual(parseError('{"option":' + JSON.stringify(BAR) + ',"pad":"' + 'я'.repeat(600000) + '"}'), 'описание графика больше 1 МБ');
    const series = (n, points) => Array.from({ length: n }, () => ({ type: 'line', data: Array.from({ length: points }, (_, i) => i) }));
    assert.ok(echartsRender.parse({ option: { series: series(20, 500) } }));
    assert.strictEqual(parseError({ option: { series: series(21, 1) } }), 'в графике больше 20 рядов');
    assert.strictEqual(parseError({ option: { series: series(1, 10001) } }), 'в графике больше 10 000 точек');
    assert.strictEqual(parseError({ option: { dataset: { source: Array.from({ length: 10001 }, (_, i) => [i, i]) }, series: [{ type: 'bar' }] } }), 'в графике больше 10 000 точек');
    assert.strictEqual(parseError({ option: { dataset: [{ source: { x: Array(6000).fill(1), y: Array(5000).fill(1) } }], series: { type: 'bar' } } }), 'в графике больше 10 000 точек');
  });
});

describe('echarts: отрисовка (§35.2)', function () {
  it('PNG в 2 раза больше логического размера: рамка, width/height, без рамки — 600×400', function () {
    const a = echartsRender.render(echartsRender.parse({ option: BAR }), { width: 300, height: 200 });
    assert.ok(a.buffer.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.deepStrictEqual([a.width, a.height], [600, 400]);
    assert.deepStrictEqual(pngSize(a.buffer), { width: 600, height: 400 });
    const b = echartsRender.render(echartsRender.parse({ width: 800, height: 400, option: BAR }), { width: 300, height: 200 });
    assert.deepStrictEqual(pngSize(b.buffer), { width: 1600, height: 800 });
    const c = echartsRender.render(echartsRender.parse({ option: BAR }), null);
    assert.deepStrictEqual(pngSize(c.buffer), { width: 1200, height: 800 });
    // рамка меньше 100 px или больше 4000 px зажимается (R3); сторона больше 2000 px — масштаб 1
    const d = echartsRender.render(echartsRender.parse({ option: BAR }), { width: 10, height: 5000 });
    assert.deepStrictEqual(pngSize(d.buffer), { width: 100, height: 4000 });
  });
  it('сторона больше 2000 px — масштаб 1, до 2000 px включительно — масштаб 2', function () {
    const draw = (width, height) => echartsRender.render(echartsRender.parse({ width, height, option: BAR }), null);
    const a = draw(2000, 100);
    assert.deepStrictEqual([a.width, a.height], [4000, 200]);
    assert.deepStrictEqual(pngSize(a.buffer), { width: 4000, height: 200 });
    const b = draw(2001, 100);
    assert.deepStrictEqual([b.width, b.height], [2001, 100]);
    assert.deepStrictEqual(pngSize(b.buffer), { width: 2001, height: 100 });
    assert.deepStrictEqual(pngSize(draw(100, 4000).buffer), { width: 100, height: 4000 });
  });
  it('нечисловая рамка (NaN, нет поля, Infinity) — размер по умолчанию 600×400 (R3)', function () {
    for (const frame of [{ width: NaN, height: NaN }, {}, { width: Infinity, height: -Infinity }, { width: '300', height: null }]) {
      const r = echartsRender.render(echartsRender.parse({ option: BAR }), frame);
      assert.deepStrictEqual([r.width, r.height], [1200, 800], JSON.stringify(frame));
      assert.deepStrictEqual(pngSize(r.buffer), { width: 1200, height: 800 });
    }
    // годная сторона остаётся, негодная — по умолчанию
    assert.deepStrictEqual(pngSize(echartsRender.render(echartsRender.parse({ option: BAR }), { width: 300, height: NaN }).buffer), { width: 600, height: 800 });
  });
  it('кириллица рисуется, любое семейство шрифта рисуется Noto Sans (Review Focus 4)', function () {
    const draw = (v) => echartsRender.render(echartsRender.parse(v), { width: 400, height: 300 }).buffer;
    const noto = draw(withTitle('Продажи по месяцам', 'Noto Sans'));
    assert.ok(draw(withTitle('Продажи по месяцам', 'Comic Sans MS')).equals(noto));
    assert.ok(draw(withTitle('Продажи по месяцам', 'serif')).equals(noto));
    assert.ok(!draw(withTitle('', 'Noto Sans')).equals(noto), 'заголовок не нарисован');
  });
  it('ошибка ECharts — «график: …»; после неё следующий график рисуется', function () {
    assert.strictEqual(renderError({ option: { series: [{ type: 'bar', data: [1] }] } }), 'график: xAxis "0" not found');
    assert.ok(echartsRender.render(echartsRender.parse({ option: BAR }), null).buffer.length > 0);
  });
  it('дольше лимита — «график рисуется дольше 5 с» (R2)', function () {
    const saved = echartsRender.LIMITS.ms;
    echartsRender.LIMITS.ms = -1;
    try {
      assert.strictEqual(renderError({ option: BAR }), 'график рисуется дольше 5 с');
    }
    finally {
      echartsRender.LIMITS.ms = saved;
    }
  });
  it('враждебное описание: __proto__, строка-функция, вложенность 1000, тёмная тема и объект темы (Review Focus 3)', function () {
    const option = JSON.parse('{"__proto__":{"polluted":1},"xAxis":{"type":"category","data":["a"]},"yAxis":{},"series":[{"type":"bar","data":[1],"label":{"show":true,"formatter":"function(){return 1}"}}]}');
    let deep = {};
    const root = deep;
    for (let i = 0; i < 1000; i++) {
      deep.a = {};
      deep = deep.a;
    }
    option.extra = root;
    const built = echartsRender.buildOption(echartsRender.parse({ option }));
    assert.strictEqual(Object.getPrototypeOf(built), Object.prototype);
    assert.strictEqual(built.polluted, undefined);
    assert.strictEqual(built.series[0].label.formatter, 'function(){return 1}');
    assert.ok(echartsRender.render(echartsRender.parse({ option }), null).buffer.length > 0);
    assert.ok(echartsRender.render(echartsRender.parse({ theme: 'dark', option: BAR }), null).buffer.length > 0);
    assert.ok(echartsRender.render(echartsRender.parse({ theme: { color: ['#ff0000'], backgroundColor: '#eeeeee' }, option: BAR }), null).buffer.length > 0);
    assert.strictEqual({}.polluted, undefined);
  });
  describe('картинки в описании: только data URI PNG, JPEG, GIF, иначе ошибка — файлы сервера не читаются', function () {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { Resvg } = require('@resvg/resvg-js');
    const IMAGE_ERROR = 'график: картинки в описании — только data:image/png|jpeg|gif;base64';
    let dir;
    let file;
    let dataUri;
    before(function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-echarts-'));
      file = path.join(dir, 'red.png');
      const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#ff0000"/></svg>').render().asPng();
      fs.writeFileSync(file, png);
      dataUri = 'data:image/png;base64,' + png.toString('base64');
    });
    after(function () {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const FRAME = { width: 200, height: 200 };
    const draw = (option) => echartsRender.render(echartsRender.parse({ option }), FRAME).buffer;
    const error = (value) => renderError(value, FRAME);
    const graphic = (image) => ({ series: [], graphic: [{ type: 'image', left: 0, top: 0, style: { image, width: 200, height: 200 } }] });
    const symbol = (image) => ({ xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: {}, series: [{ type: 'line', symbol: 'image://' + image, symbolSize: 80, data: [1, 2] }] });
    const background = (image) => ({ series: [], backgroundColor: { image, repeat: 'repeat', imageWidth: 20, imageHeight: 20 } });
    const barPattern = (image) => ({ xAxis: { type: 'category', data: ['a'] }, yAxis: {}, series: [{ type: 'bar', data: [1], itemStyle: { color: { image, repeat: 'repeat', imageWidth: 20, imageHeight: 20 } } }] });
    // обход регулярки без левой границы: удаление href="x" и href="y" склеивало href="<путь>"
    const bypass = (target) => ['x" hrhref="y"ef="' + target, 'x" xlink:hrhref="y"ef="' + target, 'x" xlink:href="' + target];

    it('data URI PNG рисуется в graphic, symbol и узоре', function () {
      const blank = draw({ series: [] });
      assert.ok(!draw(graphic(dataUri)).equals(blank));
      assert.ok(!draw(symbol(dataUri)).equals(draw({ xAxis: { type: 'category', data: ['a', 'b'] }, yAxis: {}, series: [{ type: 'line', symbol: 'none', data: [1, 2] }] })));
      assert.ok(!draw(background(dataUri)).equals(blank));
      assert.ok(draw(barPattern(dataUri)).length > 0);
    });
    it('путь, file://, https, data:image/svg+xml — ошибка шаблона', function () {
      const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
      for (const image of [file, 'file://' + file, 'https://example.com/a.png', svg, dataUri + '"', ' ' + dataUri]) {
        for (const build of [graphic, symbol, background, barPattern]) {
          assert.strictEqual(error({ option: build(image) }), IMAGE_ERROR, build.name + ' ' + image.slice(0, 40));
        }
      }
    });
    it('подстановка кавычек (hrhref, xlink:hrhref, xlink:href) — ошибка в graphic, symbol и узоре', function () {
      for (const image of bypass(file)) {
        for (const build of [graphic, symbol, background, barPattern]) {
          assert.strictEqual(error({ option: build(image) }), IMAGE_ERROR, build.name + ' ' + image);
        }
      }
    });
    it('/dev/zero через подстановку — ошибка сразу, файл не читается', function () {
      const started = Date.now();
      for (const image of bypass('/dev/zero')) {
        assert.strictEqual(error({ option: graphic(image) }), IMAGE_ERROR);
        assert.strictEqual(error({ option: symbol(image) }), IMAGE_ERROR);
      }
      assert.ok(Date.now() - started < 3000);
    });
    it('image не строка, глубоко во вложенных группах graphic и в теме — ошибка', function () {
      assert.strictEqual(error({ option: graphic({ src: file }) }), IMAGE_ERROR);
      let group = { type: 'image', style: { image: file, width: 10, height: 10 } };
      for (let i = 0; i < 200; i++) {
        group = { type: 'group', children: [group] };
      }
      assert.strictEqual(error({ option: { series: [], graphic: [group] } }), IMAGE_ERROR);
      assert.strictEqual(error({ theme: { backgroundColor: { image: file, imageWidth: 20, imageHeight: 20 } }, option: BAR }), IMAGE_ERROR);
      assert.strictEqual(error({ option: Object.assign({}, BAR, { series: [{ type: 'bar', data: [{ value: 1, symbol: 'IMAGE://' + file }] }] }) }), IMAGE_ERROR);
    });
    describe('разметка из строк описания (ECharts не экранирует кавычки и < > в атрибутах)', function () {
      const SVG_ERROR = 'график: недопустимое содержимое SVG';
      const bar = (extra, item) => Object.assign({ xAxis: { type: 'category', data: ['a'] }, yAxis: {}, series: [Object.assign({ type: 'bar', data: [1], label: { show: true } }, item)] }, extra);
      const places = (payload) => [
        bar({}, { itemStyle: { color: payload } }),
        bar({ textStyle: { fontFamily: payload } }, {}),
        bar({}, { label: { show: true, color: payload } })
      ];
      it('подстановка <image href="путь"> через цвет, шрифт и цвет подписи — ошибка, файл не рисуется', function () {
        for (const payload of [
          'red"/><image width="300" height="200" class=">" href="' + file + '"/><path fill="red',
          'red"/><image width="300" height="200" href="' + file + '"/><path fill="red',
          'red"/><image width="300" height="200" xlink:href="/dev/zero"/><path fill="red'
        ]) {
          for (const option of places(payload)) {
            assert.strictEqual(error({ option }), IMAGE_ERROR, JSON.stringify(option).slice(0, 120));
          }
        }
      });
      it('чужие элементы, url() с адресом, xmlns, комментарий — ошибка', function () {
        for (const payload of [
          'red"/><use href="#x"/><path fill="red',
          'red"/><foreignObject/><path fill="red',
          'red"/><feImage/><path fill="red',
          'url(file:///etc/passwd)',
          'red" xmlns="http://example.com',
          'red"/><!-- x --><path fill="red'
        ]) {
          assert.strictEqual(error({ option: places(payload)[0] }), SVG_ERROR, payload);
        }
      });
    });
    it('слово href= в подписях — не ошибка (текст экранируется)', function () {
      const option = Object.assign({}, BAR, { title: { text: 'Выручка a"<>&b href="x" href=\'y\' href = z' }, graphic: [{ type: 'text', style: { text: 'xlink:href="/etc/passwd"' } }] });
      assert.ok(!draw(option).equals(draw(BAR)));
    });
    it('все типы и оформление рисуются после проверки SVG', function () {
      const blank = draw({ series: [] });
      const cat = { xAxis: { type: 'category', data: ['Янв', 'Фев', 'Мар'] }, yAxis: { type: 'value' } };
      const gradient = (type) => Object.assign({ type, colorStops: [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }] }, type === 'linear' ? { x: 0, y: 0, x2: 0, y2: 1 } : { x: 0.5, y: 0.5, r: 0.5 });
      const options = [
        Object.assign({ title: { text: 'Продажи' }, legend: { top: 'top' } }, cat, { series: [{ type: 'bar', name: 'a', data: [1, 2, 3], label: { show: true } }] }),
        Object.assign({ legend: { bottom: 0 } }, cat, { series: [{ type: 'line', smooth: true, areaStyle: {}, stack: 's', data: [1, 2, 3] }, { type: 'line', stack: 's', data: [1, 2, 3] }] }),
        { legend: { right: 0, orient: 'vertical' }, series: [{ type: 'pie', data: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }], label: { formatter: '{b}: {c}' } }] },
        { series: [{ type: 'pie', radius: ['40%', '70%'], data: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }] }] },
        { xAxis: { type: 'category', data: ['a'] }, yAxis: [{ type: 'value', name: 'L' }, { type: 'value', name: 'R', position: 'right' }], series: [{ type: 'bar', data: [1] }, { type: 'line', yAxisIndex: 1, data: [2] }] },
        { yAxis: { type: 'category', inverse: true, data: ['a', 'b'] }, xAxis: { type: 'value' }, series: [{ type: 'bar', data: [1, 2] }] },
        Object.assign({}, cat, { series: [{ type: 'bar', data: [1, 2, 3], label: { show: true, formatter: '{a|x}{b|y}', rich: { a: { color: 'red', backgroundColor: '#eee' }, b: { fontWeight: 'bold' } } } }] }),
        Object.assign({}, cat, { series: [{ type: 'bar', data: [1, 2, 3], itemStyle: { color: gradient('linear'), shadowBlur: 5, shadowColor: '#000' } }, { type: 'bar', data: [1, 2, 3], itemStyle: { color: gradient('radial') } }] })
      ];
      for (const option of options) {
        assert.ok(!draw(option).equals(blank), JSON.stringify(option).slice(0, 80));
      }
    });
  });
  it('buildOption: animation false, белый фон и Noto Sans по умолчанию; свои значения и тема не перекрываются', function () {
    const plain = echartsRender.buildOption(echartsRender.parse({ option: Object.assign({ animation: true }, BAR) }));
    assert.strictEqual(plain.animation, false);
    assert.strictEqual(plain.backgroundColor, '#ffffff');
    assert.deepStrictEqual(plain.textStyle, { fontFamily: 'Noto Sans' });
    const own = echartsRender.buildOption(echartsRender.parse({ option: Object.assign({ backgroundColor: 'transparent', textStyle: { fontSize: 14, fontFamily: 'Arial' } }, BAR) }));
    assert.strictEqual(own.backgroundColor, 'transparent');
    assert.deepStrictEqual(own.textStyle, { fontSize: 14, fontFamily: 'Arial' });
    assert.strictEqual(echartsRender.buildOption(echartsRender.parse({ theme: 'dark', option: BAR })).backgroundColor, undefined);
    assert.strictEqual(echartsRender.buildOption(echartsRender.parse({ theme: { backgroundColor: '#000' }, option: BAR })).backgroundColor, undefined);
    // исходное описание (данные отчёта) не меняется
    assert.strictEqual(BAR.animation, undefined);
  });
});

describe('echarts: формат чисел cr:number (R4; те же примеры — packages/shared/src/charts.test.ts)', function () {
  const CASES = [
    [1234.5, { decimals: null, thousands: false, suffix: '' }, '1234,5'],
    [1234.5, { decimals: 2, thousands: true, suffix: '₽' }, '1' + NB + '234,50' + NB + '₽'],
    [-1234567, { decimals: 0, thousands: true, suffix: '' }, '-1' + NB + '234' + NB + '567'],
    [0.125, { decimals: 1, thousands: false, suffix: '%' }, '0,1' + NB + '%'],
    [1e21, { decimals: null, thousands: true, suffix: '' }, '1e+21'],
    [12, { decimals: 3, thousands: false, suffix: 'шт.' }, '12,000' + NB + 'шт.']
  ];
  for (const [value, format, want] of CASES) {
    it(value + ' ' + JSON.stringify(format) + ' → ' + JSON.stringify(want), function () {
      assert.strictEqual(echartsRender.formatNumber(value, format), want);
    });
  }
  it('numberFormatter: число, параметры подписи, круговая, массив значений', function () {
    const fn = echartsRender.numberFormatter('cr:number:{"decimals":2,"thousands":true,"suffix":"₽"}');
    assert.strictEqual(fn(1234.5), '1' + NB + '234,50' + NB + '₽');
    assert.strictEqual(fn({ seriesType: 'bar', value: 10 }), '10,00' + NB + '₽');
    assert.strictEqual(fn({ seriesType: 'pie', name: 'Север', value: 10 }), 'Север: 10,00' + NB + '₽');
    assert.strictEqual(fn({ seriesType: 'line', value: ['Янв', 7] }), '7,00' + NB + '₽');
    assert.strictEqual(fn({ seriesType: 'bar', value: null }), '');
  });
  it('numberFormatter: не маркер или неверный формат — null (строка остаётся шаблоном ECharts)', function () {
    for (const ref of ['{c} ₽', 'cr:number:{', 'cr:number:{"decimals":7}', 'cr:number:{"suffix":"12345678901"}', 'cr:number:{"thousands":"да"}', 5]) {
      assert.strictEqual(echartsRender.numberFormatter(ref), null);
    }
  });
  it('buildOption заменяет маркеры formatter и valueFormatter функциями', function () {
    const ref = 'cr:number:{"decimals":0,"thousands":true,"suffix":""}';
    const built = echartsRender.buildOption(echartsRender.parse({ option: Object.assign({}, BAR, { tooltip: { valueFormatter: ref }, yAxis: { type: 'value', axisLabel: { formatter: ref } } }) }));
    assert.strictEqual(built.yAxis.axisLabel.formatter(12345), '12' + NB + '345');
    assert.strictEqual(built.tooltip.valueFormatter(1000), '1' + NB + '000');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// :chart в документах (§35.1): картинка-заглушка с тегом в замещающем тексте, путь картинок 2.4.0

const { renderBuffer } = require('../lib/index');
const { readEntry, entryNames } = require('./golden-lib');
const {
  RU, drawing, para, buildPictureDocx, embeds, target, assertWellFormed, pptxPic, buildPptx, xlsxPic, buildXlsx,
  odfFrame, buildOdf, odsBody, odpBody, renderAny, tags, attrOf, ids
} = require('./media-lib');

const W = { cx: 5715000, cy: 3810000 }; // 600×400 px
const BAR_VALUE = { option: BAR };

async function docx (raws, data, options) {
  const out = await renderBuffer(await buildPictureDocx(raws), 'docx', data, Object.assign({}, RU, options));
  return { out, doc: await readEntry(out, 'word/document.xml'), rels: await readEntry(out, 'word/_rels/document.xml.rels'), names: await entryNames(out) };
}
async function docxError (raws, data) {
  try {
    await renderBuffer(await buildPictureDocx(raws), 'docx', data, RU);
  }
  catch (e) {
    return e.message;
  }
  throw new Error('ожидалась ошибка');
}
/** PNG, на который ссылается n-я картинка документа */
async function docxPng (r, n) {
  return Buffer.from(await readEntry(r.out, 'word/' + target(r.rels, embeds(r.doc)[n || 0]), true));
}
const one = (marker, data, opts) => docx([para(drawing(marker, Object.assign({}, W, opts)))], data);
const oneError = (marker, data) => docxError([para(drawing(marker, W))], data);

describe('echarts: :chart в документах (§35.1)', function () {
  it('DOCX: PNG вместо заглушки, размер рамки ×2, рамка не меняется, тег убран', async function () {
    const r = await one('{d.c:chart}', { c: BAR_VALUE });
    const buf = await docxPng(r);
    assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE));
    assert.deepStrictEqual(pngSize(buf), { width: 1200, height: 800 });
    assert.match(target(r.rels, embeds(r.doc)[0]), /^media\/cr-img-\d+\.png$/);
    assert.deepStrictEqual(tags(r.doc, 'wp:extent'), ['<wp:extent cx="5715000" cy="3810000"/>']);
    assert.ok(!r.doc.includes(':chart'), 'тег остался в документе');
    assert.ok(!/[]/.test(r.doc), 'жетон остался в документе');
    assertWellFormed(r.doc);
  });
  it('width/height: PNG по ним, в рамке — fillWidth; imageFit(fill) растягивает на рамку', async function () {
    const r = await one('{d.c:chart}', { c: { width: 800, height: 400, option: BAR } });
    assert.deepStrictEqual(pngSize(await docxPng(r)), { width: 1600, height: 800 });
    assert.deepStrictEqual(tags(r.doc, 'wp:extent'), ['<wp:extent cx="5715000" cy="2857500"/>']);
    const f = await one('{d.c:chart:imageFit(fill)}', { c: { width: 800, height: 400, option: BAR } });
    assert.deepStrictEqual(tags(f.doc, 'wp:extent'), ['<wp:extent cx="5715000" cy="3810000"/>']);
  });
  it('голое описание, строка JSON и echarts@v5a', async function () {
    for (const c of [BAR, JSON.stringify(BAR_VALUE), { type: 'echarts@v5a', option: BAR }]) {
      const r = await one('{d.c:chart}', { c });
      assert.deepStrictEqual(pngSize(await docxPng(r)), { width: 1200, height: 800 });
    }
  });
  it('chart() с пустыми скобками допустим (R10)', async function () {
    const r = await one('{d.c:chart()}', { c: BAR_VALUE });
    assert.deepStrictEqual(pngSize(await docxPng(r)), { width: 1200, height: 800 });
    assert.ok(!r.doc.includes(':chart'), 'тег остался в документе');
  });
  it('пустое значение (null, \'\', нет поля) — заглушка удаляется', async function () {
    for (const data of [{ c: null }, { c: '' }, {}]) {
      const r = await one('{d.c:chart}', data);
      assert.ok(!r.doc.includes('<w:drawing>'), r.doc);
      assert.ok(!r.names.some((n) => n.includes('cr-img')));
    }
  });
  it('ошибки — с меткой (R1)', async function () {
    assert.strictEqual(await oneError('{d.c:chart}', { c: '{"option":' }), 'описание графика — не JSON Source: "{d.c:chart}"');
    assert.strictEqual(await oneError('{d.c:chart}', { c: { type: 'x', option: BAR } }), 'неизвестный тип графика «x» (echarts@v5 или echarts@v5a) Source: "{d.c:chart}"');
    assert.strictEqual(await oneError('{d.c:chart}', { c: { option: { series: [{ type: 'bar', data: [1] }] } } }), 'график: xAxis "0" not found Source: "{d.c:chart}"');
    assert.strictEqual(await oneError('{d.c:chart}', { c: { option: { series: Array(21).fill({ type: 'line' }) } } }), 'в графике больше 20 рядов Source: "{d.c:chart}"');
    assert.strictEqual(await oneError('{d.c:chart(x)}', { c: BAR_VALUE }), 'chart пишется без аргументов: {d.x:chart} Source: "{d.c:chart(x)}"');
    assert.strictEqual(await oneError('{d.c:barcode(qrcode):chart}', { c: 'x' }), 'chart и barcode — в разных метках Source: "{d.c:barcode(qrcode):chart}"');
  });
  it(':chart в обычном тексте — ошибка шаблона', async function () {
    assert.strictEqual(await docxError([para('<w:t>{d.c:chart}</w:t>')], { c: BAR_VALUE }), 'график ставится в замещающий текст картинки Source: "{d.c:chart}"');
  });
  it('цикл в строке таблицы: свой PNG на строку, id уникальны (Review Focus 2)', async function () {
    const cell = (inner) => '<w:tc><w:p><w:r>' + inner + '</w:r></w:p></w:tc>';
    const tbl = '<w:tbl><w:tr>' + cell(drawing('{d.rows[i].c:chart}', Object.assign({ id: 4 }, W))) + '</w:tr><w:tr>' + cell(drawing('{d.rows[i+1].c:chart}', Object.assign({ id: 4 }, W))) + '</w:tr></w:tbl>';
    const rows = [10, 20, 30].map((v) => ({ c: { option: Object.assign({}, BAR, { series: [{ type: 'bar', data: [v, 1, 2] }] }) } }));
    const r = await docx([tbl], { rows });
    const list = embeds(r.doc);
    assert.strictEqual(list.length, 3);
    assert.strictEqual(new Set(list.map((id) => target(r.rels, id))).size, 3);
    assert.strictEqual(new Set(ids(r.doc, 'wp:docPr')).size, 3);
    assertWellFormed(r.doc);
  });
  it('одно описание в рамках разного размера — свой PNG у каждой (Review Focus 2)', async function () {
    const r = await docx([para(drawing('{d.c:chart}', Object.assign({ id: 1 }, W))) + para(drawing('{d.c:chart}', { id: 2, cx: 2857500, cy: 1905000 }))], { c: BAR_VALUE });
    assert.deepStrictEqual(pngSize(await docxPng(r, 0)), { width: 1200, height: 800 });
    assert.deepStrictEqual(pngSize(await docxPng(r, 1)), { width: 600, height: 400 });
  });

  describe('прочие форматы (Review Focus 5)', function () {
    // рамка не равна размеру по умолчанию 600×400: тест падает, если рамка формата не прочитана
    const SMALL = { cx: 2857500, cy: 1905000 }; // 300×200 px
    it('PPTX: рамка a:xfrm/a:ext', async function () {
      const r = await renderAny(await buildPptx([pptxPic('{d.c:chart}', SMALL)]), 'pptx', { c: BAR_VALUE });
      const slide = await r.read('ppt/slides/slide1.xml');
      const rels = await r.read('ppt/slides/_rels/slide1.xml.rels');
      const t = target(rels, attrOf(tags(slide, 'a:blip')[0], 'r:embed'));
      assert.deepStrictEqual(pngSize(Buffer.from(await r.read('ppt/' + t.slice(3), true))), { width: 600, height: 400 });
      assertWellFormed(slide);
    });
    it('XLSX oneCellAnchor: xdr:ext', async function () {
      const r = await renderAny(await buildXlsx([xlsxPic('{d.c:chart}', SMALL)]), 'xlsx', { c: BAR_VALUE, title: 'Отчёт' });
      const drawingXml = await r.read('xl/drawings/drawing1.xml');
      const t = target(await r.read('xl/drawings/_rels/drawing1.xml.rels'), attrOf(tags(drawingXml, 'a:blip')[0], 'r:embed'));
      assert.deepStrictEqual(pngSize(Buffer.from(await r.read('xl/' + t.slice(3), true))), { width: 600, height: 400 });
      assert.deepStrictEqual(tags(drawingXml, 'xdr:ext'), ['<xdr:ext cx="2857500" cy="1905000"/>']);
    });
    it('XLSX twoCellAnchor: размер — a:xfrm картинки, from/to не меняются', async function () {
      const r = await renderAny(await buildXlsx([xlsxPic('{d.c:chart}', Object.assign({ anchor: 'twoCellAnchor' }, SMALL))]), 'xlsx', { c: BAR_VALUE, title: 'Отчёт' });
      const drawingXml = await r.read('xl/drawings/drawing1.xml');
      const t = target(await r.read('xl/drawings/_rels/drawing1.xml.rels'), attrOf(tags(drawingXml, 'a:blip')[0], 'r:embed'));
      assert.deepStrictEqual(pngSize(Buffer.from(await r.read('xl/' + t.slice(3), true))), { width: 600, height: 400 });
      assert.ok(drawingXml.includes('<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>'), drawingXml);
    });
    it('ODT: рамка 6×4 см → 227×151 px, PNG 454×302, ширина рамки сохранена', async function () {
      const r = await renderAny(await buildOdf('odt', '<text:p>' + odfFrame({ w: '6cm', h: '4cm', desc: '{d.c:chart}' }) + '</text:p>'), 'odt', { c: BAR_VALUE });
      const content = await r.read('content.xml');
      assert.strictEqual(attrOf(tags(content, 'draw:image')[0], 'xlink:href'), 'Pictures/cr-img-1.png');
      assert.deepStrictEqual(pngSize(Buffer.from(await r.read('Pictures/cr-img-1.png', true))), { width: 454, height: 302 });
      const frame = tags(content, 'draw:frame')[0];
      assert.strictEqual(attrOf(frame, 'svg:width'), '6cm');
      assert.ok(Math.abs(parseFloat(attrOf(frame, 'svg:height')) - 4) < 0.01, frame);
    });
    it('ODS (svg:title в table:shapes) и ODP', async function () {
      const ods = await renderAny(await buildOdf('ods', odsBody(odfFrame({ title: '{d.c:chart}' }), 'x')), 'ods', { c: BAR_VALUE });
      assert.ok(ods.names.includes('Pictures/cr-img-1.png'), ods.names.join(','));
      assert.deepStrictEqual(pngSize(Buffer.from(await ods.read('Pictures/cr-img-1.png', true))), { width: 302, height: 302 });
      const odp = await renderAny(await buildOdf('odp', odpBody(odfFrame({ title: '{d.c:chart}' }))), 'odp', { c: BAR_VALUE });
      assert.ok(odp.names.includes('Pictures/cr-img-1.png'), odp.names.join(','));
    });
  });
});
