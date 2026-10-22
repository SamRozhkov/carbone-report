import { describe, expect, it } from 'vitest';
import {
  buildChartOption,
  ChartDataError,
  chartLabel,
  chartLimitError,
  chartNumberFormatter,
  chartValue,
  formatChartNumber,
  reviveChartFormatters,
  TemplateChart,
  TemplateChartList,
  type TemplateChart as Chart,
} from './charts';
import { createTranslator } from './i18n/server';

/** Сообщение zod по-русски: ключ `v:…` — из каталога validation. */
const ruMessage = (i: { message: string; params?: Record<string, unknown> }) =>
  i.message.startsWith('v:')
    ? createTranslator('ru')(`validation:${i.message.slice(2)}`, i.params)
    : i.message;

const NB = ' ';
const FMT = `cr:number:${JSON.stringify({ decimals: null, thousands: false, suffix: '' })}`;
const base = (over: Partial<Chart> = {}): Chart =>
  TemplateChart.parse({
    key: 'sales',
    query: 'orders',
    type: 'bar',
    category: 'month',
    series: [{ column: 'total' }],
    ...over,
  });
const ROWS = [
  { month: 'Янв', total: 10, cnt: '3' },
  { month: 'Фев', total: '25.5', cnt: null },
  { month: 'Мар', total: null, cnt: '1e3' },
];
const issues = (v: unknown) =>
  (TemplateChart.safeParse(v).error?.issues ?? []).map((i) => [
    i.path.join('.'),
    ruMessage(i as never),
  ]);

describe('TemplateChart: схема (§35.3)', () => {
  it('минимальный график — значения по умолчанию', () => {
    expect(base()).toEqual({
      key: 'sales',
      query: 'orders',
      type: 'bar',
      stacked: false,
      smooth: false,
      category: 'month',
      series: [{ column: 'total' }],
      splitBy: null,
      title: '',
      legend: 'bottom',
      labels: false,
      palette: 'default',
      number: { decimals: null, thousands: false, suffix: '' },
      axisX: '',
      axisY: '',
      axisY2: '',
    });
  });
  it('ключ, цвет, лишние поля, лимиты рядов и строк', () => {
    const ok = { key: 'a', query: 'q', type: 'bar', category: 'c', series: [{ column: 'v' }] };
    expect(issues({ ...ok, key: '1a' })[0]?.[0]).toBe('key');
    expect(issues({ ...ok, key: '__proto__' })[0]?.[0]).toBe('key');
    expect(issues({ ...ok, key: 'a'.repeat(65) })[0]?.[0]).toBe('key');
    expect(issues({ ...ok, series: [{ column: 'v', color: 'red' }] })).toEqual([
      ['series.0.color', 'цвет — #RRGGBB'],
    ]);
    expect(issues({ ...ok, extra: 1 })[0]?.[0]).toBe('');
    expect(issues({ ...ok, series: [] })[0]?.[0]).toBe('series');
    expect(issues({ ...ok, series: Array(21).fill({ column: 'v' }) })[0]?.[0]).toBe('series');
    expect(issues({ ...ok, title: 'x'.repeat(201) })[0]?.[0]).toBe('title');
    expect(issues({ ...ok, number: { decimals: 7 } })[0]?.[0]).toBe('number.decimals');
    expect(issues({ ...ok, number: { suffix: '12345678901' } })[0]?.[0]).toBe('number.suffix');
  });
  it('сочетания полей по типам', () => {
    const ok = { key: 'a', query: 'q', category: 'c', series: [{ column: 'v' }] };
    expect(issues({ ...ok, type: 'pie', stacked: true })).toEqual([
      ['stacked', 'накопление — только у столбцов, линий и областей'],
    ]);
    expect(issues({ ...ok, type: 'bar', smooth: true })).toEqual([
      ['smooth', 'сглаживание — только у линий, областей и комбинированного'],
    ]);
    expect(issues({ ...ok, type: 'bar', series: [{ column: 'v', kind: 'line' }] })).toEqual([
      ['series.0.kind', 'вид и ось ряда — только у комбинированного'],
    ]);
    expect(issues({ ...ok, type: 'pie', series: [{ column: 'v' }, { column: 'w' }] })).toEqual([
      ['series', 'у круговой и кольцевой — ровно один ряд'],
    ]);
    expect(issues({ ...ok, type: 'doughnut', splitBy: 'r' })).toEqual([
      ['splitBy', 'ряды из данных недоступны у круговой и кольцевой'],
    ]);
    expect(
      issues({ ...ok, type: 'bar', splitBy: 'r', series: [{ column: 'v' }, { column: 'w' }] }),
    ).toEqual([['series', 'с рядами из данных — ровно один ряд (колонка значений)']]);
    expect(
      issues({ ...ok, type: 'bar', splitBy: 'r', series: [{ column: 'v', color: '#ff0000' }] }),
    ).toEqual([['series.0.color', 'цвета рядов из данных — из палитры']]);
    expect(issues({ ...ok, type: 'bar', axisY2: 'x' })).toEqual([
      ['axisY2', 'вторая ось — только у комбинированного с рядом на правой оси'],
    ]);
    expect(
      issues({ ...ok, type: 'combo', axisY2: 'Шт.', series: [{ column: 'v', axis: 'right' }] }),
    ).toEqual([]);
  });
  it('TemplateChartList: не больше 20, ключи уникальны', () => {
    const c = { key: 'a', query: 'q', type: 'bar', category: 'c', series: [{ column: 'v' }] };
    expect(
      TemplateChartList.safeParse(
        Array(21)
          .fill(0)
          .map((_, i) => ({ ...c, key: `k${i}` })),
      ).success,
    ).toBe(false);
    const dup = TemplateChartList.safeParse([c, { ...c }]);
    expect(dup.error?.issues.map((i) => [i.path.join('.'), ruMessage(i as never)])).toEqual([
      ['1.key', 'ключ графика «a» повторяется'],
    ]);
  });
});

