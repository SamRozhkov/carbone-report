import type { BackupDto, BackupOperationDto } from '@carbone-reports/shared';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Alert, Button, Label, Loader, Table, Text, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import { formatSize, requestedByLabel } from '../../lib/backups';
import { formatDateTime } from '../../lib/format';
import { RestoreDialog } from './RestoreDialog';

const backupsKey = ['backups'] as const;
const operationKey = ['backups', 'operation'] as const;
const STATUS_THEME = { running: 'info', succeeded: 'success', failed: 'danger' } as const;
const STATUS_KEY = {
  running: 'admin:backups.statusRunning',
  succeeded: 'admin:backups.statusSucceeded',
  failed: 'admin:backups.statusFailed',
} as const;
const KIND_KEY = {
  regular: 'admin:backups.kindRegular',
  'pre-restore': 'admin:backups.kindPreRestore',
} as const;

function OperationPanel({ op }: { op: BackupOperationDto }) {
  const { t } = useTranslation();
  return (
    <div className="cr-backup-operation">
      <Text variant="subheader-2" as="div">
        {op.type === 'backup'
          ? t('admin:backups.opBackup')
          : t('admin:backups.opRestore', { backup: op.backup ?? '—' })}
      </Text>
      <Text as="div" color="secondary">
        {t('admin:backups.startedBy', {
          by: requestedByLabel(op.requestedBy),
          date: formatDateTime(op.startedAt),
        })}
      </Text>
      <Text as="div">
        {t('admin:backups.phase', {
          phase: t(`common:backupPhase.${op.phase}`, { defaultValue: op.phase }),
        })}
      </Text>
      <span data-testid="operation-status">
        <Label theme={STATUS_THEME[op.status]}>{t(STATUS_KEY[op.status])}</Label>
      </span>
      {op.error && <Alert theme="danger" message={op.error} />}
      <details>
        <summary>{t('admin:backups.log')}</summary>
        <pre className="cr-backup-log">{op.log.join('\n')}</pre>
      </details>
    </div>
  );
}

export function BackupsPage() {
  const { t } = useTranslation();
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
      title: t('common:status.error'),
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
      name: t('admin:backups.date'),
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
      name: t('admin:backups.kind'),
      template: (b) =>
        b.kind === 'pre-restore' ? (
          <Label theme="info">{t(KIND_KEY[b.kind])}</Label>
        ) : (
          t(KIND_KEY[b.kind])
        ),
    },
    {
      id: 'size',
      name: t('admin:backups.size'),
      template: (b) =>
        t('admin:backups.sizes', { db: formatSize(b.dbSize), files: formatSize(b.storageSize) }),
    },
    {
      id: 'migration',
      name: t('admin:backups.migration'),
      template: (b) =>
        b.lastMigration ? <span title={b.lastMigration}>{b.lastMigration.slice(0, 12)}</span> : '—',
    },
    {
      id: 'status',
      name: t('admin:field.status'),
      template: (b) =>
        b.status === 'ok' ? (
          <Label theme="success">{t('admin:backups.ready')}</Label>
        ) : (
          <Label theme="warning">{t('admin:backups.incomplete')}</Label>
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
            {t('admin:backups.restore')}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title={t('common:nav.backups')}
        actions={
          <Button
            view="action"
            loading={create.isPending}
            disabled={running}
            onClick={() => create.mutate()}
          >
            {t('admin:backups.create')}
          </Button>
        }
      />
      <ErrorAlert error={operation.error} title={t('admin:backups.operationFailed')} />
      {operation.data && <OperationPanel op={operation.data} />}
      <ErrorAlert error={backups.error} title={t('admin:backups.listFailed')} />
      {backups.isPending ? (
        <Loader />
      ) : (
        backups.data && (
          <Table
            data={backups.data}
            columns={columns}
            emptyMessage={t('admin:backups.empty')}
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
