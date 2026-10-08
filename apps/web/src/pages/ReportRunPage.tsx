import type { ParamsInput } from '@carbone-reports/shared';
import { Alert, Button, Loader, Text } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, runFileUrl } from '../api/endpoints';
import { ApiRequestError } from '../api/client';
import { fieldErrors } from '../api/errors';
import { useRunDownload } from '../api/useRunDownload';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageHeader';
import { ParamForm } from '../components/ParamForm';
import { initialValues, pickParams } from '../lib/params';

export function ReportRunRoute() {
  const { id = '' } = useParams();
  return <ReportRunPage key={id} />;
}

export function ReportRunPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const template = useQuery({ queryKey: ['template', id], queryFn: () => api.templates.get(id) });
  const t = template.data;

  const [values, setValues] = useState<ParamsInput>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const download = useRunDownload();
  const resetDownload = download.reset;

  // Форма строится заново, если шаблон сменился или админ изменил его описание.
  const version = t ? `${t.id}:${t.updatedAt}` : '';
  useEffect(() => {
    if (!t) return;
    setValues(initialValues(t.params));
    setRunId(null);
    resetDownload();
  }, [version]);

  // Формата при формировании нет (§24.1): сервер сохраняет снимок и собирает PDF для просмотра.
  const render = useMutation({
    mutationFn: () => api.reports.render(id, { params: pickParams(t!.params, values) }),
    onSuccess: ({ runId }) => setRunId(runId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['runs'] }),
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
            setRunId(null);
            download.reset();
            render.mutate();
          }}
        >
          {t.params.length === 0 && <Text color="secondary">У отчёта нет параметров.</Text>}
          <ParamForm
            templateId={t.id}
            params={t.params}
            values={values}
            onChange={setValues}
            errors={errors}
            disabled={render.isPending}
            onOptionsLoadingChange={setOptionsLoading}
          />
          <ErrorAlert error={generalError} />
          {unmatched.length > 0 && (
            <Alert
              theme="danger"
              title={paramLike ? 'Параметры отчёта изменились — форма обновлена' : undefined}
              message={unmatched.map(([k, m]) => (k === '_' ? m : `${k}: ${m}`)).join('; ')}
            />
          )}
          <div className="cr-run-actions">
            <Button
              view="action"
              size="l"
              type="submit"
              loading={render.isPending}
              disabled={optionsLoading}
            >
              Сформировать
            </Button>
            {optionsLoading && <Text color="secondary">Загружаются варианты параметров…</Text>}
          </div>
        </form>
        <div>
          {runId && (
            <>
              <div className="cr-page-header">
                <Text variant="subheader-2">Отчёт готов</Text>
              </div>
              {/* Просмотр всегда в PDF, для Excel тоже (§24.1). */}
              <iframe
                title="Предпросмотр отчёта"
                src={runFileUrl(runId, { format: 'pdf', inline: true })}
                className="cr-pdf cr-pdf_run"
              />
              <div className="cr-save" role="group" aria-label="Сохранить как">
                <Text variant="subheader-1">Сохранить как</Text>
                {t.outputFormats.map((f) => {
                  const busy = download.pending?.runId === runId && download.pending.format === f;
                  return (
                    <Button
                      key={f}
                      view={f === t.defaultOutput ? 'action' : 'outlined'}
                      size="l"
                      loading={busy}
                      disabled={!!download.pending && !busy}
                      onClick={() => download.save({ runId, format: f })}
                    >
                      {f.toUpperCase()}
                    </Button>
                  );
                })}
              </div>
              <ErrorAlert error={download.error} title="Не удалось сохранить файл" />
            </>
          )}
        </div>
      </div>
    </>
  );
}