describe('значения и подписи (§35.4, Review Focus 1)', () => {
  it('числа: число, строка Postgres numeric; иначе null', () => {
    expect(chartValue(10)).toBe(10);
    expect(chartValue('-3')).toBe(-3);
    expect(chartValue('25.5')).toBe(25.5);
    expect(chartValue('1e3')).toBe(1000);
    expect(chartValue('12345678901234567890.5')).toBe(Number('12345678901234567890.5'));
    for (const v of [
      null,
      undefined,
      '',
      '1 234',
      '1,5',
      'abc',
      '1e400',
      Infinity,
      NaN,
      true,
      {},
    ]) {
      expect(chartValue(v), String(v)).toBeNull();
    }
  });
  it('подписи: строка; дата и дата-время — ДД.ММ.ГГГГ (R5); null — пусто', () => {
    expect(chartLabel('Янв')).toBe('Янв');
    expect(chartLabel(5)).toBe('5');
    expect(chartLabel('2026-01-10')).toBe('10.01.2026');
    expect(chartLabel('2026-01-10T21:30:00.000Z')).toBe('10.01.2026');
    expect(chartLabel(new Date('2026-01-10T21:30:00.000Z'))).toBe('10.01.2026');
    expect(chartLabel(null)).toBe('');
    expect(chartLabel(undefined)).toBe('');
  });
});

