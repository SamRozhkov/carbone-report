import type {
  ParamOptionsResult,
  ParamType,
  ParamValue,
  TemplateAdminDetails,
  TemplateParam,
} from '@carbone-reports/shared';
import { ArrowDown, ArrowUp, Plus, TrashBin } from '@gravity-ui/icons';
import {
  Button,
  Card,
  Checkbox,
  Icon,
  Select,
  Text,
  TextArea,
  TextInput,
  useToaster,
} from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../../../api/endpoints';
import { errorMessage, fieldErrors } from '../../../api/errors';
import { CodeEditor } from '../../../components/CodeEditor';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import { ParamField } from '../../../components/ParamForm';
import { formatOptions, parseOptions, pickParams } from '../../../lib/params';
import { applyTemplate, useTestParams } from './editorState';

interface Draft {
  id: number;
  name: string;
  label: string;
  type: ParamType;
  required: boolean;
  defaultValue: ParamValue;
  optionsText: string;
  sql: string;
  multiple: boolean;
}

const TYPE_OPTIONS: { value: ParamType; content: string }[] = [
  { value: 'string', content: 'Строка' },
  { value: 'number', content: 'Число' },
  { value: 'date', content: 'Дата' },
  { value: 'boolean', content: 'Да/нет' },
  { value: 'select', content: 'Список' },
  { value: 'query', content: 'SQL-список' },
];

/** Ссылки :имя в SQL (без приведений ::type). Только подсказка — зависимости определяет сервер. */
export function sqlRefs(sql: string): string[] {
  return [...new Set([...sql.matchAll(/(?<![:\w]):([A-Za-z_]\w*)/g)].map((m) => m[1]!))];
}

const CHECK_SHOWN = 20;

const toDraft = (p: TemplateParam, id: number): Draft => ({
  id,
  name: p.name,
  label: p.label,
  type: p.type,
  required: p.required,
  defaultValue: p.defaultValue,
  optionsText: formatOptions(p.options),
  sql: p.sql ?? '',
  multiple: p.multiple,
});

const toParam = (d: Draft): TemplateParam => ({
  name: d.name.trim(),
  label: d.label.trim(),
  type: d.type,
  required: d.required,
  defaultValue: d.defaultValue,
  options: d.type === 'select' ? parseOptions(d.optionsText) : null,
  sql: d.type === 'query' ? d.sql : null,
  multiple: d.type === 'query' && d.multiple,
});

