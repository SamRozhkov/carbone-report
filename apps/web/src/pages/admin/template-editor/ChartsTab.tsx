import {
  buildChartOption,
  ChartDataError,
  chartLimit,
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
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/endpoints';
import { fieldErrors } from '../../../api/errors';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import { useCopy } from '../../../components/useCopy';
import { useBridgeDirty } from '../../../features/assistant/bridge';
import { pickParams } from '../../../lib/params';
import type { TabProps } from './editorState';
import { applyTemplate } from './editorState';

// ECharts — отдельный чанк: загружается при первом предпросмотре на этой вкладке (§35.5).
const ChartPreview = lazy(() =>
  import('./ChartPreview').then((m) => ({ default: m.ChartPreview })),
);

// Подписи вариантов — ключи editor:charts.<поле>_<значение>.
const TYPES: ChartType[] = ['bar', 'barHorizontal', 'line', 'area', 'pie', 'doughnut', 'combo'];
const LEGENDS: TemplateChart['legend'][] = ['bottom', 'top', 'right', 'none'];
const PALETTES: TemplateChart['palette'][] = ['default', 'contrast', 'pastel', 'mono'];
const DECIMALS = [0, 1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), content: String(n) }));
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
  const { t } = useTranslation();
  const missing = known && value !== '' && !columns.includes(value);
  const options = [
    ...(empty !== undefined ? [{ value: '', content: empty }] : []),
    ...columns.map((c) => ({ value: c, content: c })),
    ...(value !== '' && !columns.includes(value)
      ? [{ value, content: missing ? t('editor:charts.columnMissing', { column: value }) : value }]
      : []),
  ];
  return (
    <div className="cr-stack">
      <Select
        aria-label={label}
        value={value === '' && empty === undefined ? [] : [value]}
        options={options}
        onUpdate={([v]) => onChange(v ?? '')}
        placeholder={t('editor:charts.columnPlaceholder')}
        width="max"
      />
      {missing && (
        <Text color="danger">{t('editor:charts.columnNotInResult', { column: value })}</Text>
      )}
    </div>
  );
}

