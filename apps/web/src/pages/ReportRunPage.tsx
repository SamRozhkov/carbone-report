import type { OutputFormat, ParamsInput } from '@carbone-reports/shared';
import { Alert, Button, Loader, SegmentedRadioGroup, Text } from '@gravity-ui/uikit';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, runFileUrl } from '../api/endpoints';
import { ApiRequestError } from '../api/client';
import { fieldErrors } from '../api/errors';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageHeader';
import { ParamForm } from '../components/ParamForm';
import { triggerDownload } from '../lib/download';
import { initialValues, pickParams } from '../lib/params';

export function ReportRunRoute() {
  const { id = '' } = useParams();
  return <ReportRunPage key={id} />;
}

export function ReportRunPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const template = useQuery({ queryKey: ['template', id], queryFn: () => api.templates.get(id) });
  const t = template.data;

  const [values, setValues] = useState<ParamsInput>({});
  const [format, setFormat] = useState<OutputFormat>('pdf');
  const [run, setRun] = useState<{ id: string; format: OutputFormat } | null>(null);

  // Форма строится заново, если шаблон сменился или админ изменил его описание.
  const version = t ? `${t.id}:${t.updatedAt}` : '';
  useEffect(() => {
    if (!t) return;
    setValues(initialValues(t.params));
    setFormat(t.defaultOutput);
    setRun(null);
  }, [version]);

  const render = useMutation({
    mutationFn: () => api.reports.render(id, { params: pickParams(t!.params, values), format }),
    onSuccess: ({ runId }) => {
      setRun({ id: runId, format });
      if (format !== 'pdf') triggerDownload(runFileUrl(runId));
    },
    onError: (e) => {
      if (e instanceof ApiRequestError && e.code === 'VALIDATION') void template.refetch();
    },
  });

  if (template.isPending) return <Loader />;
  if (!t) return <ErrorAlert error={template.error} title="Не удалось открыть отчёт" />;

  const errors = fieldErrors(render.error);
  const declared = new Set(t.params.map((p) => p.name));
  const unmatched = Object.entries(errors).filter(([k]) => !declared.has(k));
  const paramLike = unmatched.some(([k]) => k !== '_');
  const generalError = render.error && Object.keys(errors).length === 0 ? render.error : null;

  return (
    <>
      <PageHeader
        title={t.name}
        actions={
          <Button view="flat" onClick={() => navigate('/reports')}>
            К списку
          </Button>
        }
      />
      {t.description && (
        <Text color="secondary" as="p">
          {t.description}
        </Text>
      )}
      <div className="cr-run">
        <form
          className="cr-form"
          onSubmit={(e) => {
            e.preventDefault();
            setRun(null);
            render.mutate();
          }}
        >
          {t.params.length === 0 && <Text color="secondary">У отчёта нет параметров.</Text>}
          <ParamForm
            params={t.params}
            values={values}
            onChange={setValues}
            errors={errors}
            disabled={render.isPending}
          />
          <div className="cr-field">
            <Text variant="subheader-1">Формат</Text>
            <SegmentedRadioGroup
              value={format}
              onUpdate={(v) => setFormat(v as OutputFormat)}
              options={t.outputFormats.map((f) => ({ value: f, content: f.toUpperCase() }))}
            />
          </div>
          <ErrorAlert error={generalError} />
          {unmatched.length > 0 && (
            <Alert
              theme="danger"
              title={paramLike ? 'Параметры отчёта изменились — форма обновлена' : undefined}
              message={unmatched.map(([k, m]) => (k === '_' ? m : `${k}: ${m}`)).join('\n')}
            />
          )}
          <div>
            <Button view="action" size="l" type="submit" loading={render.isPending}>
              Сформировать
            </Button>
          </div>
        </form>
        <div>
          {run && (
            <>
              <div className="cr-page-header">
                <Text variant="subheader-2">Отчёт готов</Text>
                <Button view="outlined" href={runFileUrl(run.id)}>
                  Скачать
                </Button>
              </div>
              {run.format === 'pdf' && (
                <iframe
                  title="Предпросмотр отчёта"
                  src={runFileUrl(run.id, true)}
                  className="cr-pdf"
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
