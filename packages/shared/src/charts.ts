import { z } from 'zod';

// ---- Графики ECharts: конструктор (§35.3–35.4) ----
// Модуль не импортирует ./index: index реэкспортирует его и использует TemplateChart в TemplateAdminDetails.

const KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const NUMBER_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/;
const NBSP = ' ';

export const MAX_TEMPLATE_CHARTS = 20;
export const MAX_CHART_SERIES = 20;
/** Маркер формата чисел в formatter/valueFormatter (решение R4 плана 2.6.0; движок — lib/echarts-render.js). */
export const CHART_NUMBER_PREFIX = 'cr:number:';

export const ChartType = z.enum([
  'bar',
  'barHorizontal',
  'line',
  'area',
  'pie',
  'doughnut',
  'combo',
]);
export type ChartType = z.infer<typeof ChartType>;
export const ChartLegend = z.enum(['none', 'top', 'bottom', 'right']);
export type ChartLegend = z.infer<typeof ChartLegend>;
export const ChartPalette = z.enum(['default', 'contrast', 'pastel', 'mono']);
export type ChartPalette = z.infer<typeof ChartPalette>;

export const CHART_PALETTES: Record<ChartPalette, string[]> = {
  default: [
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
  contrast: [
    '#1f77b4',
    '#d62728',
    '#2ca02c',
    '#ff7f0e',
    '#9467bd',
    '#8c564b',
    '#e377c2',
    '#17becf',
    '#bcbd22',
    '#7f7f7f',
  ],
  pastel: [
    '#8dd3c7',
    '#bebada',
    '#fb8072',
    '#80b1d3',
    '#fdb462',
    '#b3de69',
    '#fccde5',
    '#bc80bd',
    '#ccebc5',
    '#ffed6f',
  ],
  mono: ['#08306b', '#08519c', '#2171b5', '#4292c6', '#6baed6', '#9ecae1', '#c6dbef'],
};

const Column = z.string().trim().min(1, 'выберите колонку').max(200);

export const ChartKey = z
  .string()
  .regex(KEY_RE, 'ключ: латиница, цифры и _')
  .max(64, 'ключ — до 64 символов')
  .refine((k) => !RESERVED.has(k), 'зарезервированное имя');

export const ChartSeries = z.strictObject({
  column: Column,
  name: z.string().trim().max(100).optional(),
  color: z.string().regex(HEX_RE, 'цвет — #RRGGBB').optional(),
  kind: z.enum(['bar', 'line']).optional(),
  axis: z.enum(['left', 'right']).optional(),
});
export type ChartSeries = z.infer<typeof ChartSeries>;

export const ChartNumberFormat = z.strictObject({
  decimals: z.number().int().min(0).max(6).nullable().default(null),
  thousands: z.boolean().default(false),
  suffix: z.string().max(10).default(''),
});
export type ChartNumberFormat = z.infer<typeof ChartNumberFormat>;

export const TemplateChartFields = z.strictObject({
  query: z.string().min(1, 'выберите запрос'),
  type: ChartType,
  stacked: z.boolean().default(false),
  smooth: z.boolean().default(false),
  category: Column,
  series: z
    .array(ChartSeries)
    .min(1, 'добавьте ряд')
    .max(MAX_CHART_SERIES, `рядов — не больше ${MAX_CHART_SERIES}`),
  splitBy: Column.nullable().default(null),
  title: z.string().trim().max(200).default(''),
  legend: ChartLegend.default('bottom'),
  labels: z.boolean().default(false),
  palette: ChartPalette.default('default'),
  number: ChartNumberFormat.default({ decimals: null, thousands: false, suffix: '' }),
  axisX: z.string().trim().max(100).default(''),
  axisY: z.string().trim().max(100).default(''),
  axisY2: z.string().trim().max(100).default(''),
});

const STACKABLE: readonly ChartType[] = ['bar', 'barHorizontal', 'line', 'area'];
const SMOOTHABLE: readonly ChartType[] = ['line', 'area', 'combo'];
const isPie = (t: ChartType) => t === 'pie' || t === 'doughnut';

export const refineTemplateChart = (
  c: z.infer<typeof TemplateChartFields>,
  ctx: z.RefinementCtx,
): void => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  if (c.stacked && !STACKABLE.includes(c.type))
    issue(['stacked'], 'накопление — только у столбцов, линий и областей');
  if (c.smooth && !SMOOTHABLE.includes(c.type))
    issue(['smooth'], 'сглаживание — только у линий, областей и комбинированного');
  if (c.type !== 'combo')
    c.series.forEach((s, i) => {
      if (s.kind !== undefined || s.axis !== undefined)
        issue(['series', i, 'kind'], 'вид и ось ряда — только у комбинированного');
    });
  if (isPie(c.type)) {
    if (c.series.length !== 1) issue(['series'], 'у круговой и кольцевой — ровно один ряд');
    if (c.splitBy !== null) issue(['splitBy'], 'ряды из данных недоступны у круговой и кольцевой');
  } else if (c.splitBy !== null) {
    if (c.series.length !== 1)
      issue(['series'], 'с рядами из данных — ровно один ряд (колонка значений)');
    c.series.forEach((s, i) => {
      if (s.color !== undefined)
        issue(['series', i, 'color'], 'цвета рядов из данных — из палитры');
    });
  }
  if (c.axisY2 !== '' && !(c.type === 'combo' && c.series.some((s) => s.axis === 'right')))
    issue(['axisY2'], 'вторая ось — только у комбинированного с рядом на правой оси');
};

