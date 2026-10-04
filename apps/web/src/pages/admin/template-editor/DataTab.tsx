import type {
  QueryMode,
  RunQueryResult,
  TemplateAdminDetails,
  TemplateQuery,
} from '@carbone-reports/shared';
import { CircleExclamation, Play, Plus, TrashBin } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import {
  Alert,
  Button,
  Card,
  Icon,
  Label,
  SegmentedRadioGroup,
  Table,
  Text,
  TextInput,
  useToaster,
} from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../../../api/endpoints';
import { fieldErrors } from '../../../api/errors';
import { CodeEditor } from '../../../components/CodeEditor';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import { ParamForm } from '../../../components/ParamForm';
import { pickParams } from '../../../lib/params';
import type { TabProps } from './editorState';
import { applyTemplate } from './editorState';

type Row = Record<string, unknown> & { __i: number };
interface Draft extends TemplateQuery {
  id: number;
}

export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const FIELDS = ['key', 'sql', 'mode'] as const;
const strip = (ds: TemplateQuery[]) =>
  JSON.stringify(ds.map((q) => ({ key: q.key, mode: q.mode, sql: q.sql })));

export function DataTab({ template, testParams, onTestParams }: TabProps) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const nextId = useRef(0);
  const makeDrafts = (t: TemplateAdminDetails): Draft[] =>
    t.queries.map((q) => ({ id: nextId.current++, key: q.key, mode: q.mode, sql: q.sql }));
  const [baseline, setBaseline] = useState(template);
  const [drafts, setDrafts] = useState<Draft[]>(() => makeDrafts(template));
  const [selectedId, setSelectedId] = useState<number | undefined>(drafts[0]?.id);
  const dirty = strip(drafts) !== strip(baseline.queries);
  const selectedIdx = Math.max(
    0,
    drafts.findIndex((q) => q.id === selectedId),
  );
  const current = drafts[selectedIdx];

  const reseed = (t: TemplateAdminDetails) => {
    const next = makeDrafts(t);
    setBaseline(t);
    setDrafts(next);
    setSelectedId(next[Math.min(selectedIdx, next.length - 1)]?.id);
  };
  // Шаблон обновился на сервере: без несохранённых правок подхватываем, иначе сохраняем черновик.
  const stale = template.updatedAt !== baseline.updatedAt;
  if (stale && !dirty) reseed(template);

  const run = useMutation({
    mutationFn: (v: { key: string; sql: string }) =>
      api.templates.runQuery(template.id, {
        sql: v.sql,
        params: pickParams(template.params, testParams),
      }),
  });
  const save = useMutation({
    mutationFn: () =>
      api.templates.saveQueries(
        template.id,
        drafts.map(({ key, mode, sql }) => ({ key, mode, sql })),
      ),
    onSuccess: (t) => {
      applyTemplate(queryClient, t);
      reseed(t);
      add({ name: `tpl-queries-${Date.now()}`, title: 'Запросы сохранены', theme: 'success' });
    },
  });

  const select = (id: number) => {
    if (id === current?.id) return;
    run.reset();
    setSelectedId(id);
  };
  const update = (patch: Partial<TemplateQuery>) =>
    setDrafts((ds) => ds.map((q, i) => (i === selectedIdx ? { ...q, ...patch } : q)));
  const addQuery = () => {
    save.reset();
    run.reset();
    let n = 1;
    while (drafts.some((q) => q.key === `query${n}`)) n++;
    const id = nextId.current++;
    setDrafts([...drafts, { id, key: `query${n}`, mode: 'list', sql: 'select 1' }]);
    setSelectedId(id);
  };
  const removeQuery = () => {
    save.reset();
    run.reset();
    const next = drafts.filter((_, i) => i !== selectedIdx);
    setDrafts(next);
    setSelectedId(next[Math.max(0, selectedIdx - 1)]?.id);
  };

  // Ошибки сервера приходят по позиции запроса ('1.sql'); раскладываем по запросам.
  const errors = fieldErrors(save.error);
  const errorsOf = (i: number): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of FIELDS) {
      for (const k of Object.keys(errors)) {
        const p = `${i}.${f}`;
        if (k === p || k.startsWith(`${p}.`)) out[f] ??= errors[k]!;
      }
    }
    return out;
  };
  const queryKeysWithErrors = new Set<string>();
  const shown: string[] = [];
  drafts.forEach((_, i) => {
    for (const f of FIELDS) {
      for (const k of Object.keys(errors)) {
        const p = `${i}.${f}`;
        if (k === p || k.startsWith(`${p}.`)) {
          shown.push(k);
          queryKeysWithErrors.add(String(i));
        }
      }
    }
  });
  const own = errorsOf(selectedIdx);
  const others = drafts.flatMap((q, i) =>
    i === selectedIdx ? [] : Object.values(errorsOf(i)).map((m) => ({ q, m })),
  );

  const result: RunQueryResult | undefined = run.data;
  const runKey = run.variables?.key;
  const columns: TableColumnConfig<Row>[] = (result?.columns ?? []).map((c) => ({
    id: c,
    name: c,
    template: (r) => formatCell(r[c]),
  }));

  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 24, alignItems: 'start' }}
    >
      <div className="cr-stack">
        {drafts.map((q, i) => (
          <Button
            key={q.id}
            view={q.id === current?.id ? 'normal' : 'flat'}
            width="max"
            onClick={() => select(q.id)}
          >
            {q.key} <Label size="xs">{q.mode === 'list' ? 'список' : 'одна строка'}</Label>
            {queryKeysWithErrors.has(String(i)) && (
              <Label size="xs" theme="danger" title="В запросе есть ошибки">
                <Icon data={CircleExclamation} size={12} />
                ошибка
              </Label>
            )}
          </Button>
        ))}
        <Button view="outlined" onClick={addQuery}>
          <Icon data={Plus} />
          Добавить запрос
        </Button>
        <Card view="outlined" style={{ padding: 12 }}>
          <Text variant="subheader-1" as="div" style={{ marginBottom: 8 }}>
            Тестовые параметры
          </Text>
          {template.params.length === 0 ? (
            <Text color="secondary">Параметров нет</Text>
          ) : (
            <ParamForm params={template.params} values={testParams} onChange={onTestParams} />
          )}
        </Card>
      </div>
      <div className="cr-stack">
        {current ? (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'end' }}>
              <Field label="Ключ (в шаблоне — d.ключ)" error={own['key']}>
                <TextInput
                  value={current.key}
                  onUpdate={(v) => update({ key: v })}
                  validationState={own['key'] ? 'invalid' : undefined}
                  controlProps={{ 'aria-label': 'Ключ запроса' }}
                />
              </Field>
              <SegmentedRadioGroup
                value={current.mode}
                onUpdate={(v) => update({ mode: v as QueryMode })}
                options={[
                  { value: 'list', content: 'Список строк' },
                  { value: 'single', content: 'Одна строка' },
                ]}
              />
              <Button view="flat-danger" onClick={removeQuery}>
                <Icon data={TrashBin} />
                Удалить запрос
              </Button>
            </div>
            {own['mode'] && <Text color="danger">{own['mode']}</Text>}
            <CodeEditor
              language="sql"
              value={current.sql}
              onChange={(v) => update({ sql: v })}
              ariaLabel="SQL"
              height={260}
            />
            {own['sql'] && <Text color="danger">{own['sql']}</Text>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button
                onClick={() => run.mutate({ key: current.key, sql: current.sql })}
                loading={run.isPending}
              >
                <Icon data={Play} />
                Выполнить
              </Button>
              <Button view="action" onClick={() => save.mutate()} loading={save.isPending}>
                Сохранить запросы
              </Button>
              {dirty && stale && (
                <Text color="warning">
                  Шаблон изменился на сервере — сохранение перезапишет изменения
                </Text>
              )}
              {dirty && <Text color="warning">Есть несохранённые изменения</Text>}
            </div>
          </>
        ) : (
          <>
            <Text color="secondary">Запросов нет — добавьте первый.</Text>
            <div>
              <Button
                view="action"
                onClick={() => save.mutate()}
                loading={save.isPending}
                disabled={!dirty}
              >
                Сохранить запросы
              </Button>
            </div>
          </>
        )}
        {others.map(({ q, m }, n) => (
          <Alert key={n} theme="danger" message={`Запрос «${q.key}»: ${m}`} />
        ))}
        <GeneralError error={save.error} errors={errors} shown={shown} />
        <ErrorAlert error={run.error} />
        {result && (
          <>
            <Text variant="subheader-1">Результат запроса «{runKey}»</Text>
            <Table
              data={result.rows.map((r, i) => ({ ...r, __i: i }))}
              columns={columns}
              getRowDescriptor={(r) => ({ id: String(r.__i) })}
              emptyMessage="Запрос не вернул строк"
              width="max"
            />
            {result.truncated && <Text color="secondary">Показаны первые 50 строк.</Text>}
          </>
        )}
      </div>
    </div>
  );
}
