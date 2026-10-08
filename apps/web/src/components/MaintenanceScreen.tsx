import type { RecoveryTargets } from '@carbone-reports/shared';
import { Alert, Button, Loader, Text, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/endpoints';
import { PHASE_LABEL } from '../lib/backups';
import { ErrorAlert } from './ErrorAlert';
import { Field } from './Field';

/** §26.5: экран опрашивает /api/maintenance раз в 3 с. */
export const MAINTENANCE_POLL_MS = 3000;

const reloadPage = () => window.location.reload();

function RecoveryForm({ recovery }: { recovery: RecoveryTargets }) {
  const [code, setCode] = useState('');
  const retry = useMutation({
    mutationFn: (target: 'same' | 'pre-restore') => api.maintenance.retry({ code, target }),
  });
  const disabled = !code.trim() || retry.isPending;
  return (
    <div className="cr-form">
      <Alert
        theme="danger"
        title="Восстановление не завершено: база частично заменена"
        message="Введите код восстановления из журнала сервиса backup (docker compose logs backup) и выберите действие."
      />
      <Field label="Код восстановления">
        <TextInput
          value={code}
          onUpdate={setCode}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          controlProps={{ 'aria-label': 'Код восстановления' }}
        />
      </Field>
      <ErrorAlert error={retry.error} />
      {retry.isSuccess && <Text color="secondary">Повтор запущен, ждём завершения…</Text>}
      <Button
        view="action"
        disabled={disabled}
        loading={retry.isPending && retry.variables === 'same'}
        onClick={() => retry.mutate('same')}
      >
        Повторить восстановление из {recovery.backup}
      </Button>
      {recovery.preRestore && (
        <Button
          view="outlined-danger"
          disabled={disabled}
          loading={retry.isPending && retry.variables === 'pre-restore'}
          onClick={() => retry.mutate('pre-restore')}
        >
          Вернуть состояние до восстановления ({recovery.preRestore})
        </Button>
      )}
    </div>
  );
}

/** Экран на всю страницу, пока идёт восстановление из бэкапа (§26.5). */
export function MaintenanceScreen({ reload = reloadPage }: { reload?: () => void }) {
  const status = useQuery({
    queryKey: ['maintenance'],
    queryFn: api.maintenance.status,
    refetchInterval: MAINTENANCE_POLL_MS,
  });
  const data = status.data;
  useEffect(() => {
    if (data && !data.active) reload();
  }, [data, reload]);
  const recovery = data?.active ? data.recovery : null;
  return (
    <div className="cr-centered">
      <div className="cr-maintenance">
        {!recovery && <Loader size="m" />}
        <Text variant="header-1" as="h1">
          Идёт восстановление из бэкапа…
        </Text>
        {data?.active && (
          <Text as="div" color="secondary">
            Этап: {PHASE_LABEL[data.phase] ?? data.phase} · бэкап {data.backup}
          </Text>
        )}
        {recovery && <RecoveryForm recovery={recovery} />}
      </div>
    </div>
  );
}
