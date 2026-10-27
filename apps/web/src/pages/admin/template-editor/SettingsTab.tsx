import type { OutputFormat, TemplateAccess, TemplateAdminDetails } from '@carbone-reports/shared';
import { LOCALE_NAMES, REPORT_LOCALES, type ReportLocale } from '@carbone-reports/shared/i18n';
import { Button, Loader, Select, Text, TextArea, TextInput, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/endpoints';
import { useBridgeDirty } from '../../../features/assistant/bridge';
import { errorMessage, fieldErrors } from '../../../api/errors';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import { ACCESS_FIELDS, AccessFields, sameAccess, useSaveTemplateAccess } from '../AccessFields';
import { EditorsBlock } from './EditorsBlock';
import { applyTemplate } from './editorState';

const SHOWN = ['name', 'description', 'datasourceId', 'defaultOutput', 'reportLocale'];

export function SettingsTab({
  template,
  holder,
}: {
  template: TemplateAdminDetails;
  /** Номер вкладки «Документ» этой страницы: собственная блокировка замене файла не мешает (§38.2). */
  holder?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const datasources = useQuery({
    queryKey: ['datasources', 'options'],
    queryFn: api.datasources.options,
  });
  const pick = (tpl: TemplateAdminDetails) => ({
    name: tpl.name,
    description: tpl.description,
    datasourceId: tpl.datasourceId,
    defaultOutput: tpl.defaultOutput,
    reportLocale: tpl.reportLocale,
  });
  const [baseline, setBaseline] = useState(template);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [datasourceId, setDatasourceId] = useState(template.datasourceId);
  const [defaultOutput, setDefaultOutput] = useState<OutputFormat>(template.defaultOutput);
  const [reportLocale, setReportLocale] = useState<ReportLocale>(template.reportLocale);
  const dirty =
    JSON.stringify({ name, description, datasourceId, defaultOutput, reportLocale }) !==
    JSON.stringify(pick(baseline));
  const reseed = (tpl: TemplateAdminDetails) => {
    setBaseline(tpl);
    setName(tpl.name);
    setDescription(tpl.description);
    setDatasourceId(tpl.datasourceId);
    setDefaultOutput(tpl.defaultOutput);
    setReportLocale(tpl.reportLocale);
  };
  // Шаблон обновился на сервере: без несохранённых правок подхватываем, иначе сохраняем черновик.
  const stale = template.updatedAt !== baseline.updatedAt;
  if (stale && !dirty) reseed(template);
  // Правки настроек не теряются при применении карточки ассистента (§51.5).
  useBridgeDirty(dirty);

  const save = useMutation({
    mutationFn: () =>
      api.templates.update(template.id, {
        name,
        description,
        datasourceId,
        defaultOutput,
        reportLocale,
      }),
    onSuccess: (tpl) => {
      applyTemplate(queryClient, tpl);
      reseed(tpl);
      add({
        name: `tpl-settings-${Date.now()}`,
        title: t('editor:settings.saved'),
        theme: 'success',
      });
    },
  });
  const replace = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.templates.replaceFile(template.id, form, holder);
    },
    onSuccess: (tpl) => {
      applyTemplate(queryClient, tpl);
      add({
        name: `tpl-file-${Date.now()}`,
        title: t('editor:settings.fileReplaced', { version: tpl.version }),
        theme: 'success',
      });
    },
    onError: (e) =>
      add({
        name: `tpl-file-err-${Date.now()}`,
        title: t('editor:settings.fileNotReplaced'),
        content: errorMessage(e),
        theme: 'danger',
      }),
  });
  const errors = fieldErrors(save.error);

  return (
    <div className="cr-form">
      <Field label={t('admin:field.name')} error={errors.name}>
        <TextInput
          value={name}
          onUpdate={setName}
          validationState={errors.name ? 'invalid' : undefined}
          controlProps={{ 'aria-label': t('editor:settings.nameAria') }}
        />
      </Field>
      <Field label={t('admin:field.description')} error={errors.description}>
        <TextArea value={description} onUpdate={setDescription} minRows={2} />
      </Field>
      <Field label={t('editor:settings.datasource')} error={errors.datasourceId}>
        <Select
          value={[datasourceId]}
          onUpdate={([v]) => v && setDatasourceId(v)}
          options={(datasources.data ?? []).map((d) => ({ value: d.id, content: d.name }))}
          width="max"
        />
      </Field>
      <Field label={t('editor:settings.defaultOutput')} error={errors.defaultOutput}>
        <Select
          value={[defaultOutput]}
          onUpdate={([v]) => v && setDefaultOutput(v as OutputFormat)}
          options={template.outputFormats.map((f) => ({ value: f, content: f.toUpperCase() }))}
          width="max"
        />
      </Field>
      <Field
        label={t('editor:settings.reportLocale')}
        hint={t('editor:settings.reportLocaleHint')}
        error={errors.reportLocale}
      >
        <Select
          value={[reportLocale]}
          onUpdate={([v]) => v && setReportLocale(v as ReportLocale)}
          options={REPORT_LOCALES.map((l) => ({
            value: l,
            content: l === 'user' ? t('editor:settings.reportLocaleUser') : LOCALE_NAMES[l],
          }))}
          width="max"
          aria-label={t('editor:settings.reportLocale')}
        />
      </Field>
      {datasources.error && (
        <ErrorAlert error={datasources.error} title={t('editor:settings.datasourcesLoadFailed')} />
      )}
      {dirty && stale && <Text color="warning">{t('editor:draft.stale')}</Text>}
      <GeneralError error={save.error} errors={errors} shown={SHOWN} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          view="action"
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!dirty}
        >
          {t('editor:settings.save')}
        </Button>
        {dirty && (
          <>
            <Text color="warning">{t('editor:draft.unsaved')}</Text>
            <Button
              view="flat"
              aria-label={t('editor:settings.discardAria')}
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
      <AccessSection templateId={template.id} />
      {template.canManageEditors && <EditorsBlock template={template} />}
      <div className="cr-field" style={{ marginTop: 16 }}>
        <Text variant="subheader-1">{t('editor:settings.replaceFile')}</Text>
        <Text color="secondary" variant="caption-2">
          {t('editor:settings.replaceFileHint', { ext: template.fileExt })}
        </Text>
        <input
          type="file"
          aria-label={t('editor:settings.newFileAria')}
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
  const { t } = useTranslation();
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
  useBridgeDirty(dirty);

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
        {t('editor:settings.access')}
      </Text>
      <ErrorAlert error={access.error} title={t('editor:settings.accessLoadFailed')} />
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
              {t('editor:settings.saveAccess')}
            </Button>
            {dirty && (
              <>
                <Text color="warning">{t('editor:draft.unsaved')}</Text>
                <Button
                  view="flat"
                  aria-label={t('editor:settings.discardAccessAria')}
                  onClick={discard}
                >
                  {t('editor:draft.discard')}
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
