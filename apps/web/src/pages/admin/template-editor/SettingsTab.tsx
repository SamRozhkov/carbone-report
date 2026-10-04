import type { OutputFormat, TemplateAdminDetails } from '@carbone-reports/shared';
import { Button, Select, Text, TextArea, TextInput, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../api/endpoints';
import { errorMessage, fieldErrors } from '../../../api/errors';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import { applyTemplate } from './editorState';

const SHOWN = ['name', 'description', 'datasourceId', 'defaultOutput'];

export function SettingsTab({ template }: { template: TemplateAdminDetails }) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const datasources = useQuery({ queryKey: ['datasources'], queryFn: api.datasources.list });
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [datasourceId, setDatasourceId] = useState(template.datasourceId);
  const [defaultOutput, setDefaultOutput] = useState<OutputFormat>(template.defaultOutput);

  const save = useMutation({
    mutationFn: () =>
      api.templates.update(template.id, { name, description, datasourceId, defaultOutput }),
    onSuccess: (t) => {
      applyTemplate(queryClient, t);
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
      <GeneralError error={save.error} errors={errors} shown={SHOWN} />
      <div>
        <Button view="action" onClick={() => save.mutate()} loading={save.isPending}>
          Сохранить настройки
        </Button>
      </div>
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