/** Настройки графика без ключа: так они лежат в `template_charts.config` и в архиве переноса. */
export const TemplateChartConfig = TemplateChartFields.superRefine(refineTemplateChart);
export type TemplateChartConfig = z.infer<typeof TemplateChartConfig>;

export const TemplateChart = TemplateChartFields.extend({ key: ChartKey }).superRefine(
  refineTemplateChart,
);
export type TemplateChart = z.infer<typeof TemplateChart>;

/** Тело `PUT /api/templates/:id/charts`: весь список графиков шаблона. */
export const TemplateChartList = z
  .array(TemplateChart)
  .max(MAX_TEMPLATE_CHARTS, `графиков в шаблоне — не больше ${MAX_TEMPLATE_CHARTS}`)
  .superRefine((charts, ctx) => {
    const seen = new Set<string>();
    charts.forEach((c, i) => {
      if (seen.has(c.key))
        ctx.addIssue({
          code: 'custom',
          path: [i, 'key'],
          message: `ключ графика «${c.key}» повторяется`,
        });
      seen.add(c.key);
    });
  });

// ---- Описание ECharts (§35.4) ----

/** Значение для `{d.charts.<key>:chart}`. */
export interface ChartValue {
  type: 'echarts@v5';
  option: Record<string, unknown>;
}

/** Ошибка данных графика (нет колонки, больше 20 рядов): API отвечает 400 CARBONE_TEMPLATE. */
export class ChartDataError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Значение точки: число; строка-число (Postgres numeric) — число; иначе null (пропуск точки). */
export function chartValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && NUMBER_RE.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Подпись: строка; дата и дата-время (ISO, UTC) — ДД.ММ.ГГГГ без пересчёта пояса (R5); null — пусто. */
export function chartLabel(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s =
    v instanceof Date
      ? Number.isNaN(v.getTime())
        ? ''
        : v.toISOString()
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);
  const m = DATE_RE.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
}

/** Формат чисел конструктора — для подписей, осей и подсказок (R4). Та же логика — echarts-render.js. */
export function formatChartNumber(v: number, f: ChartNumberFormat): string {
  const fixed = f.decimals === null ? String(v) : v.toFixed(f.decimals);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(fixed);
  let text = fixed;
  if (m) {
    const int = f.thousands ? m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) : m[2]!;
    text = m[1]! + int + (m[3] !== undefined ? `,${m[3]}` : '');
  }
  return f.suffix ? text + NBSP + f.suffix : text;
}

