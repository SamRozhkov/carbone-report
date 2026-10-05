import type { DatasourceDto } from '@carbone-reports/shared';
import { Pencil, Plus, TrashBin } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Button, Icon, Label, Loader, Table, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import { DatasourceDialog } from './DatasourceDialog';

export function DatasourcesPage() {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const list = useQuery({ queryKey: ['datasources'], queryFn: api.datasources.list });
  const [dialog, setDialog] = useState<{ ds: DatasourceDto | null } | null>(null);
  const [deleting, setDeleting] = useState<DatasourceDto | null>(null);
  const [lastDeleted, setLastDeleted] = useState<DatasourceDto | null>(null);

  const remove = useMutation({
    mutationFn: (d: DatasourceDto) => api.datasources.remove(d.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['datasources'] });
      setDeleting(null);
    },
    onError: (e) => {
      setDeleting(null);
      add({
        name: `ds-delete-${Date.now()}`,
        title: 'Не удалось удалить',
        content: errorMessage(e),
        theme: 'danger',
      });
    },
  });

  const columns: TableColumnConfig<DatasourceDto>[] = [
    { id: 'name', name: 'Название', template: (d) => d.name },
    { id: 'address', name: 'Адрес', template: (d) => `${d.host}:${d.port}/${d.database}` },
    { id: 'username', name: 'Пользователь БД', template: (d) => d.username },
    {
      id: 'ssl',
      name: 'SSL',
      template: (d) => (d.sslMode !== 'disable' ? <Label theme="info">SSL</Label> : '—'),
    },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (d) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <Button
            view="flat"
            size="s"
            aria-label="Изменить"
            title="Изменить"
            onClick={() => setDialog({ ds: d })}
          >
            <Icon data={Pencil} />
          </Button>
          <Button
            view="flat-danger"
            size="s"
            aria-label="Удалить"
            title="Удалить"
            onClick={() => {
              setLastDeleted(d);
              setDeleting(d);
            }}
          >
            <Icon data={TrashBin} />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Источники данных"
        actions={
          <Button view="action" onClick={() => setDialog({ ds: null })}>
            <Icon data={Plus} />
            Добавить источник
          </Button>
        }
      />
      <ErrorAlert error={list.error} />
      {list.isPending ? (
        <Loader />
      ) : (
        <Table
          data={list.data ?? []}
          columns={columns}
          getRowDescriptor={(d) => ({ id: d.id })}
          emptyMessage="Источников пока нет"
          width="max"
        />
      )}
      {dialog && (
        <DatasourceDialog
          key={dialog.ds?.id ?? 'new'}
          open
          datasource={dialog.ds}
          onClose={() => setDialog(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Удалить источник данных?"
        text={`Источник «${(deleting ?? lastDeleted)?.name ?? ''}» будет удалён. Если его используют шаблоны, сервер откажет в удалении.`}
        confirmText="Удалить"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
