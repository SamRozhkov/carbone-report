import {
  Alert,
  Dialog,
  SegmentedRadioGroup,
  Select,
  Text,
  TextArea,
  TextInput,
} from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/endpoints';
import { fieldErrors } from '../../api/errors';
import { Field } from '../../components/Field';
import { GeneralError } from '../../components/GeneralError';

type Source = 'docx' | 'xlsx' | 'upload';

export function CreateTemplateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const datasources = useQuery({
    queryKey: ['datasources'],
    queryFn: api.datasources.list,
    enabled: open,
  });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [datasourceId, setDatasourceId] = useState('');
  const [source, setSource] = useState<Source>('docx');
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    const first = datasources.data?.[0];
    if (!datasourceId && first) setDatasourceId(first.id);
  }, [datasources.data, datasourceId]);

  const create = useMutation({
    mutationFn: () => {
      if (source === 'upload') {
        const form = new FormData();
        form.append('name', name);
        form.append('description', description);
        form.append('datasourceId', datasourceId);
        form.append('file', file!);
        return api.templates.upload(form);
      }
      return api.templates.create({ name, description, datasourceId, blank: source });
    },
    onSuccess: async (t) => {
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
      onClose();
      navigate(`/admin/templates/${t.id}`);
    },
  });
  const errors = fieldErrors(create.error);
  const noDatasources = datasources.data?.length === 0;

  return (
    <Dialog open={open} onClose={onClose} aria-labelledby="cr-tpl-create">
      <Dialog.Header caption="Новый шаблон" id="cr-tpl-create" />
      <Dialog.Body>
        {noDatasources ? (
          <Alert
            theme="warning"
            message={
              <>
                Сначала добавьте источник данных в разделе{' '}
                <Link to="/admin/datasources">«Источники данных»</Link>.
              </>
            }
          />
        ) : (
          <div className="cr-form">
            <Field label="Название">
              <TextInput
                value={name}
                onUpdate={setName}
                validationState={errors.name ? 'invalid' : undefined}
                errorMessage={errors.name}
                controlProps={{ 'aria-label': 'Название' }}
              />
            </Field>
            <Field label="Описание">
              <TextArea value={description} onUpdate={setDescription} minRows={2} />
            </Field>
            <Field label="Источник данных">
              <Select
                value={datasourceId ? [datasourceId] : []}
                onUpdate={([v]) => setDatasourceId(v ?? '')}
                options={(datasources.data ?? []).map((d) => ({ value: d.id, content: d.name }))}
                width="max"
              />
            </Field>
            <div className="cr-field">
              <Text variant="subheader-1">Файл</Text>
              <SegmentedRadioGroup
                value={source}
                onUpdate={(v) => setSource(v as Source)}
                options={[
                  { value: 'docx', content: 'Пустой DOCX' },
                  { value: 'xlsx', content: 'Пустой XLSX' },
                  { value: 'upload', content: 'Загрузить файл' },
                ]}
              />
            </div>
            {source === 'upload' && (
              <input
                type="file"
                aria-label="Файл шаблона"
                accept=".docx,.xlsx,.odt,.ods,.pptx"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            )}
            <GeneralError error={create.error} errors={errors} shown={['name']} />
          </div>
        )}
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => create.mutate()}
        onClickButtonCancel={onClose}
        textButtonApply="Создать"
        textButtonCancel="Отмена"
        loading={create.isPending}
        propsButtonApply={{
          disabled: noDatasources || !name || !datasourceId || (source === 'upload' && !file),
        }}
      />
    </Dialog>
  );
}