/** Маркер формата для JSON-описания: функции через JSON не проходят. */
export const chartNumberRef = (f: ChartNumberFormat): string =>
  CHART_NUMBER_PREFIX +
  JSON.stringify({ decimals: f.decimals, thousands: f.thousands, suffix: f.suffix });

/** Функция по маркеру `cr:number:{…}` (число или параметры подписи ECharts) или null. */
export function chartNumberFormatter(ref: unknown): ((x: unknown) => string) | null {
  if (typeof ref !== 'string' || !ref.startsWith(CHART_NUMBER_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(ref.slice(CHART_NUMBER_PREFIX.length));
  } catch {
    return null;
  }
  const parsed = ChartNumberFormat.safeParse(raw);
  if (!parsed.success) return null;
  const f = parsed.data;
  return (x) => {
    if (typeof x === 'number') return formatChartNumber(x, f);
    if (isRecord(x)) {
      const value = Array.isArray(x.value) ? x.value[x.value.length - 1] : x.value;
      const text =
        typeof value === 'number'
          ? formatChartNumber(value, f)
          : value === null || value === undefined
            ? ''
            : String(value);
      return x.seriesType === 'pie' ? `${x.name == null ? '' : String(x.name)}: ${text}` : text;
    }
    return x === null || x === undefined ? '' : String(x);
  };
}

/** Копия описания: маркеры формата → функции (предпросмотр в браузере), `__proto__` отброшен. */
export function reviveChartFormatters<T>(option: T): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth >= 64) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (!isRecord(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__') continue;
      const fn = k === 'formatter' || k === 'valueFormatter' ? chartNumberFormatter(x) : null;
      out[k] = fn ?? walk(x, depth + 1);
    }
    return out;
  };
  return walk(option, 0) as T;
}

interface SeriesData {
  name: string;
  values: (number | null)[];
  source: ChartSeries;
}

function requireColumns(chart: TemplateChart, rows: Record<string, unknown>[]): void {
  const first = rows[0];
  if (!first) return;
  const columns = [
    chart.category,
    ...chart.series.map((s) => s.column),
    ...(chart.splitBy ? [chart.splitBy] : []),
  ];
  for (const c of columns)
    if (!Object.hasOwn(first, c)) throw new ChartDataError(`график ${chart.key}: нет колонки ${c}`);
}

function plainData(chart: TemplateChart, rows: Record<string, unknown>[]) {
  return {
    categories: rows.map((r) => chartLabel(r[chart.category])),
    series: chart.series.map((s): SeriesData => ({
      name: s.name || s.column,
      values: rows.map((r) => chartValue(r[s.column])),
      source: s,
    })),
  };
}

/** «Ряды из данных»: категории и ряды по первому появлению, пропуск — null, повтор пары — последняя строка. */
function splitData(chart: TemplateChart, rows: Record<string, unknown>[]) {
  const s = chart.series[0]!;
  const by = chart.splitBy!;
  const categories: string[] = [];
  const catIndex = new Map<string, number>();
  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  const cells = new Map<string, number | null>();
  for (const r of rows) {
    const c = chartLabel(r[chart.category]);
    if (!catIndex.has(c)) {
      catIndex.set(c, categories.length);
      categories.push(c);
    }
    const n = chartLabel(r[by]);
    if (!nameIndex.has(n)) {
      if (names.length >= MAX_CHART_SERIES)
        throw new ChartDataError(`график ${chart.key}: больше ${MAX_CHART_SERIES} рядов`);
      nameIndex.set(n, names.length);
      names.push(n);
    }
    cells.set(`${catIndex.get(c)}:${nameIndex.get(n)}`, chartValue(r[s.column]));
  }
  return {
    categories,
    series: names.map((name, si): SeriesData => ({
      name,
      values: categories.map((_, ci) => cells.get(`${ci}:${si}`) ?? null),
      source: s,
    })),
  };
}

function legendOf(chart: TemplateChart): Record<string, unknown> {
  switch (chart.legend) {
    case 'none':
      return { show: false };
    case 'top':
      return { top: chart.title ? 32 : 8 };
    case 'right':
      return { right: 8, top: 'middle', orient: 'vertical' };
    default:
      return { bottom: 8 };
  }
}

