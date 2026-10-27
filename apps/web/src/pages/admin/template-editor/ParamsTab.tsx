import type {
  ParamOptionsResult,
  ParamType,
  ParamValue,
  TemplateAdminDetails,
  TemplateParam,
} from '@carbone-reports/shared';
import { sqlCompareRefs } from '@carbone-reports/shared';
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
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/endpoints';
import { errorMessage, fieldErrors } from '../../../api/errors';
import { CodeEditor } from '../../../components/CodeEditor';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import { ParamField } from '../../../components/ParamForm';
import {
  applyParam,
  useOptionalAssistantBridge,
  type ApplyCard,
} from '../../../features/assistant/bridge';
import { i18n } from '../../../i18n';
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

const TYPES: ParamType[] = ['string', 'number', 'date', 'boolean', 'select', 'query'];

/** Ссылки :имя в SQL (без приведений ::type). Только подсказка — зависимости определяет сервер. */
export function sqlRefs(sql: string): string[] {
  return [...new Set([...sql.matchAll(/(?<![:\w]):([A-Za-z_]\w*)/g)].map((m) => m[1]!))];
}

/** Подсказки о сравнении: множественный параметр — через = any(:имя), одиночный — через = :имя. */
export function anyHints(sql: string, drafts: Draft[]): string[] {
  const refs = sqlCompareRefs(sql);
  const draft = (n: string) => {
    // Дубликаты имён отклонит сервер при сохранении — подсказку не гадаем.
    const found = drafts.filter((d) => d.name === n);
    return found.length === 1 && found[0]!.type === 'query' ? found[0] : undefined;
  };
  const hints: string[] = [];
  for (const n of refs.scalar) {
    const p = draft(n);
    if (p?.multiple)
      hints.push(i18n.t('editor:params.hintMultiple', { label: p.label || n, name: n }));
  }
  for (const n of refs.any) {
    const p = draft(n);
    if (p && !p.multiple)
      hints.push(i18n.t('editor:params.hintSingle', { label: p.label || n, name: n }));
  }
  return hints;
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

/** Одиночное значение SQL-списка вводится текстом: пробелы по краям убираем при сохранении, а не при вводе. */
const trimDefault = (v: ParamValue): ParamValue =>
  typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v;

/** Множественное: при вводе это строка «1, 2»; при сохранении — по запятым, без пробелов по краям и пустых. */
const splitDefault = (v: ParamValue): ParamValue => {
  if (typeof v !== 'string') return v;
  const items = v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
};

const toParam = (d: Draft): TemplateParam => ({
  name: d.name.trim(),
  label: d.label.trim(),
  type: d.type,
  required: d.required,
  defaultValue:
    d.type !== 'query'
      ? d.defaultValue
      : d.multiple
        ? splitDefault(d.defaultValue)
        : trimDefault(d.defaultValue),
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
  const { t } = useTranslation();
  const check = useMutation<ParamOptionsResult>({
    mutationFn: () => api.templates.paramOptions(templateId, name, testParams),
  });
  const r = saved ? check.data : undefined;
  return (
    <div className="cr-stack" style={{ gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          size="s"
          aria-label={t('editor:params.checkAria', { n })}
          disabled={!saved}
          loading={check.isPending}
          onClick={() => check.mutate()}
        >
          {t('editor:params.check')}
        </Button>
        {!saved && (
          <Text color="secondary" variant="caption-2">
            {t('editor:params.saveFirst')}
          </Text>
        )}
      </div>
      {saved && check.error && <Text color="danger">{errorMessage(check.error)}</Text>}
      {r && r.waitingFor && r.waitingFor.length > 0 && (
        <Text color="secondary">
          {t('editor:params.waitingFor', { names: r.waitingFor.join(t('editor:listSeparator')) })}
        </Text>
      )}
      {r && !r.waitingFor?.length && (
        <>
          <Text color="secondary">{t('editor:params.optionsTotal', { n: r.options.length })}</Text>
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
  // Строка — набранный текст: для множественного её разберёт splitDefault при сохранении.
  if (multiple) return v === null || Array.isArray(v) || typeof v !== 'number' ? v : [v];
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function ParamsTab({ template }: { template: TemplateAdminDetails }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const nextId = useRef(0);
  const makeDrafts = (tpl: TemplateAdminDetails) =>
    tpl.params.map((p) => toDraft(p, nextId.current++));
  const [baseline, setBaseline] = useState(template);
  const [drafts, setDrafts] = useState<Draft[]>(() => makeDrafts(template));
  const [testValues] = useTestParams(template.id, template.params);
  const testParams = pickParams(template.params, testValues);
  const strip = (ds: Draft[]) => JSON.stringify(ds.map(({ id: _id, ...rest }) => rest));
  const dirty = strip(drafts) !== strip(baseline.params.map((p) => toDraft(p, 0)));
  const reseed = (tpl: TemplateAdminDetails) => {
    setBaseline(tpl);
    setDrafts(makeDrafts(tpl));
  };
  // Шаблон обновился на сервере: без несохранённых правок подхватываем, иначе сохраняем черновик.
  const stale = template.updatedAt !== baseline.updatedAt;
  if (stale && !dirty) reseed(template);

  // Мост ассистента (§51.5): черновик уходит в запрос чата (невалидные параметры отсеивает мост),
  // карточки параметров применяются в черновик.
  const bridge = useOptionalAssistantBridge();
  const registerTab = bridge?.registerTab;
  const takePending = bridge?.takePending;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const applyCard = (c: ApplyCard) => {
    if (c.type !== 'param' || c.templateId !== template.id) return;
    save.reset();
    const next = applyParam(draftsRef.current, c, (p) => toDraft(p, nextId.current++));
    draftsRef.current = next;
    setDrafts(next);
    add({ name: 'assistant-applied', theme: 'info', title: t('common:assistant.applied') });
  };
  const applyRef = useRef(applyCard);
  applyRef.current = applyCard;
  useEffect(() => {
    if (!registerTab || !takePending) return;
    const off = registerTab({
      kind: 'param',
      draft: () => draftsRef.current.map(toParam),
      apply: (c) => applyRef.current(c),
    });
    takePending('param').forEach((c) => applyRef.current(c));
    return off;
  }, [registerTab, takePending]);

  const save = useMutation({
    mutationFn: () => api.templates.saveParams(template.id, drafts.map(toParam)),
    onSuccess: (tpl) => {
      applyTemplate(queryClient, tpl);
      // SQL вариантов мог измениться: старые варианты из кэша не показываем.
      void queryClient.invalidateQueries({ queryKey: ['param-options', template.id] });
      reseed(tpl);
      add({ name: `tpl-params-${Date.now()}`, title: t('editor:params.saved'), theme: 'success' });
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
          label: t('editor:params.newLabel'),
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
      {drafts.length === 0 && <Text color="secondary">{t('editor:params.empty')}</Text>}
      {drafts.map((d, i) => {
        const n = i + 1;
        return (
          <Card key={d.id} view="outlined">
            <div className="cr-param-row">
              <Field label={t('editor:params.name')} error={errorFor(i, 'name')}>
                <TextInput
                  value={d.name}
                  onUpdate={(v) => update(i, { name: v })}
                  validationState={errorFor(i, 'name') ? 'invalid' : undefined}
                  controlProps={{ 'aria-label': t('editor:params.nameAria', { n }) }}
                />
              </Field>
              <Field label={t('editor:params.label')} error={errorFor(i, 'label')}>
                <TextInput
                  value={d.label}
                  onUpdate={(v) => update(i, { label: v })}
                  validationState={errorFor(i, 'label') ? 'invalid' : undefined}
                  controlProps={{ 'aria-label': t('editor:params.labelAria', { n }) }}
                />
              </Field>
              <Field label={t('editor:params.type')}>
                <Select
                  aria-label={t('editor:params.typeAria', { n })}
                  value={[d.type]}
                  options={TYPES.map((value) => ({
                    value,
                    content: t(`editor:params.type_${value}`),
                  }))}
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
                content={t('editor:params.required')}
              />
              <div style={{ display: 'flex', gap: 4 }}>
                <Button
                  view="flat"
                  size="s"
                  aria-label={t('editor:params.upAria', { n })}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <Icon data={ArrowUp} />
                </Button>
                <Button
                  view="flat"
                  size="s"
                  aria-label={t('editor:params.downAria', { n })}
                  disabled={i === drafts.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <Icon data={ArrowDown} />
                </Button>
                <Button
                  view="flat-danger"
                  size="s"
                  aria-label={t('editor:params.removeAria', { n })}
                  onClick={() => edit((ds) => ds.filter((_, j) => j !== i))}
                >
                  <Icon data={TrashBin} />
                </Button>
              </div>
            </div>
            <div className="cr-param-extra">
              <div>
                <ParamField
                  label={t('editor:params.default')}
                  param={{ ...toParam(d), required: false }}
                  value={d.defaultValue}
                  error={errorFor(i, 'defaultValue')}
                  onChange={(v) => update(i, { defaultValue: v })}
                />
              </div>
              {d.type === 'select' && (
                <Field label={t('editor:params.options')} error={errorFor(i, 'options')}>
                  <TextArea
                    value={d.optionsText}
                    onUpdate={(v) => update(i, { optionsText: v })}
                    minRows={3}
                    validationState={errorFor(i, 'options') ? 'invalid' : undefined}
                    controlProps={{ 'aria-label': t('editor:params.optionsAria', { n }) }}
                  />
                </Field>
              )}
              {d.type === 'query' && (
                <div className="cr-stack">
                  <Field group label={t('editor:params.sql')} error={errorFor(i, 'sql')}>
                    <CodeEditor
                      language="sql"
                      value={d.sql}
                      onChange={(v) => update(i, { sql: v })}
                      ariaLabel={t('editor:params.sqlAria', { n })}
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
                    content={t('editor:params.multiple')}
                  />
                  {errorFor(i, 'multiple') && <Text color="danger">{errorFor(i, 'multiple')}</Text>}
                  <Text color="secondary">
                    {t('editor:params.dependsOn', {
                      names: sqlRefs(d.sql).join(t('editor:listSeparator')) || '—',
                    })}
                  </Text>
                  {anyHints(d.sql, drafts).map((h, k) => (
                    <Text key={k} color="warning">
                      {h}
                    </Text>
                  ))}
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
          {t('editor:params.add')}
        </Button>
        <Button view="action" onClick={() => save.mutate()} loading={save.isPending}>
          {t('editor:params.save')}
        </Button>
        {dirty && stale && <Text color="warning">{t('editor:draft.stale')}</Text>}
        {dirty && (
          <>
            <Text color="warning">{t('editor:draft.unsaved')}</Text>
            <Button
              view="flat"
              onClick={() => {
                save.reset();
                reseed(template);
              }}
            >
              {t('editor:draft.discard')}
            </Button>
          </>
        )}
      </div>
      <GeneralError error={save.error} errors={errors} shown={[...consumed]} />
    </div>
  );
}
