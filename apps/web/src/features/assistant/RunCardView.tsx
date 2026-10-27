import type { RunCard } from '@carbone-reports/shared';
import { Button, Link, Text } from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { api } from '../../api/endpoints';
import { useRunDownload } from '../../api/useRunDownload';
import { ErrorAlert } from '../../components/ErrorAlert';

/** Карточка запуска (§50.5): сформировать по параметрам ассистента или открыть их в форме отчёта. */
export function RunCardView({ card }: { card: RunCard }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const download = useRunDownload();
  const render = useMutation({
    mutationFn: () => api.reports.render(card.reportId, { params: card.params }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['runs'] }),
  });
  const runId = render.data?.runId;

  return (
    <div className="cr-assistant__card">
      <Text variant="subheader-1">{card.reportName}</Text>
      {card.display.length > 0 && (
        <dl className="cr-assistant__params">
          {card.display.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="cr-assistant__actions">
        <Button
          view="action"
          loading={render.isPending}
          onClick={() => {
            download.reset();
            render.mutate();
          }}
        >
          {t('common:assistant.generate')}
        </Button>
        <Button
          view="outlined"
          onClick={() =>
            navigate(`/reports/${card.reportId}`, { state: { assistantParams: card.params } })
          }
        >
          {t('common:assistant.openForm')}
        </Button>
      </div>
      <ErrorAlert error={render.error} />
      {runId && (
        <>
          <Text>{t('common:assistant.ready')}</Text>
          <div className="cr-assistant__actions">
            {card.outputFormats.map((f) => {
              const busy = download.pending?.runId === runId && download.pending.format === f;
              return (
                <Button
                  key={f}
                  view={f === card.defaultOutput ? 'action' : 'outlined'}
                  loading={busy}
                  disabled={!!download.pending && !busy}
                  onClick={() => download.save({ runId, format: f })}
                >
                  {f.toUpperCase()}
                </Button>
              );
            })}
            <Link
              href="/history"
              onClick={(e) => {
                e.preventDefault();
                navigate('/history');
              }}
            >
              {t('common:assistant.history')}
            </Link>
          </div>
          <ErrorAlert error={download.error} />
        </>
      )}
    </div>
  );
}