/** «Проверить»: запрос вариантов сохранённого параметра с тестовыми значениями. */
function QueryCheck({
  templateId,
  name,
  n,
  saved,
  testParams,
}: {
  templateId: string;
  name: string;
  n: number;
  saved: boolean;
  testParams: Record<string, ParamValue>;
}) {
  const check = useMutation<ParamOptionsResult>({
    mutationFn: () => api.templates.paramOptions(templateId, name, testParams),
  });
  const r = saved ? check.data : undefined;
  return (
    <div className="cr-stack" style={{ gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          size="s"
          aria-label={`Проверить: параметр ${n}`}
          disabled={!saved}
          loading={check.isPending}
          onClick={() => check.mutate()}
        >
          Проверить
        </Button>
        {!saved && (
          <Text color="secondary" variant="caption-2">
            сохраните параметры
          </Text>
        )}
      </div>
      {saved && check.error && <Text color="danger">{errorMessage(check.error)}</Text>}
      {r && r.waitingFor && r.waitingFor.length > 0 && (
        <Text color="secondary">сначала задайте тестовые значения: {r.waitingFor.join(', ')}</Text>
      )}
      {r && !r.waitingFor?.length && (
        <>
          <Text color="secondary">всего вариантов: {r.options.length}</Text>
          {r.options.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {r.options.slice(0, CHECK_SHOWN).map((o) => (
                <li key={String(o.value)}>
                  {o.label} ({String(o.value)})
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function toggleMultiple(v: ParamValue, multiple: boolean): ParamValue {
  if (multiple) return v === null || Array.isArray(v) || typeof v === 'boolean' ? v : [v];
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function ParamsTab({ template }: { template: TemplateAdminDetails }) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const nextId = useRef(0);
  const makeDrafts = (t: TemplateAdminDetails) => t.params.map((p) => toDraft(p, nextId.current++));
  const [baseline, setBaseline] = useState(template);
  const [drafts, setDrafts] = useState<Draft[]>(() => makeDrafts(template));
  const [testValues] = useTestParams(template.id, template.params);
  const testParams = pickParams(template.params, testValues);
  const strip = (ds: Draft[]) => JSON.stringify(ds.map(({ id: _id, ...rest }) => rest));
  const dirty = strip(drafts) !== strip(baseline.params.map((p) => toDraft(p, 0)));
  const reseed = (t: TemplateAdminDetails) => {
    setBaseline(t);
    setDrafts(makeDrafts(t));
  };
  // Шаблон обновился на сервере: без несохранённых правок подхватываем, иначе сохраняем черновик.
  const stale = template.updatedAt !== baseline.updatedAt;
  if (stale && !dirty) reseed(template);

  const save = useMutation({
    mutationFn: () => api.templates.saveParams(template.id, drafts.map(toParam)),
    onSuccess: (t) => {
      applyTemplate(queryClient, t);
      // SQL вариантов мог измениться: старые варианты из кэша не показываем.
      void queryClient.invalidateQueries({ queryKey: ['param-options', template.id] });
      reseed(t);
      add({ name: `tpl-params-${Date.now()}`, title: 'Параметры сохранены', theme: 'success' });
    },
  });
  const errors = fieldErrors(save.error);
  // Схемные ошибки приходят по индексу строки ('1.options.0.value'), ошибки default — по имени параметра ({fields}).
  const consumed = new Set<string>();
  const errorFor = (i: number, field: string): string | undefined => {
    const prefix = `${i}.${field}`;
    let found: string | undefined;
    for (const k of Object.keys(errors)) {
      if (k === prefix || k.startsWith(`${prefix}.`)) {
        consumed.add(k);
        found ??= errors[k];
      }
    }
    if (found === undefined && field === 'defaultValue') {
      const name = drafts[i]?.name ?? '';
      if (name && Object.hasOwn(errors, name)) {
        consumed.add(name);
        found = errors[name];
      }
    }
    return found;
  };

  const edit = (fn: (ds: Draft[]) => Draft[]) => {
    save.reset();
    setDrafts(fn);
  };
  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i: number, delta: -1 | 1) =>
    edit((ds) => {
      const next = [...ds];
      const j = i + delta;
      if (j < 0 || j >= next.length) return ds;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const addParam = () =>
    edit((ds) => {
      let n = ds.length + 1;
      while (ds.some((d) => d.name === `param${n}`)) n++;
      return [
        ...ds,
        {
          id: nextId.current++,
          name: `param${n}`,
          label: 'Новый параметр',
          type: 'string',
          required: false,
          defaultValue: null,
          optionsText: '',
          sql: '',
          multiple: false,
        },
      ];
    });

  return (
    <div className="cr-stack">
      {drafts.length === 0 && (
        <Text color="secondary">Параметров нет — отчёт формируется без ввода данных.</Text>
      )}
      {drafts.map((d, i) => {
        const n = i + 1;
        return (
          <Card key={d.id} view="outlined">
            <div className="cr-param-row">
              <Field label="Имя (в SQL — :имя)" error={errorFor(i, 'name')}>
                <TextInput
                  value={d.name}
                  onUpdate={(v) => update(i, { name: v })}
                  validationState={errorFor(i, 'name') ? 'invalid' : undefined}
                  controlProps={{ 'aria-label': `Имя параметра ${n}` }}
                />
              </Field>
              <Field label="Подпись" error={errorFor(i, 'label')}>
                <TextInput
                  value={d.label}
                  onUpdate={(v) => update(i, { label: v })}
                  validationState={errorFor(i, 'label') ? 'invalid' : undefined}
                  controlProps={{ 'aria-label': `Подпись параметра ${n}` }}
                />
              </Field>
              <Field label="Тип">
                <Select
                  aria-label={`Тип параметра ${n}`}
                  value={[d.type]}
                  options={TYPE_OPTIONS}
                  onUpdate={([v]) =>
                    v &&
                    update(i, {
                      type: v as ParamType,
                      defaultValue: v === 'boolean' ? false : null,
                      multiple: v === 'query' && d.multiple,
                    })
                  }
                  width="max"
                />
              </Field>
              <Checkbox
                checked={d.required}
                onUpdate={(v) => update(i, { required: v })}
                content="Обязательный"
              />
              <div style={{ display: 'flex', gap: 4 }}>
                <Button
                  view="flat"
                  size="s"
                  aria-label={`Выше: параметр ${n}`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <Icon data={ArrowUp} />
                </Button>
                <Button
                  view="flat"
                  size="s"
                  aria-label={`Ниже: параметр ${n}`}
                  disabled={i === drafts.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <Icon data={ArrowDown} />
                </Button>
                <Button
                  view="flat-danger"
                  size="s"
                  aria-label={`Удалить параметр ${n}`}
                  onClick={() => edit((ds) => ds.filter((_, j) => j !== i))}
                >
                  <Icon data={TrashBin} />
                </Button>
              </div>
            </div>
            <div className="cr-param-extra">
              <div>
                <ParamField
                  label="По умолчанию"
                  param={{ ...toParam(d), required: false }}
                  value={d.defaultValue}
                  error={errorFor(i, 'defaultValue')}
                  onChange={(v) => update(i, { defaultValue: v })}
                />
              </div>
              {d.type === 'select' && (
                <Field
                  label="Варианты: значение=подпись, по одному на строку"
                  error={errorFor(i, 'options')}
                >
                  <TextArea
                    value={d.optionsText}
                    onUpdate={(v) => update(i, { optionsText: v })}
                    minRows={3}
                    validationState={errorFor(i, 'options') ? 'invalid' : undefined}
                    controlProps={{ 'aria-label': `Варианты параметра ${n}` }}
                  />
                </Field>
              )}
              {d.type === 'query' && (
                <div className="cr-stack">
                  <Field
                    group
                    label="SQL вариантов: колонки value и label"
                    error={errorFor(i, 'sql')}
                  >
                    <CodeEditor
                      language="sql"
                      value={d.sql}
                      onChange={(v) => update(i, { sql: v })}
                      ariaLabel={`SQL параметра ${n}`}
                      height={120}
                    />
                  </Field>
                  <Checkbox
                    checked={d.multiple}
                    onUpdate={(v) =>
                      update(i, {
                        multiple: v,
                        defaultValue: toggleMultiple(d.defaultValue, v),
                      })
                    }
                    content="множественный выбор"
                  />
                  {errorFor(i, 'multiple') && <Text color="danger">{errorFor(i, 'multiple')}</Text>}
                  <Text color="secondary">зависит от: {sqlRefs(d.sql).join(', ') || '—'}</Text>
                  <QueryCheck
                    templateId={template.id}
                    name={d.name}
                    n={n}
                    saved={baseline.params.some(
                      (p) => p.name === d.name && p.type === 'query' && p.sql === d.sql,
                    )}
                    testParams={testParams}
                  />
                </div>
              )}
            </div>
          </Card>
        );
      })}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button onClick={addParam}>
          <Icon data={Plus} />
          Добавить параметр
        </Button>
        <Button view="action" onClick={() => save.mutate()} loading={save.isPending}>
          Сохранить параметры
        </Button>
        {dirty && stale && (
          <Text color="warning">
            Шаблон изменился на сервере — сохранение перезапишет изменения
          </Text>
        )}
        {dirty && (
          <>
            <Text color="warning">Есть несохранённые изменения</Text>
            <Button
              view="flat"
              onClick={() => {
                save.reset();
                reseed(template);
              }}
            >
              Отменить
            </Button>
          </>
        )}
      </div>
      <GeneralError error={save.error} errors={errors} shown={[...consumed]} />
    </div>
  );
}