describe('buildChartOption (§35.4)', () => {
  it('bar: категории, числа-строки, пропуски; формат чисел на осях, подписях и подсказке', () => {
    expect(
      buildChartOption(base({ labels: true, series: [{ column: 'total', name: 'Сумма' }] }), ROWS),
    ).toEqual({
      type: 'echarts@v5',
      option: {
        color: [
          '#5470c6',
          '#91cc75',
          '#fac858',
          '#ee6666',
          '#73c0de',
          '#3ba272',
          '#fc8452',
          '#9a60b4',
          '#ea7ccc',
        ],
        tooltip: { trigger: 'axis', valueFormatter: FMT },
        legend: { bottom: 8 },
        grid: { containLabel: true, left: 16, right: 16, top: 16, bottom: 40 },
        xAxis: { type: 'category', data: ['Янв', 'Фев', 'Мар'] },
        yAxis: { type: 'value', axisLabel: { formatter: FMT } },
        series: [
          {
            type: 'bar',
            name: 'Сумма',
            data: [10, 25.5, null],
            label: { show: true, position: 'top', formatter: FMT },
          },
        ],
      },
    });
  });
  it('barHorizontal: оси поменяны, категории сверху вниз, названия осей (R6)', () => {
    const o = buildChartOption(
      base({ type: 'barHorizontal', axisX: 'Сумма', axisY: 'Месяц' }),
      ROWS,
    ).option;
    expect(o.xAxis).toEqual({
      type: 'value',
      axisLabel: { formatter: FMT },
      name: 'Сумма',
      nameLocation: 'middle',
      nameGap: 28,
    });
    expect(o.yAxis).toEqual({
      type: 'category',
      data: ['Янв', 'Фев', 'Мар'],
      inverse: true,
      name: 'Месяц',
      nameLocation: 'middle',
      nameGap: 48,
    });
  });
  it('line/area: smooth, stack, areaStyle, цвет ряда, имя по колонке', () => {
    const line = buildChartOption(
      base({
        type: 'line',
        smooth: true,
        stacked: true,
        series: [{ column: 'total', color: '#123456' }],
      }),
      ROWS,
    ).option;
    expect(line.series).toEqual([
      {
        type: 'line',
        name: 'total',
        data: [10, 25.5, null],
        stack: 'total',
        smooth: true,
        itemStyle: { color: '#123456' },
      },
    ]);
    const area = buildChartOption(base({ type: 'area' }), ROWS).option;
    expect((area.series as Record<string, unknown>[])[0]).toMatchObject({
      type: 'line',
      areaStyle: {},
    });
  });
  it('pie и doughnut: радиус, точки без null, подписи «имя: значение»', () => {
    const pie = buildChartOption(base({ type: 'pie', labels: true }), ROWS).option;
    expect(pie.series).toEqual([
      {
        type: 'pie',
        name: 'total',
        radius: '70%',
        center: ['50%', '50%'],
        data: [
          { name: 'Янв', value: 10 },
          { name: 'Фев', value: 25.5 },
        ],
        label: { show: true, formatter: FMT },
      },
    ]);
    expect(pie.tooltip).toEqual({ trigger: 'item', valueFormatter: FMT });
    expect(pie.xAxis).toBeUndefined();
    const doughnut = buildChartOption(base({ type: 'doughnut', legend: 'right' }), ROWS).option;
    expect((doughnut.series as Record<string, unknown>[])[0]).toMatchObject({
      radius: ['40%', '70%'],
      center: ['40%', '50%'],
    });
  });
  it('combo: вид рядов, правая ось и её название', () => {
    const o = buildChartOption(
      base({
        type: 'combo',
        axisY: 'Сумма',
        axisY2: 'Шт.',
        series: [{ column: 'total' }, { column: 'cnt', kind: 'line', axis: 'right' }],
      }),
      ROWS,
    ).option;
    expect(o.yAxis).toEqual([
      {
        type: 'value',
        axisLabel: { formatter: FMT },
        name: 'Сумма',
        nameLocation: 'middle',
        nameGap: 48,
      },
      {
        type: 'value',
        axisLabel: { formatter: FMT },
        name: 'Шт.',
        nameLocation: 'middle',
        nameGap: 48,
      },
    ]);
    expect(o.series).toEqual([
      { type: 'bar', name: 'total', data: [10, 25.5, null] },
      { type: 'line', name: 'cnt', data: [3, null, 1000], yAxisIndex: 1 },
    ]);
  });
  it('splitBy: категории и ряды по первому появлению, пропуск — null, повтор — последняя строка', () => {
    const rows = [
      { m: 'Янв', r: 'Север', v: 1 },
      { m: 'Янв', r: 'Юг', v: 2 },
      { m: 'Фев', r: 'Юг', v: 3 },
      { m: 'Фев', r: 'Юг', v: 4 },
    ];
    const o = buildChartOption(
      base({ category: 'm', splitBy: 'r', series: [{ column: 'v' }] }),
      rows,
    ).option;
    expect(o.xAxis).toEqual({ type: 'category', data: ['Янв', 'Фев'] });
    expect(o.series).toEqual([
      { type: 'bar', name: 'Север', data: [1, null] },
      { type: 'bar', name: 'Юг', data: [2, 4] },
    ]);
  });
  it('splitBy: больше 20 рядов — ошибка отчёта', () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ m: 'Янв', r: `р${i}`, v: i }));
    expect(() =>
      buildChartOption(base({ category: 'm', splitBy: 'r', series: [{ column: 'v' }] }), rows),
    ).toThrow(new ChartDataError('график sales: больше 20 рядов'));
  });
  it('нет колонки — ошибка с ключом графика; пустой результат — пустой график (Review Focus 1)', () => {
    expect(() => buildChartOption(base({ series: [{ column: 'totl' }] }), ROWS)).toThrow(
      new ChartDataError('график sales: нет колонки totl'),
    );
    const empty = buildChartOption(base(), []).option;
    expect(empty.xAxis).toEqual({ type: 'category', data: [] });
    expect(empty.series).toEqual([{ type: 'bar', name: 'total', data: [] }]);
  });
  it('заголовок, легенда сверху и палитра', () => {
    const o = buildChartOption(
      base({ title: 'Продажи', legend: 'top', palette: 'mono' }),
      ROWS,
    ).option;
    expect(o.title).toEqual({ text: 'Продажи', left: 'center' });
    expect(o.legend).toEqual({ top: 32 });
    expect(o.grid).toMatchObject({ top: 68 });
    expect((o.color as string[])[0]).toBe('#08306b');
    expect(buildChartOption(base({ legend: 'none' }), ROWS).option.legend).toEqual({ show: false });
  });
});

