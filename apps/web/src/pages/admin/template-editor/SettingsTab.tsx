import type { OutputFormat, TemplateAccess, TemplateAdminDetails } from '@carbone-reports/shared';
import { Button, Loader, Select, Text, TextArea, TextInput, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../../../api/endpoints';
import { errorMessage, fieldErrors } from '../../../api/errors';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import { ACCESS_FIELDS, AccessFields, sameAccess, useSaveTemplateAccess } from '../AccessFields';
import { EditorsBlock } from './EditorsBlock';
import { applyTemplate } from './editorState';

const SHOWN = ['name', 'description', 'datasourceId', 'defaultOutput'];

export function SettingsTab({
  template,
  holder,
}: {
  template: TemplateAdminDetails;
  /** Номер вкладки «Документ» этой страницы: собственная блокировка замене файла не мешает (§38.2). */
  holder?: string;
}) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const datasources = useQuery({
    queryKey: ['datasources', 'options'],
    queryFn: api.datasources.options,
  });
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
      return api.templates.replaceFile(template.id, form, holder);
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
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          view="action"
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!dirty}
        >
          Сохранить настройки
        </Button>
        {dirty && (
          <>
            <Text color="warning">Есть несохранённые изменения</Text>
            <Button
              view="flat"
              aria-label="Отменить изменения настроек"
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
      <AccessSection templateId={template.id} />
      {template.canManageEditors && <EditorsBlock template={template} />}
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

/** Кто видит шаблон: «доступно всем», категория и группы. */
function AccessSection({ templateId }: { templateId: string }) {
  const headingId = useId();
  const access = useQuery({
    queryKey: ['template-access', templateId],
    queryFn: () => api.templates.getAccess(templateId),
  });
  const [baseline, setBaseline] = useState<TemplateAccess | undefined>(undefined);
  const [form, setForm] = useState<TemplateAccess | undefined>(undefined);
  const dirty = !!form && !!baseline && !sameAccess(form, baseline);
  // Новые данные с сервера подхватываем, только если нет несохранённых правок.
  if (access.data && access.data !== baseline && !dirty) {
    setBaseline(access.data);
    setForm(access.data);
  }

  const save = useSaveTemplateAccess(templateId, (saved) => {
    setBaseline(saved);
    setForm(saved);
  });
  const errors = fieldErrors(save.error);
  const set = (patch: Partial<TemplateAccess>) => {
    save.reset();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };
  // «Отменить»: к последнему сохранённому доступу (ответ сервера, иначе прежний baseline).
  const discard = () => {
    save.reset();
    const saved = access.data ?? baseline;
    setBaseline(saved);
    setForm(saved);
  };

  return (
    <section aria-labelledby={headingId} className="cr-form" style={{ marginTop: 16 }}>
      <Text variant="subheader-2" id={headingId}>
        Доступ
      </Text>
      <ErrorAlert error={access.error} title="Не удалось загрузить настройки доступа" />
      {access.isPending && <Loader size="s" />}
      {form && (
        <>
          <AccessFields value={form} onChange={set} errors={errors} dirty={dirty} />
          <GeneralError error={save.error} errors={errors} shown={ACCESS_FIELDS} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button
              view="action"
              onClick={() => save.mutate(form)}
              loading={save.isPending}
              disabled={!dirty}
            >
              Сохранить доступ
            </Button>
            {dirty && (
              <>
                <Text color="warning">Есть несохранённые изменения</Text>
                <Button view="flat" aria-label="Отменить изменения доступа" onClick={discard}>
                  Отменить
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