export function ChartsTab({ template, testParams }: TabProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const copy = useCopy();
  const nextId = useRef(0);
  const makeDrafts = (tpl: TemplateAdminDetails): Draft[] =>
    tpl.charts.map((chart) => ({ id: nextId.current++, chart }));
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

  const reseed = (tpl: TemplateAdminDetails) => {
    const next = makeDrafts(tpl);
    setBaseline(tpl);
    setDrafts(next);
    setSelectedId(next[Math.min(selectedIdx, next.length - 1)]?.id);
  };
  // Шаблон обновился на сервере: без несохранённых правок подхватываем, иначе сохраняем черновик.
  const stale = template.updatedAt !== baseline.updatedAt;
  if (stale && !dirty) reseed(template);
  useBridgeDirty(dirty);

  // Тот же запуск, что на вкладке «Данные»: SQL сохранённого запроса на тестовых параметрах (§35.5).
  const run = useMutation({
    mutationFn: (key: string) => {
      const q = template.queries.find((x) => x.key === key);
      if (!q) throw new Error(t('editor:charts.noQuery', { key }));
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
    onSuccess: (tpl) => {
      applyTemplate(queryClient, tpl);
      reseed(tpl);
      add({ name: `tpl-charts-${Date.now()}`, title: t('editor:charts.saved'), theme: 'success' });
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
      return { value: null, error: t('editor:charts.chooseColumns') };
    try {
      const value = buildChartOption(c, result.rows);
      // график, который движок отклонит (1 МБ, 20 рядов, 10 000 точек), не показываем
      const limit = chartLimit(value);
      if (limit) return { value: null, error: t(`editor:charts.limit_${limit}`) };
      return { value, error: null };
    } catch (e) {
      // Ошибка данных несёт ключ каталога errors (chart.*): тот же текст есть в editor:charts.*.
      if (e instanceof ChartDataError && e.key?.startsWith('chart.'))
        return {
          value: null,
          error: t(`editor:charts.${e.key.slice('chart.'.length)}`, {
            ...e.params,
            defaultValue: e.message,
          }),
        };
      return { value: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [current, result, t]);

  const dirtyNote = dirty && (
    <>
      <Text color="warning">{t('editor:draft.unsaved')}</Text>
      <Button view="flat" onClick={discard}>
        {t('editor:draft.discard')}
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
            {d.chart.key} <Label size="xs">{t(`editor:charts.type_${d.chart.type}`)}</Label>
            {withErrors.has(String(i)) && (
              <Label size="xs" theme="danger" title={t('editor:charts.hasErrors')}>
                <Icon data={CircleExclamation} size={12} />
                {t('editor:draft.errorBadge')}
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
          {t('editor:charts.add')}
        </Button>
        {listQueries.length === 0 && (
          <Text color="secondary">{t('editor:charts.needListQuery')}</Text>
        )}
      </div>
      <div className="cr-stack">
        {c ? (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
              <Field label={t('editor:charts.key')} error={errorOf('key')}>
                <TextInput
                  value={c.key}
                  onUpdate={(v) => update({ key: v })}
                  controlProps={{ 'aria-label': t('editor:charts.keyAria') }}
                />
              </Field>
              <Field label={t('editor:charts.query')} error={errorOf('query')}>
                <Select
                  aria-label={t('editor:charts.query')}
                  value={c.query ? [c.query] : []}
                  options={listQueries.map((q) => ({ value: q.key, content: q.key }))}
                  onUpdate={([v]) => v && update({ query: v })}
                  width={200}
                />
              </Field>
              <Field label={t('editor:charts.type')} error={errorOf('type')}>
                <Select
                  aria-label={t('editor:charts.typeAria')}
                  value={[c.type]}
                  options={TYPES.map((value) => ({
                    value,
                    content: t(`editor:charts.type_${value}`),
                  }))}
                  onUpdate={([v]) =>
                    v && current && update(withType(current.chart, v as ChartType))
                  }
                  width={240}
                />
              </Field>
              <Button view="flat-danger" onClick={removeChart}>
                <Icon data={TrashBin} />
                {t('editor:charts.remove')}
              </Button>
            </div>
            <Card view="outlined" style={{ padding: 12 }} className="cr-stack">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Text variant="subheader-1">{t('editor:tab.data')}</Text>
                <Button
                  size="s"
                  onClick={() => run.mutate(c.query)}
                  loading={run.isPending}
                  disabled={!c.query}
                >
                  <Icon data={Play} />
                  {t('editor:charts.run')}
                </Button>
                {!result && <Text color="secondary">{t('editor:charts.columnsHint')}</Text>}
              </div>
              <Field label={t('editor:charts.category')} error={errorOf('category')}>
                <ColumnSelect
                  label={t('editor:charts.category')}
                  value={c.category}
                  columns={columns}
                  known={!!result}
                  onChange={(v) => update({ category: v })}
                />
              </Field>
              {!isPie(c.type) && (
                <Field label={t('editor:charts.splitBy')} error={errorOf('splitBy')}>
                  <ColumnSelect
                    label={t('editor:charts.splitByAria')}
                    value={c.splitBy ?? ''}
                    columns={columns}
                    known={!!result}
                    empty={t('editor:charts.none')}
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
                    label={
                      c.splitBy
                        ? t('editor:charts.values')
                        : t('editor:charts.series', { n: n + 1 })
                    }
                    error={errorOf(`series.${n}.column`)}
                  >
                    <ColumnSelect
                      label={t('editor:charts.seriesColumnAria', { n: n + 1 })}
                      value={s.column}
                      columns={columns}
                      known={!!result}
                      onChange={(v) => updateSeries(n, { column: v })}
                    />
                  </Field>
                  {!c.splitBy && (
                    <Field label={t('admin:field.name')} error={errorOf(`series.${n}.name`)}>
                      <TextInput
                        value={s.name ?? ''}
                        placeholder={s.column}
                        onUpdate={(v) => updateSeries(n, { name: v })}
                        controlProps={{
                          'aria-label': t('editor:charts.seriesNameAria', { n: n + 1 }),
                        }}
                      />
                    </Field>
                  )}
                  {!c.splitBy && (
                    <Field label={t('editor:charts.color')} error={errorOf(`series.${n}.color`)}>
                      <TextInput
                        value={s.color ?? ''}
                        placeholder="#RRGGBB"
                        onUpdate={(v) => updateSeries(n, { color: v })}
                        controlProps={{
                          'aria-label': t('editor:charts.seriesColorAria', { n: n + 1 }),
                        }}
                      />
                    </Field>
                  )}
                  {c.type === 'combo' && (
                    <Select
                      aria-label={t('editor:charts.seriesKindAria', { n: n + 1 })}
                      value={[s.kind ?? 'bar']}
                      options={[
                        { value: 'bar', content: t('editor:charts.kind_bar') },
                        { value: 'line', content: t('editor:charts.kind_line') },
                      ]}
                      onUpdate={([v]) => updateSeries(n, { kind: v as 'bar' | 'line' })}
                    />
                  )}
                  {c.type === 'combo' && (
                    <Select
                      aria-label={t('editor:charts.seriesAxisAria', { n: n + 1 })}
                      value={[s.axis ?? 'left']}
                      options={[
                        { value: 'left', content: t('editor:charts.axis_left') },
                        { value: 'right', content: t('editor:charts.axis_right') },
                      ]}
                      onUpdate={([v]) => updateSeries(n, { axis: v as 'left' | 'right' })}
                    />
                  )}
                  {c.series.length > 1 && (
                    <Button
                      view="flat-danger"
                      aria-label={t('editor:charts.seriesRemoveAria', { n: n + 1 })}
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
                  {t('editor:charts.addSeries')}
                </Button>
              )}
            </Card>
            <Card view="outlined" style={{ padding: 12 }} className="cr-stack">
              <Text variant="subheader-1">{t('editor:charts.appearance')}</Text>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
                <Field label={t('editor:charts.title')} error={errorOf('title')}>
                  <TextInput
                    value={c.title}
                    onUpdate={(v) => update({ title: v })}
                    controlProps={{ 'aria-label': t('editor:charts.titleAria') }}
                  />
                </Field>
                <Field label={t('editor:charts.legend')}>
                  <Select
                    aria-label={t('editor:charts.legend')}
                    value={[c.legend]}
                    options={LEGENDS.map((value) => ({
                      value,
                      content: t(`editor:charts.legend_${value}`),
                    }))}
                    onUpdate={([v]) => v && update({ legend: v as TemplateChart['legend'] })}
                  />
                </Field>
                <Field label={t('editor:charts.palette')}>
                  <Select
                    aria-label={t('editor:charts.palette')}
                    value={[c.palette]}
                    options={PALETTES.map((value) => ({
                      value,
                      content: t(`editor:charts.palette_${value}`),
                    }))}
                    onUpdate={([v]) => v && update({ palette: v as TemplateChart['palette'] })}
                  />
                </Field>
              </div>
              {!isPie(c.type) && (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
                  <Field label={t('editor:charts.axisX')} error={errorOf('axisX')}>
                    <TextInput
                      value={c.axisX}
                      onUpdate={(v) => update({ axisX: v })}
                      controlProps={{ 'aria-label': t('editor:charts.axisXAria') }}
                    />
                  </Field>
                  <Field label={t('editor:charts.axisY')} error={errorOf('axisY')}>
                    <TextInput
                      value={c.axisY}
                      onUpdate={(v) => update({ axisY: v })}
                      controlProps={{ 'aria-label': t('editor:charts.axisYAria') }}
                    />
                  </Field>
                  {c.type === 'combo' && (
                    <Field label={t('editor:charts.axisY2')} error={errorOf('axisY2')}>
                      <TextInput
                        value={c.axisY2}
                        onUpdate={(v) => update({ axisY2: v })}
                        controlProps={{ 'aria-label': t('editor:charts.axisY2Aria') }}
                      />
                    </Field>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'end' }}>
                {STACKABLE.includes(c.type) && (
                  <Checkbox checked={c.stacked} onUpdate={(v) => update({ stacked: v })}>
                    {t('editor:charts.stacked')}
                  </Checkbox>
                )}
                {SMOOTHABLE.includes(c.type) && (
                  <Checkbox checked={c.smooth} onUpdate={(v) => update({ smooth: v })}>
                    {t('editor:charts.smooth')}
                  </Checkbox>
                )}
                <Checkbox checked={c.labels} onUpdate={(v) => update({ labels: v })}>
                  {t('editor:charts.labels')}
                </Checkbox>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
                <Field label={t('editor:charts.decimals')} error={errorOf('number.decimals')}>
                  <Select
                    aria-label={t('editor:charts.decimals')}
                    value={[c.number.decimals === null ? '' : String(c.number.decimals)]}
                    options={[{ value: '', content: t('editor:charts.decimalsAsIs') }, ...DECIMALS]}
                    onUpdate={([v]) =>
                      update({ number: { ...c.number, decimals: v ? Number(v) : null } })
                    }
                  />
                </Field>
                <Checkbox
                  checked={c.number.thousands}
                  onUpdate={(v) => update({ number: { ...c.number, thousands: v } })}
                >
                  {t('editor:charts.thousands')}
                </Checkbox>
                <Field label={t('editor:charts.suffix')} error={errorOf('number.suffix')}>
                  <TextInput
                    value={c.number.suffix}
                    onUpdate={(v) => update({ number: { ...c.number, suffix: v } })}
                    controlProps={{ 'aria-label': t('editor:charts.suffixAria') }}
                  />
                </Field>
              </div>
            </Card>
            <Card view="outlined" style={{ padding: 12 }} className="cr-stack">
              <Text variant="subheader-1">{t('editor:tab.preview')}</Text>
              {preview.value ? (
                <Suspense fallback={<Loader />}>
                  <ChartPreview value={preview.value} />
                </Suspense>
              ) : (
                <Text color={preview.error ? 'danger' : 'secondary'}>
                  {preview.error ?? t('editor:charts.previewHint')}
                </Text>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Text variant="code-1">{chartTag(c.key)}</Text>
                <Button
                  size="s"
                  onClick={() => void copy(chartTag(c.key))}
                  aria-label={t('editor:charts.copyTagAria')}
                >
                  <Icon data={Copy} />
                  {t('editor:tags.copy')}
                </Button>
              </div>
              <Text color="secondary">{t('editor:charts.insertHint')}</Text>
            </Card>
          </>
        ) : (
          <Text color="secondary">{t('editor:charts.empty')}</Text>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            view="action"
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!dirty}
          >
            {t('editor:charts.save')}
          </Button>
          {dirty && stale && <Text color="warning">{t('editor:draft.stale')}</Text>}
          {dirtyNote}
        </div>
        <GeneralError error={save.error} errors={errors} shown={shown} />
        <ErrorAlert error={run.error} />
      </div>
    </div>
  );
}
