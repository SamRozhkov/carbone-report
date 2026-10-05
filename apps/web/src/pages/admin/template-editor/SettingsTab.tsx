import type { OutputFormat, TemplateAccess, TemplateAdminDetails } from '@carbone-reports/shared';
import {
  Alert,
  Button,
  Checkbox,
  Loader,
  Select,
  Text,
  TextArea,
  TextInput,
  useToaster,
} from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../../../api/endpoints';
import { errorMessage, fieldErrors } from '../../../api/errors';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import { sameIds } from '../../../lib/ids';
import { applyTemplate } from './editorState';

const SHOWN = ['name', 'description', 'datasourceId', 'defaultOutput'];

export function SettingsTab({ template }: { template: TemplateAdminDetails }) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const datasources = useQuery({ queryKey: ['datasources'], queryFn: api.datasources.list });
  const pick = (t: TemplateAdminDetails) => ({
    name: t.name,
    description: t.description,
    datasourceId: t.datasourceId,
    defaultOutput: t.defaultOutput,
  });
  const [baseline, setBaseline] = useState(template);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [datasourceId, setDatasourceId] = useState(template.datasourceId);
  const [defaultOutput, setDefaultOutput] = useState<OutputFormat>(template.defaultOutput);
  const dirty =
    JSON.stringify({ name, description, datasourceId, defaultOutput }) !==
    JSON.stringify(pick(baseline));
  const reseed = (t: TemplateAdminDetails) => {
    setBaseline(t);
    setName(t.name);
    setDescription(t.description);
    setDatasourceId(t.datasourceId);
    setDefaultOutput(t.defaultOutput);
  };
  // Шаблон обновился на сервере: без несохранённых правок подхватываем, иначе сохраняем черновик.
  const stale = template.updatedAt !== baseline.updatedAt;
  if (stale && !dirty) reseed(template);

  const save = useMutation({
    mutationFn: () =>
      api.templates.update(template.id, { name, description, datasourceId, defaultOutput }),
    onSuccess: (t) => {
      applyTemplate(queryClient, t);
      reseed(t);
      add({ name: `tpl-settings-${Date.now()}`, title: 'Настройки сохранены', theme: 'success' });
    },
  });
  const replace = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.templates.replaceFile(template.id, form);
    },
    onSuccess: (t) => {
      applyTemplate(queryClient, t);
      add({
        name: `tpl-file-${Date.now()}`,
        title: `Файл заменён, версия ${t.version}`,
        theme: 'success',
      });
    },
    onError: (e) =>
      add({
        name: `tpl-file-err-${Date.now()}`,
        title: 'Файл не заменён',
        content: errorMessage(e),
        theme: 'danger',
      }),
  });
  const errors = fieldErrors(save.error);

  return (
    <div className="cr-form">
      <Field label="Название" error={errors.name}>
        <TextInput
          value={name}
          onUpdate={setName}
          validationState={errors.name ? 'invalid' : undefined}
          controlProps={{ 'aria-label': 'Название шаблона' }}
        />
      </Field>
      <Field label="Описание" error={errors.description}>
        <TextArea value={description} onUpdate={setDescription} minRows={2} />
      </Field>
      <Field label="Источник данных" error={errors.datasourceId}>
        <Select
          value={[datasourceId]}
          onUpdate={([v]) => v && setDatasourceId(v)}
          options={(datasources.data ?? []).map((d) => ({ value: d.id, content: d.name }))}
          width="max"
        />
      </Field>
      <Field label="Формат по умолчанию" error={errors.defaultOutput}>
        <Select
          value={[defaultOutput]}
          onUpdate={([v]) => v && setDefaultOutput(v as OutputFormat)}
          options={template.outputFormats.map((f) => ({ value: f, content: f.toUpperCase() }))}
          width="max"
        />
      </Field>
      {datasources.error && (
        <ErrorAlert error={datasources.error} title="Не удалось загрузить источники данных" />
      )}
      {dirty && stale && (
        <Text color="warning">Шаблон изменился на сервере — сохранение перезапишет изменения</Text>
      )}
      <GeneralError error={save.error} errors={errors} shown={SHOWN} />
      <div>
        <Button view="action" onClick={() => save.mutate()} loading={save.isPending}>
          Сохранить настройки
        </Button>
      </div>
      <AccessSection templateId={template.id} />
      <div className="cr-field" style={{ marginTop: 16 }}>
        <Text variant="subheader-1">Заменить файл шаблона</Text>
        <Text color="secondary" variant="caption-2">
          Загрузите отредактированный .{template.fileExt} — версия шаблона увеличится, открытые
          сессии редактора начнутся заново.
        </Text>
        <input
          type="file"
          aria-label="Новый файл шаблона"
          accept={`.${template.fileExt}`}
          disabled={replace.isPending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) replace.mutate(f);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

const NO_CATEGORY = '__none__';

const sameAccess = (a: TemplateAccess, b: TemplateAccess) =>
  a.public === b.public && a.categoryId === b.categoryId && sameIds(a.groupIds, b.groupIds);

/** Кто видит шаблон: «доступно всем», категория и группы (правило — в access.ts на сервере). */
function AccessSection({ templateId }: { templateId: string }) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const headingId = useId();
  const access = useQuery({
    queryKey: ['template-access', templateId],
    queryFn: () => api.templates.getAccess(templateId),
  });
  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories.list });
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups.list });
  const [baseline, setBaseline] = useState<TemplateAccess | undefined>(undefined);
  const [form, setForm] = useState<TemplateAccess | undefined>(undefined);
  const dirty = !!form && !!baseline && !sameAccess(form, baseline);
  // Новые данные с сервера подхватываем, только если нет несохранённых правок.
  if (access.data && access.data !== baseline && !dirty) {
    setBaseline(access.data);
    setForm(access.data);
  }

  const save = useMutation({
    mutationFn: (body: TemplateAccess) => api.templates.access(templateId, body),
    onSuccess: async (saved) => {
      queryClient.setQueryData(['template-access', templateId], saved);
      setBaseline(saved);
      setForm(saved);
      add({ name: `tpl-access-${Date.now()}`, title: 'Доступ сохранён', theme: 'success' });
      await Promise.all(
        [['templates'], ['categories']].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
  const errors = fieldErrors(save.error);
  const set = (patch: Partial<TemplateAccess>) => {
    save.reset();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  const category = form?.categoryId
    ? categories.data?.find((c) => c.id === form.categoryId)
    : undefined;
  // Без данных о выбранной категории вывод сделать нельзя — предупреждение не показываем.
  const categoryKnown = !form?.categoryId || !!category;
  const adminOnly =
    !!form &&
    categoryKnown &&
    !form.public &&
    form.groupIds.length === 0 &&
    !(category && (category.public || category.groupIds.length > 0));

  return (
    <section aria-labelledby={headingId} className="cr-form" style={{ marginTop: 16 }}>
      <Text variant="subheader-2" id={headingId}>
        Доступ
      </Text>
      <ErrorAlert error={access.error} title="Не удалось загрузить настройки доступа" />
      {categories.error && (
        <ErrorAlert error={categories.error} title="Не удалось загрузить категории" />
      )}
      {groups.error && <ErrorAlert error={groups.error} title="Не удалось загрузить группы" />}
      {access.isPending && <Loader size="s" />}
      {form && (
        <>
          <Field label="Категория" error={errors.categoryId}>
            <Select
              aria-label="Категория"
              value={[form.categoryId ?? NO_CATEGORY]}
              onUpdate={([v]) => set({ categoryId: !v || v === NO_CATEGORY ? null : v })}
              options={[
                { value: NO_CATEGORY, content: 'Без категории' },
                ...(categories.data ?? []).map((c) => ({ value: c.id, content: c.name })),
              ]}
              loading={categories.isPending}
              filterable
              width="max"
            />
          </Field>
          <Field label="Видимость" error={errors.public} group>
            <Checkbox
              checked={form.public}
              onUpdate={(v) => set({ public: v })}
              content="Доступно всем"
            />
          </Field>
          <Field
            label="Группы"
            hint="группы, которым виден шаблон, помимо доступа через категорию"
            group
          >
            <Select
              aria-label="Группы"
              value={form.groupIds}
              onUpdate={(v) => set({ groupIds: v })}
              options={(groups.data ?? []).map((g) => ({ value: g.id, content: g.name }))}
              multiple
              filterable
              hasClear
              loading={groups.isPending}
              placeholder="нет групп"
              width="max"
            />
          </Field>
          {adminOnly && (
            <Alert
              theme="warning"
              message={
                dirty
                  ? 'После сохранения шаблон будет доступен только администраторам'
                  : 'Шаблон сейчас доступен только администраторам'
              }
            />
          )}
          <GeneralError error={save.error} errors={errors} shown={['categoryId', 'public']} />
          <div>
            <Button
              view="action"
              onClick={() => save.mutate(form)}
              loading={save.isPending}
              disabled={!dirty}
            >
              Сохранить доступ
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
