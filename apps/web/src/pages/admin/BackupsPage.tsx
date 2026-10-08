import type { BackupDto, BackupOperationDto } from '@carbone-reports/shared';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Alert, Button, Label, Loader, Table, Text, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import {
  formatSize,
  KIND_LABEL,
  PHASE_LABEL,
  requestedByLabel,
  STATUS_LABEL,
} from '../../lib/backups';
import { formatDateTime } from '../../lib/format';
import { RestoreDialog } from './RestoreDialog';

const backupsKey = ['backups'] as const;
const operationKey = ['backups', 'operation'] as const;
const STATUS_THEME = { running: 'info', succeeded: 'success', failed: 'danger' } as const;

function OperationPanel({ op }: { op: BackupOperationDto }) {
  return (
    <div className="cr-backup-operation">
      <Text variant="subheader-2" as="div">
        {op.type === 'backup' ? 'Бэкап' : `Восстановление из ${op.backup ?? '—'}`}
      </Text>
      <Text as="div" color="secondary">
        Запустил: {requestedByLabel(op.requestedBy)} · {formatDateTime(op.startedAt)}
      </Text>
      <Text as="div">Этап: {PHASE_LABEL[op.phase]}</Text>
      <span data-testid="operation-status">
        <Label theme={STATUS_THEME[op.status]}>{STATUS_LABEL[op.status]}</Label>
      </span>
      {op.error && <Alert theme="danger" message={op.error} />}
      <details>
        <summary>Журнал</summary>
        <pre className="cr-backup-log">{op.log.join('\n')}</pre>
      </details>
    </div>
  );
}

export function BackupsPage() {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const backups = useQuery({ queryKey: backupsKey, queryFn: api.backups.list });
  const operation = useQuery({
    queryKey: operationKey,
    queryFn: api.backups.operation,
    // §26.5: пока операция идёт, панель опрашивается раз в 2 с.
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });
  const running = operation.data?.status === 'running';
  const wasRunning = useRef(false);
  useEffect(() => {
    // Операция закончилась — в списке появился новый бэкап (или pre-restore).
    if (wasRunning.current && !running)
      void queryClient.invalidateQueries({ queryKey: backupsKey, exact: true });
    wasRunning.current = running;
  }, [running, queryClient]);
  const [restoring, setRestoring] = useState<BackupDto | null>(null);

  const fail = (e: unknown) =>
    add({
      name: `backups-error-${Date.now()}`,
      title: 'Ошибка',
      content: errorMessage(e),
      theme: 'danger',
    });
  const refreshOperation = () => queryClient.invalidateQueries({ queryKey: operationKey });
  const create = useMutation({
    mutationFn: api.backups.create,
    onSuccess: refreshOperation,
    onError: fail,
  });

  const columns: TableColumnConfig<BackupDto>[] = [
    {
      id: 'date',
      name: 'Дата',
      template: (b) => (
        <div>
          <div>{formatDateTime(b.createdAt)}</div>
          <Text color="secondary" variant="caption-2">
            {b.name}
          </Text>
        </div>
      ),
    },
    {
      id: 'kind',
      name: 'Тип',
      template: (b) =>
        b.kind === 'pre-restore' ? (
          <Label theme="info">{KIND_LABEL[b.kind]}</Label>
        ) : (
          KIND_LABEL[b.kind]
        ),
    },
    {
      id: 'size',
      name: 'Размер',
      template: (b) => `база ${formatSize(b.dbSize)} · файлы ${formatSize(b.storageSize)}`,
    },
    {
      id: 'migration',
      name: 'Миграция',
      template: (b) =>
        b.lastMigration ? <span title={b.lastMigration}>{b.lastMigration.slice(0, 12)}</span> : '—',
    },
    {
      id: 'status',
      name: 'Статус',
      template: (b) =>
        b.status === 'ok' ? (
          <Label theme="success">готов</Label>
        ) : (
          <Label theme="warning">незавершён</Label>
        ),
    },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (b) =>
        b.status === 'ok' ? (
          <Button
            view="outlined-danger"
            size="s"
            disabled={running}
            onClick={() => setRestoring(b)}
          >
            Восстановить
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Бэкапы"
        actions={
          <Button
            view="action"
            loading={create.isPending}
            disabled={running}
            onClick={() => create.mutate()}
          >
            Сделать бэкап
          </Button>
        }
      />
      <ErrorAlert error={operation.error} title="Не удалось получить состояние операции" />
      {operation.data && <OperationPanel op={operation.data} />}
      <ErrorAlert error={backups.error} title="Не удалось получить список бэкапов" />
      {backups.isPending ? (
        <Loader />
      ) : (
        backups.data && (
          <Table
            data={backups.data}
            columns={columns}
            emptyMessage="Бэкапов пока нет"
            width="max"
          />
        )
      )}
      <RestoreDialog
        backup={restoring}
        onClose={() => setRestoring(null)}
        onStarted={() => void refreshOperation()}
      />
    </>
  );
}
