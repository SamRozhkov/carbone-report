import {
  buildChartOption,
  type ChartSeries,
  type ChartType,
  type ChartValue,
  MAX_CHART_SERIES,
  MAX_TEMPLATE_CHARTS,
  type RunQueryResult,
  type TemplateAdminDetails,
  type TemplateChart,
} from '@carbone-reports/shared';
import { CircleExclamation, Copy, Play, Plus, TrashBin } from '@gravity-ui/icons';
import {
  Button,
  Card,
  Checkbox,
  Icon,
  Label,
  Loader,
  Select,
  Text,
  TextInput,
  useToaster,
} from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { api } from '../../../api/endpoints';
import { fieldErrors } from '../../../api/errors';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import { useCopy } from '../../../components/useCopy';
import { pickParams } from '../../../lib/params';
import type { TabProps } from './editorState';
import { applyTemplate } from './editorState';

// ECharts — отдельный чанк: загружается при первом предпросмотре на этой вкладке (§35.5).
const ChartPreview = lazy(() =>
  import('./ChartPreview').then((m) => ({ default: m.ChartPreview })),
);

const TYPE_OPTIONS: { value: ChartType; content: string }[] = [
  { value: 'bar', content: 'Столбцы' },
  { value: 'barHorizontal', content: 'Горизонтальные столбцы' },
  { value: 'line', content: 'Линии' },
  { value: 'area', content: 'Области' },
  { value: 'pie', content: 'Круговая' },
  { value: 'doughnut', content: 'Кольцевая' },
  { value: 'combo', content: 'Комбинированная' },
];
const LEGEND_OPTIONS = [
  { value: 'bottom', content: 'Снизу' },
  { value: 'top', content: 'Сверху' },
  { value: 'right', content: 'Справа' },
  { value: 'none', content: 'Нет' },
];
const PALETTE_OPTIONS = [
  { value: 'default', content: 'Стандартная' },
  { value: 'contrast', content: 'Контрастная' },
  { value: 'pastel', content: 'Пастельная' },
  { value: 'mono', content: 'Оттенки синего' },
];
const DECIMALS_OPTIONS = [
  { value: '', content: 'как есть' },
  ...[0, 1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), content: String(n) })),
];
const STACKABLE: ChartType[] = ['bar', 'barHorizontal', 'line', 'area'];
const SMOOTHABLE: ChartType[] = ['line', 'area', 'combo'];
const isPie = (t: ChartType) => t === 'pie' || t === 'doughnut';

export const chartTag = (key: string) => `{d.charts.${key}:chart}`;

export function newChart(key: string, query: string): TemplateChart {
  return {
    key,
    query,
    type: 'bar',
    stacked: false,
    smooth: false,
    category: '',
    series: [{ column: '' }],
    splitBy: null,
    title: '',
    legend: 'bottom',
    labels: false,
    palette: 'default',
    number: { decimals: null, thousands: false, suffix: '' },
    axisX: '',
    axisY: '',
    axisY2: '',
  };
}

interface Draft {
  id: number;
  chart: TemplateChart;
}

