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
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api } from '../../api/endpoints';
import { fieldErrors } from '../../api/errors';
import { usePermissions } from '../../app/permissions';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { GeneralError } from '../../components/GeneralError';

type Source = 'docx' | 'xlsx' | 'upload';

export function CreateTemplateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdmin } = usePermissions();
  const datasources = useQuery({
    queryKey: ['datasources', 'options'],
    queryFn: api.datasources.options,
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
    <Dialog
      open={open}
      onClose={create.isPending ? () => {} : onClose}
      aria-labelledby="cr-tpl-create"
    >
      <Dialog.Header caption={t('templates:create.title')} id="cr-tpl-create" />
      <Dialog.Body>
        {noDatasources ? (
          <Alert
            theme="warning"
            message={
              isAdmin ? (
                <Trans
                  i18nKey="templates:create.noDatasourcesAdmin"
                  components={{ page: <Link to="/admin/datasources" /> }}
                />
              ) : (
                t('templates:create.noDatasources')
              )
            }
          />
        ) : (
          <div className="cr-form">
            <ErrorAlert error={datasources.error} />
            <Field label={t('admin:field.name')}>
              <TextInput
                value={name}
                onUpdate={setName}
                validationState={errors.name ? 'invalid' : undefined}
                errorMessage={errors.name}
                controlProps={{ 'aria-label': t('admin:field.name') }}
              />
            </Field>
            <Field label={t('admin:field.description')}>
              <TextArea
                controlProps={{ 'aria-label': t('admin:field.description') }}
                value={description}
                onUpdate={setDescription}
                minRows={2}
              />
            </Field>
            <Field label={t('templates:create.datasource')}>
              <Select
                aria-label={t('templates:create.datasource')}
                disabled={datasources.isPending}
                value={datasourceId ? [datasourceId] : []}
                onUpdate={([v]) => setDatasourceId(v ?? '')}
                options={(datasources.data ?? []).map((d) => ({ value: d.id, content: d.name }))}
                width="max"
              />
            </Field>
            <div className="cr-field">
              <Text variant="subheader-1">{t('templates:create.file')}</Text>
              <SegmentedRadioGroup
                value={source}
                onUpdate={(v) => {
                  setSource(v as Source);
                  setFile(null);
                }}
                options={[
                  { value: 'docx', content: t('templates:create.blankDocx') },
                  { value: 'xlsx', content: t('templates:create.blankXlsx') },
                  { value: 'upload', content: t('templates:create.upload') },
                ]}
              />
            </div>
            {source === 'upload' && (
              <input
                type="file"
                aria-label={t('templates:create.fileAria')}
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
        onClickButtonCancel={create.isPending ? () => {} : onClose}
        textButtonApply={t('admin:create')}
        textButtonCancel={t('common:action.cancel')}
        loading={create.isPending}
        propsButtonApply={{
          disabled: noDatasources || !name || !datasourceId || (source === 'upload' && !file),
        }}
      />
    </Dialog>
  );
}
