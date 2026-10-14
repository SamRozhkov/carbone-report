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
    // рамка меньше 100 px или больше 4000 px зажимается (R3)
    const d = echartsRender.render(echartsRender.parse({ option: BAR }), { width: 10, height: 5000 });
    assert.deepStrictEqual(pngSize(d.buffer), { width: 200, height: 8000 });
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