/** Сравнение без учёта порядка ключей: jsonb в Postgres хранит ключи в своём порядке. */
const canon = (charts: TemplateChart[]) =>
  JSON.stringify(charts, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** Пустые необязательные поля ряда не хранятся. */
function cleanSeries(s: ChartSeries): ChartSeries {
  const out: ChartSeries = { column: s.column };
  if (s.name) out.name = s.name;
  if (s.color) out.color = s.color;
  if (s.kind) out.kind = s.kind;
  if (s.axis) out.axis = s.axis;
  return out;
}

/** Смена типа: поля, недопустимые для нового типа, сбрасываются (§35.3). */
function withType(c: TemplateChart, type: ChartType): TemplateChart {
  const pie = isPie(type);
  return {
    ...c,
    type,
    stacked: STACKABLE.includes(type) ? c.stacked : false,
    smooth: SMOOTHABLE.includes(type) ? c.smooth : false,
    splitBy: pie ? null : c.splitBy,
    axisY2: type === 'combo' ? c.axisY2 : '',
    series: (pie ? c.series.slice(0, 1) : c.series).map((s) =>
      cleanSeries(type === 'combo' ? s : { ...s, kind: undefined, axis: undefined }),
    ),
  };
}

function ColumnSelect({
  label,
  value,
  columns,
  known,
  empty,
  onChange,
}: {
  label: string;
  value: string;
  columns: string[];
  /** Запрос выполнялся — колонки известны. */
  known: boolean;
  /** Подпись пустого варианта; без неё колонка обязательна. */
  empty?: string;
  onChange: (v: string) => void;
}) {
  const missing = known && value !== '' && !columns.includes(value);
  const options = [
    ...(empty !== undefined ? [{ value: '', content: empty }] : []),
    ...columns.map((c) => ({ value: c, content: c })),
    ...(value !== '' && !columns.includes(value)
      ? [{ value, content: missing ? `${value} (нет в результате)` : value }]
      : []),
  ];
  return (
    <div className="cr-stack">
      <Select
        aria-label={label}
        value={value === '' && empty === undefined ? [] : [value]}
        options={options}
        onUpdate={([v]) => onChange(v ?? '')}
        placeholder="колонка"
        width="max"
      />
      {missing && <Text color="danger">Колонки «{value}» нет в результате запроса</Text>}
    </div>
  );
}

export function ChartsTab({ template, testParams }: TabProps) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const copy = useCopy();
  const nextId = useRef(0);
  const makeDrafts = (t: TemplateAdminDetails): Draft[] =>
    t.charts.map((chart) => ({ id: nextId.current++, chart }));
  const [baseline, setBaseline] = useState(template);
  const [drafts, setDrafts] = useState<Draft[]>(() => makeDrafts(template));
  const [selectedId, setSelectedId] = useState<number | undefined>(drafts[0]?.id);
  const [runs, setRuns] = useState<Record<string, RunQueryResult>>({});
  const dirty = canon(drafts.map((d) => d.chart)) !== canon(baseline.charts);
  const selectedIdx = Math.max(
    0,
    drafts.findIndex((d) => d.id === selectedId),
  );
  const current = drafts[selectedIdx];
  const listQueries = template.queries.filter((q) => q.mode === 'list');

  const reseed = (t: TemplateAdminDetails) => {
    const next = makeDrafts(t);
    setBaseline(t);
    setDrafts(next);
    setSelectedId(next[Math.min(selectedIdx, next.length - 1)]?.id);
  };
  // Шаблон обновился на сервере: без несохранённых правок подхватываем, иначе сохраняем черновик.
  const stale = template.updatedAt !== baseline.updatedAt;
  if (stale && !dirty) reseed(template);

  // Тот же запуск, что на вкладке «Данные»: SQL сохранённого запроса на тестовых параметрах (§35.5).
  const run = useMutation({
    mutationFn: (key: string) => {
      const q = template.queries.find((x) => x.key === key);
      if (!q) throw new Error(`нет запроса «${key}»`);
      return api.templates.runQuery(template.id, {
        sql: q.sql,
        params: pickParams(template.params, testParams),
      });
    },
    onSuccess: (result, key) => setRuns((prev) => ({ ...prev, [key]: result })),
  });
  const save = useMutation({
    mutationFn: () =>
      api.templates.saveCharts(
        template.id,
        drafts.map((d) => d.chart),
      ),
    onSuccess: (t) => {
      applyTemplate(queryClient, t);
      reseed(t);
      add({ name: `tpl-charts-${Date.now()}`, title: 'Графики сохранены', theme: 'success' });
    },
  });

  const update = (patch: Partial<TemplateChart>) =>
    setDrafts((ds) =>
      ds.map((d, i) => (i === selectedIdx ? { ...d, chart: { ...d.chart, ...patch } } : d)),
    );
  const updateSeries = (n: number, patch: Partial<ChartSeries>) =>
    current &&
    update({
      series: current.chart.series.map((s, i) => (i === n ? cleanSeries({ ...s, ...patch }) : s)),
    });
  const addChart = () => {
    save.reset();
    let n = 1;
    while (drafts.some((d) => d.chart.key === `chart${n}`)) n++;
    const id = nextId.current++;
    setDrafts([...drafts, { id, chart: newChart(`chart${n}`, listQueries[0]?.key ?? '') }]);
    setSelectedId(id);
  };
  const removeChart = () => {
    save.reset();
    const next = drafts.filter((_, i) => i !== selectedIdx);
    setDrafts(next);
    setSelectedId(next[Math.max(0, selectedIdx - 1)]?.id);
  };
  const discard = () => {
    save.reset();
    reseed(template);
  };

  // Ошибки сервера приходят по позиции графика ('0.series.1.column'). «Показанными» считаются только
  // ошибки отрисованных полей: ошибка поля, которого нет на экране (например, '0.series.0.kind' у
  // некомбинированного графика), уходит в общий блок, а не теряется.
  const errors = fieldErrors(save.error);
  const shown: string[] = [];
  const errorOf = (path: string) => {
    const key = `${selectedIdx}.${path}`;
    if (errors[key] !== undefined) shown.push(key);
    return errors[key];
  };
  const withErrors = new Set(Object.keys(errors).map((k) => k.split('.')[0]));

  const result = current ? runs[current.chart.query] : undefined;
  const columns = result?.columns ?? [];
  const preview = useMemo((): { value: ChartValue | null; error: string | null } => {
    if (!current || !result) return { value: null, error: null };
    const c = current.chart;
    if (!c.category || c.series.some((s) => !s.column))
      return { value: null, error: 'Выберите колонку подписей и колонки рядов' };
    try {
      return { value: buildChartOption(c, result.rows), error: null };
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [current, result]);

  const dirtyNote = dirty && (
    <>
      <Text color="warning">Есть несохранённые изменения</Text>
      <Button view="flat" onClick={discard}>
        Отменить
      </Button>
    </>
  );
  const c = current?.chart;

  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 24, alignItems: 'start' }}
    >
      <div className="cr-stack">
        {drafts.map((d, i) => (
          <Button
            key={d.id}
            view={d.id === current?.id ? 'normal' : 'flat'}
            width="max"
            onClick={() => setSelectedId(d.id)}
          >
            {d.chart.key}{' '}
            <Label size="xs">{TYPE_OPTIONS.find((o) => o.value === d.chart.type)?.content}</Label>
            {withErrors.has(String(i)) && (
              <Label size="xs" theme="danger" title="В графике есть ошибки">
                <Icon data={CircleExclamation} size={12} />
                ошибка
              </Label>
            )}
          </Button>
        ))}
        <Button
          view="outlined"
          onClick={addChart}
          disabled={listQueries.length === 0 || drafts.length >= MAX_TEMPLATE_CHARTS}
        >
          <Icon data={Plus} />
          Добавить график
        </Button>
        {listQueries.length === 0 && (
          <Text color="secondary">
            Сначала добавьте запрос «Список строк» на вкладке «Данные» — график строится по его
            строкам.
          </Text>
        )}
      </div>
      <div className="cr-stack">
        {c ? (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
              <Field label="Ключ (в шаблоне — d.charts.ключ)" error={errorOf('key')}>
                <TextInput
                  value={c.key}
                  onUpdate={(v) => update({ key: v })}
                  controlProps={{ 'aria-label': 'Ключ графика' }}
                />
              </Field>
              <Field label="Запрос" error={errorOf('query')}>
                <Select
                  aria-label="Запрос"
                  value={c.query ? [c.query] : []}
                  options={listQueries.map((q) => ({ value: q.key, content: q.key }))}
                  onUpdate={([v]) => v && update({ query: v })}
                  width={200}
                />
              </Field>
              <Field label="Тип" error={errorOf('type')}>
                <Select
                  aria-label="Тип графика"
                  value={[c.type]}
                  options={TYPE_OPTIONS}
                  onUpdate={([v]) =>
                    v && current && update(withType(current.chart, v as ChartType))
                  }
                  width={240}
                />
              </Field>
              <Button view="flat-danger" onClick={removeChart}>
                <Icon data={TrashBin} />
                Удалить график
              </Button>
            </div>
            <Card view="outlined" style={{ padding: 12 }} className="cr-stack">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Text variant="subheader-1">Данные</Text>
                <Button
                  size="s"
                  onClick={() => run.mutate(c.query)}
                  loading={run.isPending}
                  disabled={!c.query}
                >
                  <Icon data={Play} />
                  Выполнить запрос
                </Button>
                {!result && (
                  <Text color="secondary">
                    Колонки появятся после выполнения запроса на тестовых параметрах.
                  </Text>
                )}
              </div>
              <Field label="Подписи (категории)" error={errorOf('category')}>
                <ColumnSelect
                  label="Подписи (категории)"
                  value={c.category}
                  columns={columns}
                  known={!!result}
                  onChange={(v) => update({ category: v })}
                />
              </Field>
              {!isPie(c.type) && (
                <Field
                  label="Ряды из данных (колонка с названиями рядов)"
                  error={errorOf('splitBy')}
                >
                  <ColumnSelect
                    label="Ряды из данных"
                    value={c.splitBy ?? ''}
                    columns={columns}
                    known={!!result}
                    empty="— нет —"
                    onChange={(v) =>
                      update({
                        splitBy: v || null,
                        series: v ? [cleanSeries({ ...c.series[0]!, color: undefined })] : c.series,
                      })
                    }
                  />
                </Field>
              )}
              {c.series.map((s, n) => (
                <div
                  key={n}
                  style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}
                >
                  <Field
                    label={c.splitBy ? 'Значения' : `Ряд ${n + 1}`}
                    error={errorOf(`series.${n}.column`)}
                  >
                    <ColumnSelect
                      label={`Колонка ряда ${n + 1}`}
                      value={s.column}
                      columns={columns}
                      known={!!result}
                      onChange={(v) => updateSeries(n, { column: v })}
                    />
                  </Field>
                  {!c.splitBy && (
                    <Field label="Название" error={errorOf(`series.${n}.name`)}>
                      <TextInput
                        value={s.name ?? ''}
                        placeholder={s.column}
                        onUpdate={(v) => updateSeries(n, { name: v })}
                        controlProps={{ 'aria-label': `Название ряда ${n + 1}` }}
                      />
                    </Field>
                  )}
                  {!c.splitBy && (
                    <Field label="Цвет" error={errorOf(`series.${n}.color`)}>
                      <TextInput
                        value={s.color ?? ''}
                        placeholder="#RRGGBB"
                        onUpdate={(v) => updateSeries(n, { color: v })}
                        controlProps={{ 'aria-label': `Цвет ряда ${n + 1}` }}
                      />
                    </Field>
                  )}
                  {c.type === 'combo' && (
                    <Select
                      aria-label={`Вид ряда ${n + 1}`}
                      value={[s.kind ?? 'bar']}
                      options={[
                        { value: 'bar', content: 'Столбцы' },
                        { value: 'line', content: 'Линия' },
                      ]}
                      onUpdate={([v]) => updateSeries(n, { kind: v as 'bar' | 'line' })}
                    />
                  )}
                  {c.type === 'combo' && (
                    <Select
                      aria-label={`Ось ряда ${n + 1}`}
                      value={[s.axis ?? 'left']}
                      options={[
                        { value: 'left', content: 'Левая ось' },
                        { value: 'right', content: 'Правая ось' },
                      ]}
                      onUpdate={([v]) => updateSeries(n, { axis: v as 'left' | 'right' })}
                    />
                  )}
                  {c.series.length > 1 && (
                    <Button
                      view="flat-danger"
                      aria-label={`Удалить ряд ${n + 1}`}
                      onClick={() => update({ series: c.series.filter((_, i) => i !== n) })}
                    >
                      <Icon data={TrashBin} />
                    </Button>
                  )}
                </div>
              ))}
              {errorOf('series') && <Text color="danger">{errorOf('series')}</Text>}
              {!isPie(c.type) && !c.splitBy && c.series.length < MAX_CHART_SERIES && (
                <Button
                  view="outlined"
                  onClick={() => update({ series: [...c.series, { column: '' }] })}
                >
                  <Icon data={Plus} />
                  Добавить ряд
                </Button>
              )}
            </Card>
            <Card view="outlined" style={{ padding: 12 }} className="cr-stack">
              <Text variant="subheader-1">Оформление</Text>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
                <Field label="Заголовок" error={errorOf('title')}>
                  <TextInput
                    value={c.title}
                    onUpdate={(v) => update({ title: v })}
                    controlProps={{ 'aria-label': 'Заголовок графика' }}
                  />
                </Field>
                <Field label="Легенда">
                  <Select
                    aria-label="Легенда"
                    value={[c.legend]}
                    options={LEGEND_OPTIONS}
                    onUpdate={([v]) => v && update({ legend: v as TemplateChart['legend'] })}
                  />
                </Field>
                <Field label="Палитра">
                  <Select
                    aria-label="Палитра"
                    value={[c.palette]}
                    options={PALETTE_OPTIONS}
                    onUpdate={([v]) => v && update({ palette: v as TemplateChart['palette'] })}
                  />
                </Field>
              </div>
              {!isPie(c.type) && (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
                  <Field label="Ось X" error={errorOf('axisX')}>
                    <TextInput
                      value={c.axisX}
                      onUpdate={(v) => update({ axisX: v })}
                      controlProps={{ 'aria-label': 'Название оси X' }}
                    />
                  </Field>
                  <Field label="Ось Y" error={errorOf('axisY')}>
                    <TextInput
                      value={c.axisY}
                      onUpdate={(v) => update({ axisY: v })}
                      controlProps={{ 'aria-label': 'Название оси Y' }}
                    />
                  </Field>
                  {c.type === 'combo' && (
                    <Field label="Правая ось Y" error={errorOf('axisY2')}>
                      <TextInput
                        value={c.axisY2}
                        onUpdate={(v) => update({ axisY2: v })}
                        controlProps={{ 'aria-label': 'Название правой оси Y' }}
                      />
                    </Field>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'end' }}>
                {STACKABLE.includes(c.type) && (
                  <Checkbox checked={c.stacked} onUpdate={(v) => update({ stacked: v })}>
                    Накопление
                  </Checkbox>
                )}
                {SMOOTHABLE.includes(c.type) && (
                  <Checkbox checked={c.smooth} onUpdate={(v) => update({ smooth: v })}>
                    Сглаживание линий
                  </Checkbox>
                )}
                <Checkbox checked={c.labels} onUpdate={(v) => update({ labels: v })}>
                  Подписи значений
                </Checkbox>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
                <Field label="Знаков после запятой" error={errorOf('number.decimals')}>
                  <Select
                    aria-label="Знаков после запятой"
                    value={[c.number.decimals === null ? '' : String(c.number.decimals)]}
                    options={DECIMALS_OPTIONS}
                    onUpdate={([v]) =>
                      update({ number: { ...c.number, decimals: v ? Number(v) : null } })
                    }
                  />
                </Field>
                <Checkbox
                  checked={c.number.thousands}
                  onUpdate={(v) => update({ number: { ...c.number, thousands: v } })}
                >
                  Разделять тысячи
                </Checkbox>
                <Field label="Суффикс (₽, %, шт.)" error={errorOf('number.suffix')}>
                  <TextInput
                    value={c.number.suffix}
                    onUpdate={(v) => update({ number: { ...c.number, suffix: v } })}
                    controlProps={{ 'aria-label': 'Суффикс чисел' }}
                  />
                </Field>
              </div>
            </Card>
            <Card view="outlined" style={{ padding: 12 }} className="cr-stack">
              <Text variant="subheader-1">Предпросмотр</Text>
              {preview.value ? (
                <Suspense fallback={<Loader />}>
                  <ChartPreview value={preview.value} />
                </Suspense>
              ) : (
                <Text color={preview.error ? 'danger' : 'secondary'}>
                  {preview.error ?? 'Выполните запрос, чтобы увидеть график на тестовых данных.'}
                </Text>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Text variant="code-1">{chartTag(c.key)}</Text>
                <Button
                  size="s"
                  onClick={() => void copy(chartTag(c.key))}
                  aria-label="Скопировать тег"
                >
                  <Icon data={Copy} />
                  Скопировать
                </Button>
              </div>
              <Text color="secondary">
                Вставьте в документ картинку-заглушку, а тег — в её замещающий текст. Размер
                картинки — размер графика.
              </Text>
            </Card>
          </>
        ) : (
          <Text color="secondary">Графиков нет — добавьте первый.</Text>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            view="action"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!dirty}
          >
            Сохранить графики
          </Button>
          {dirty && stale && (
            <Text color="warning">
              Шаблон изменился на сервере — сохранение перезапишет изменения
            </Text>
          )}
          {dirtyNote}
        </div>
        <GeneralError error={save.error} errors={errors} shown={shown} />
        <ErrorAlert error={run.error} />
      </div>
    </div>
  );
}
