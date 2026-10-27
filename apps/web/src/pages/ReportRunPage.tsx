import type { ParamsInput, RunSignature } from '@carbone-reports/shared';
import { Alert, Button, Link, Loader, Text } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router';
import { api, runFileUrl } from '../api/endpoints';
import { ApiRequestError } from '../api/client';
import { fieldErrors } from '../api/errors';
import { useRunDownload } from '../api/useRunDownload';
import { ErrorAlert } from '../components/ErrorAlert';
import { SignGostDialog } from '../components/SignGostDialog';
import { SignRunDialog } from '../components/SignRunDialog';
import { PageHeader } from '../components/PageHeader';
import { ParamForm } from '../components/ParamForm';
import { formatDateTime } from '../lib/format';
import { initialValues, pickParams } from '../lib/params';
import { certificateState, myCertificateKey } from './SignaturePage';

export function ReportRunRoute() {
  const { id = '' } = useParams();
  return <ReportRunPage key={id} />;
}

export function ReportRunPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const queryClient = useQueryClient();
  // t — описание шаблона, поэтому функция перевода — tr.
  const { t: tr } = useTranslation();
  const template = useQuery({ queryKey: ['template', id], queryFn: () => api.templates.get(id) });
  const t = template.data;

  const [values, setValues] = useState<ParamsInput>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [signature, setSignature] = useState<RunSignature | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  // ГОСТ подписывается сертификатом из КриптоПро на компьютере пользователя: .p12 не нужен (§42.7).
  const gost = t?.signMethod === 'gost';
  const cert = useQuery({
    queryKey: myCertificateKey,
    queryFn: api.signature.get,
    enabled: t?.signatureAllowed === true && !gost,
  });
  const download = useRunDownload();
  const resetDownload = download.reset;

  // Форма строится заново, если шаблон сменился, админ изменил его описание или ассистент
  // передал новые параметры («Открыть форму» на уже открытом отчёте).
  const version = t ? `${t.id}:${t.updatedAt}` : '';
  useEffect(() => {
    if (!t) return;
    // Параметры из карточки ассистента (§50.5) — вместо значений по умолчанию, только объявленные.
    const fromAssistant =
      (state as { assistantParams?: ParamsInput } | null)?.assistantParams ?? {};
    const declared = Object.fromEntries(
      t.params
        .filter((p) => Object.hasOwn(fromAssistant, p.name))
        .map((p) => [p.name, fromAssistant[p.name]!]),
    );
    setValues({ ...initialValues(t.params), ...declared });
    setRunId(null);
    setSignature(null);
    setSignOpen(false);
    resetDownload();
  }, [version, state]);

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
  if (!t) return <ErrorAlert error={template.error} title={tr('reports:run.openFailed')} />;

  const certificate = cert.data?.certificate ?? null;
  const canSign = gost || (certificate !== null && certificateState(certificate) !== 'expired');
  const onSigned = (s: RunSignature) => {
    setSignature(s);
    setSignOpen(false);
    void queryClient.invalidateQueries({ queryKey: ['runs'] });
  };
  const pendingSigned = download.pending?.runId === runId ? download.pending : undefined;
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
            {tr('reports:run.back')}
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
            setSignature(null);
            download.reset();
            render.mutate();
          }}
        >
          {t.params.length === 0 && <Text color="secondary">{tr('reports:run.noParams')}</Text>}
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
              title={paramLike ? tr('reports:run.paramsChanged') : undefined}
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
              {tr('reports:run.generate')}
            </Button>
            {optionsLoading && <Text color="secondary">{tr('reports:run.optionsLoading')}</Text>}
          </div>
        </form>
        <div>
          {runId && (
            <>
              <div className="cr-page-header">
                <Text variant="subheader-2">{tr('reports:run.ready')}</Text>
              </div>
              {/* Просмотр всегда в PDF, для Excel тоже (§24.1). */}
              <iframe
                title={tr('reports:run.preview')}
                src={runFileUrl(runId, { format: 'pdf', inline: true })}
                className="cr-pdf cr-pdf_run"
              />
              <div className="cr-save" role="group" aria-label={tr('reports:run.saveAs')}>
                <Text variant="subheader-1">{tr('reports:run.saveAs')}</Text>
                {t.outputFormats.map((f) => {
                  const busy =
                    download.pending?.runId === runId &&
                    download.pending.format === f &&
                    !download.pending.signed;
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
              {t.signatureAllowed && (
                <div className="cr-save">
                  {signature ? (
                    <>
                      <Text>
                        {tr(
                          signature.timestamped
                            ? 'reports:run.signedTimestamped'
                            : 'reports:run.signed',
                          {
                            signer: signature.signerCn,
                            date: formatDateTime(signature.signedAt),
                          },
                        )}
                      </Text>
                      {signature.method === 'gost' ? (
                        <>
                          <Button
                            view="outlined"
                            size="l"
                            loading={!!pendingSigned?.signed}
                            disabled={!!download.pending && !pendingSigned?.signed}
                            onClick={() => download.save({ runId, format: 'pdf', signed: true })}
                          >
                            {tr('reports:run.downloadStamped')}
                          </Button>
                          <Button
                            view="outlined"
                            size="l"
                            loading={pendingSigned?.format === 'sig'}
                            disabled={!!download.pending && pendingSigned?.format !== 'sig'}
                            onClick={() => download.save({ runId, format: 'sig' })}
                          >
                            {tr('reports:run.downloadSig')}
                          </Button>
                          <Text color="secondary">{tr('signature:dialog.authenticityNote')}</Text>
                        </>
                      ) : (
                        <Button
                          view="outlined"
                          size="l"
                          loading={!!pendingSigned?.signed}
                          onClick={() => download.save({ runId, format: 'pdf', signed: true })}
                        >
                          {tr('reports:run.downloadSigned')}
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      <Button
                        view="outlined"
                        size="l"
                        disabled={!canSign}
                        onClick={() => setSignOpen(true)}
                      >
                        {tr('reports:run.sign')}
                      </Button>
                      {!gost && cert.isSuccess && !certificate && (
                        <Text color="secondary">
                          <Trans
                            t={tr}
                            i18nKey="reports:run.uploadCertificate"
                            components={{
                              page: (
                                <Link
                                  href="/signature"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    navigate('/signature');
                                  }}
                                />
                              ),
                            }}
                          />
                        </Text>
                      )}
                    </>
                  )}
                </div>
              )}
              <ErrorAlert error={download.error} title={tr('reports:run.saveFailed')} />
              {signOpen && gost && (
                <SignGostDialog
                  runId={runId}
                  open
                  onClose={() => setSignOpen(false)}
                  onSigned={onSigned}
                />
              )}
              {signOpen && !gost && (
                <SignRunDialog
                  runId={runId}
                  open
                  onClose={() => setSignOpen(false)}
                  onSigned={onSigned}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
