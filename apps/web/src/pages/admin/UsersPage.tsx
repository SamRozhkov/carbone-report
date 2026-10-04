import type { UserDto } from '@carbone-reports/shared';
import { Lock, LockOpen, Pencil, Plus, TrashBin } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Button, Icon, Label, Loader, Table, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { useMe } from '../../api/session';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import { formatDate } from '../../lib/format';
import { CreateUserDialog, EditUserDialog } from './UserDialogs';

export function UsersPage() {
  const me = useMe().data;
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [deleting, setDeleting] = useState<UserDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserDto | null>(null);

  const fail = (e: unknown) =>
    add({
      name: `users-error-${Date.now()}`,
      title: 'Ошибка',
      content: errorMessage(e),
      theme: 'danger',
    });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const toggleBlock = useMutation({
    mutationFn: (u: UserDto) => api.users.update(u.id, { blocked: !u.blocked }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (u: UserDto) => api.users.remove(u.id),
    onSuccess: async () => {
      await refresh();
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      setDeleting(null);
    },
    onError: fail,
  });

  const columns: TableColumnConfig<UserDto>[] = [
    {
      id: 'login',
      name: 'Логин',
      template: (u) => (u.id === me?.id ? `${u.login} (вы)` : u.login),
    },
    {
      id: 'role',
      name: 'Роль',
      template: (u) =>
        u.role === 'admin' ? (
          <Label theme="info">администратор</Label>
        ) : (
          <Label>пользователь</Label>
        ),
    },
    {
      id: 'status',
      name: 'Статус',
      template: (u) =>
        u.blocked ? (
          <Label theme="danger">заблокирован</Label>
        ) : (
          <Label theme="success">активен</Label>
        ),
    },
    { id: 'createdAt', name: 'Создан', template: (u) => formatDate(u.createdAt) },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (u) => {
        const self = u.id === me?.id;
        return (
          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
            <Button
              view="flat"
              size="s"
              aria-label="Изменить"
              title="Изменить"
              onClick={() => setEditing(u)}
            >
              <Icon data={Pencil} />
            </Button>
            {!self && (
              <Button
                view="flat"
                size="s"
                aria-label={u.blocked ? 'Разблокировать' : 'Заблокировать'}
                title={u.blocked ? 'Разблокировать' : 'Заблокировать'}
                loading={toggleBlock.isPending && toggleBlock.variables?.id === u.id}
                onClick={() => toggleBlock.mutate(u)}
              >
                <Icon data={u.blocked ? LockOpen : Lock} />
              </Button>
            )}
            {!self && (
              <Button
                view="flat-danger"
                size="s"
                aria-label="Удалить"
                title="Удалить"
                onClick={() => {
                  setDeleteTarget(u);
                  setDeleting(u);
                }}
              >
                <Icon data={TrashBin} />
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Пользователи"
        actions={
          <Button view="action" onClick={() => setCreateOpen(true)}>
            <Icon data={Plus} />
            Добавить пользователя
          </Button>
        }
      />
      <ErrorAlert error={users.error} />
      {users.isPending ? (
        <Loader />
      ) : (
        <Table
          data={users.data ?? []}
          columns={columns}
          getRowDescriptor={(u) => ({ id: u.id })}
          width="max"
        />
      )}
      <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      {editing && (
        <EditUserDialog
          key={editing.id}
          user={editing}
          isSelf={editing.id === me?.id}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Удалить пользователя?"
        text={
          <>
            Пользователь «{deleteTarget?.login}» будет удалён вместе с историей его запусков и
            файлами отчётов.
            <br />
            Если историю нужно сохранить, заблокируйте пользователя вместо удаления.
          </>
        }
        confirmText="Удалить"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