describe('формат чисел (R4; те же примеры — packages/carbone/test/test.ee-echarts.js)', () => {
  const CASES: [number, { decimals: number | null; thousands: boolean; suffix: string }, string][] =
    [
      [1234.5, { decimals: null, thousands: false, suffix: '' }, '1234,5'],
      [1234.5, { decimals: 2, thousands: true, suffix: '₽' }, `1${NB}234,50${NB}₽`],
      [-1234567, { decimals: 0, thousands: true, suffix: '' }, `-1${NB}234${NB}567`],
      [0.125, { decimals: 1, thousands: false, suffix: '%' }, `0,1${NB}%`],
      [1e21, { decimals: null, thousands: true, suffix: '' }, '1e+21'],
      [12, { decimals: 3, thousands: false, suffix: 'шт.' }, `12,000${NB}шт.`],
    ];
  it.each(CASES)('%s %j → %j', (v, f, want) => {
    expect(formatChartNumber(v, f)).toBe(want);
  });
  it('chartNumberFormatter: число, подпись, круговая, массив; не маркер — null', () => {
    const fn = chartNumberFormatter('cr:number:{"decimals":2,"thousands":true,"suffix":"₽"}')!;
    expect(fn(1234.5)).toBe(`1${NB}234,50${NB}₽`);
    expect(fn({ seriesType: 'bar', value: 10 })).toBe(`10,00${NB}₽`);
    expect(fn({ seriesType: 'pie', name: 'Север', value: 10 })).toBe(`Север: 10,00${NB}₽`);
    expect(fn({ seriesType: 'line', value: ['Янв', 7] })).toBe(`7,00${NB}₽`);
    for (const ref of [
      '{c} ₽',
      'cr:number:{',
      'cr:number:{"decimals":7}',
      'cr:number:{"suffix":"12345678901"}',
      5,
    ]) {
      expect(chartNumberFormatter(ref)).toBeNull();
    }
  });
  it('reviveChartFormatters: маркеры → функции, __proto__ отброшен, исходник не меняется', () => {
    const option = JSON.parse(
      `{"__proto__":{"x":1},"yAxis":{"axisLabel":{"formatter":${JSON.stringify(FMT)}}},"title":{"formatter":"{b}"}}`,
    );
    const out = reviveChartFormatters(option) as {
      yAxis: { axisLabel: { formatter: (v: number) => string } };
      title: { formatter: string };
      x?: number;
    };
    expect(out.yAxis.axisLabel.formatter(1234.5)).toBe('1234,5');
    expect(out.title.formatter).toBe('{b}');
    expect(out.x).toBeUndefined();
    expect(typeof option.yAxis.axisLabel.formatter).toBe('string');
  });
});

describe('chartLimitError: лимиты движка (§35.2, R9; тексты — packages/carbone/lib/echarts-render.js)', () => {
  const value = (option: Record<string, unknown>) => ({ type: 'echarts@v5' as const, option });
  const series = (n: number, points: number) =>
    Array.from({ length: n }, () => ({
      type: 'line',
      data: Array.from({ length: points }, (_, i) => i),
    }));
  it('в пределах лимитов — null', () => {
    expect(chartLimitError(buildChartOption(base(), ROWS))).toBeNull();
    expect(chartLimitError(value({ series: series(20, 500) }))).toBeNull();
    expect(chartLimitError(value({ series: { type: 'bar', data: [1] } }))).toBeNull();
  });
  it('больше 20 рядов', () => {
    expect(chartLimitError(value({ series: series(21, 1) }))).toBe('в графике больше 20 рядов');
  });
  it('больше 10 000 точек: series.data и dataset.source (массив и объект колонок)', () => {
    expect(chartLimitError(value({ series: series(2, 5001) }))).toBe(
      'в графике больше 10 000 точек',
    );
    expect(
      chartLimitError(
        value({
          dataset: { source: Array.from({ length: 10001 }, (_, i) => [i]) },
          series: [{ type: 'bar' }],
        }),
      ),
    ).toBe('в графике больше 10 000 точек');
    expect(
      chartLimitError(
        value({
          dataset: [{ source: { x: Array(6000).fill(1), y: Array(5000).fill(1) } }],
          series: { type: 'bar' },
        }),
      ),
    ).toBe('в графике больше 10 000 точек');
    expect(chartLimitError(value({ series: series(1, 10000) }))).toBeNull();
  });
  it('описание больше 1 МБ (байты UTF-8)', () => {
    expect(chartLimitError(value({ series: [], pad: 'я'.repeat(600000) }))).toBe(
      'описание графика больше 1 МБ',
    );
    expect(chartLimitError(value({ series: [], pad: 'x'.repeat(1024 * 1000) }))).toBeNull();
  });
  it('график конструктора по 10 001 строке — ошибка точек', () => {
    const rows = Array.from({ length: 10001 }, (_, i) => ({ month: `m${i}`, total: i }));
    expect(chartLimitError(buildChartOption(base(), rows))).toBe('в графике больше 10 000 точек');
  });
});