const named = (name: string, gap: number) =>
  name ? { name, nameLocation: 'middle', nameGap: gap } : {};

function axesOf(chart: TemplateChart, categories: string[], fmt: string) {
  const grid = {
    containLabel: true,
    left: 16,
    right: chart.legend === 'right' ? 140 : 16,
    top: (chart.title ? 40 : 16) + (chart.legend === 'top' ? 28 : 0),
    bottom: chart.legend === 'bottom' ? 40 : 16,
  };
  const value = (name: string, gap: number) => ({
    type: 'value',
    axisLabel: { formatter: fmt },
    ...named(name, gap),
  });
  if (chart.type === 'barHorizontal') {
    return {
      grid,
      xAxis: value(chart.axisX, 28),
      yAxis: { type: 'category', data: categories, inverse: true, ...named(chart.axisY, 48) },
    };
  }
  const right = chart.type === 'combo' && chart.series.some((s) => s.axis === 'right');
  return {
    grid,
    xAxis: { type: 'category', data: categories, ...named(chart.axisX, 28) },
    yAxis: right ? [value(chart.axisY, 48), value(chart.axisY2, 48)] : value(chart.axisY, 48),
  };
}

function cartesianSeries(chart: TemplateChart, s: SeriesData, fmt: string) {
  const kind =
    chart.type === 'combo'
      ? (s.source.kind ?? 'bar')
      : chart.type === 'line' || chart.type === 'area'
        ? 'line'
        : 'bar';
  const out: Record<string, unknown> = { type: kind, name: s.name, data: s.values };
  if (chart.stacked) out.stack = 'total';
  if (kind === 'line' && chart.smooth) out.smooth = true;
  if (chart.type === 'area') out.areaStyle = {};
  if (chart.type === 'combo' && s.source.axis === 'right') out.yAxisIndex = 1;
  if (s.source.color && chart.splitBy === null) out.itemStyle = { color: s.source.color };
  if (chart.labels)
    out.label = {
      show: true,
      position: chart.type === 'barHorizontal' ? 'right' : 'top',
      formatter: fmt,
    };
  return out;
}

function pieSeries(
  chart: TemplateChart,
  data: { categories: string[]; series: SeriesData[] },
  fmt: string,
) {
  const s = data.series[0]!;
  const out: Record<string, unknown> = {
    type: 'pie',
    name: s.name,
    radius: chart.type === 'doughnut' ? ['40%', '70%'] : '70%',
    center: chart.legend === 'right' ? ['40%', '50%'] : ['50%', '50%'],
    data: data.categories.flatMap((name, i) => {
      const value = s.values[i];
      return value === null || value === undefined ? [] : [{ name, value }];
    }),
  };
  if (chart.labels) out.label = { show: true, formatter: fmt };
  return out;
}

/**
 * Описание ECharts графика конструктора по строкам запроса (§35.4): API (отчёт и предпросмотр) и вкладка «Графики».
 * Пустой результат — пустой график; нет колонки и больше 20 рядов из данных — ChartDataError.
 */
export function buildChartOption(chart: TemplateChart, rows: readonly unknown[]): ChartValue {
  const records = rows.filter(isRecord);
  requireColumns(chart, records);
  const data = chart.splitBy ? splitData(chart, records) : plainData(chart, records);
  const fmt = chartNumberRef(chart.number);
  const pie = isPie(chart.type);
  const option: Record<string, unknown> = {
    color: CHART_PALETTES[chart.palette],
    tooltip: { trigger: pie ? 'item' : 'axis', valueFormatter: fmt },
    legend: legendOf(chart),
  };
  if (chart.title) option.title = { text: chart.title, left: 'center' };
  if (pie) option.series = [pieSeries(chart, data, fmt)];
  else {
    Object.assign(option, axesOf(chart, data.categories, fmt));
    option.series = data.series.map((s) => cartesianSeries(chart, s, fmt));
  }
  return { type: 'echarts@v5', option };
}
