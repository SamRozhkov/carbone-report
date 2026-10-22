import type { UserDto } from '@carbone-reports/shared';
import { Lock, LockOpen, Pencil, PersonXmark, Plus, TrashBin } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Button, Icon, Label, Loader, Table, Text, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { useMe } from '../../api/session';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import { formatDate } from '../../lib/format';
import { CreateUserDialog, EditUserDialog } from './UserDialogs';

export function UsersPage() {
  const { t } = useTranslation();
  // Подпись роли в таблице — свой ключ: в ru строчными, как раньше; в других языках — как название.
  const roleLabel = (role: UserDto['role']) => t(`admin:roleInTable.${role}`);
  const me = useMe().data;
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list });
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups.list });
  const groupName = new Map((groups.data ?? []).map((g) => [g.id, g.name]));
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [deleting, setDeleting] = useState<UserDto | null>(null);
  const [revoking, setRevoking] = useState<UserDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserDto | null>(null);

  const fail = (e: unknown) =>
    add({
      name: `users-error-${Date.now()}`,
      title: t('common:status.error'),
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

  const revoke = useMutation({
    mutationFn: (u: UserDto) => api.users.revokeSessions(u.id),
    onSuccess: (_d, u) => {
      setRevoking(null);
      add({
        name: `users-revoked-${u.id}`,
        title: t('admin:users.sessionsRevoked', { login: u.login }),
        theme: 'success',
      });
    },
    onError: fail,
  });

  const columns: TableColumnConfig<UserDto>[] = [
    {
      id: 'login',
      name: t('admin:field.login'),
      template: (u) => (u.id === me?.id ? t('admin:users.you', { login: u.login }) : u.login),
    },
    {
      id: 'role',
      name: t('admin:field.role'),
      template: (u) => (
        <Label theme={u.role === 'user' ? 'normal' : 'info'}>{roleLabel(u.role)}</Label>
      ),
    },
    {
      id: 'status',
      name: t('admin:field.status'),
      template: (u) =>
        u.blocked ? (
          <Label theme="danger">{t('admin:users.blocked')}</Label>
        ) : (
          <Label theme="success">{t('admin:users.active')}</Label>
        ),
    },
    {
      id: 'groups',
      name: t('admin:field.groups'),
      template: (u) =>
        groups.isPending && u.groupIds.length > 0
          ? '…'
          : u.groupIds
              .map((id) => groupName.get(id))
              .filter(Boolean)
              .join(', ') || '—',
    },
    {
      id: 'certificate',
      name: t('admin:users.signature'),
      template: (u) =>
        u.certificateNotAfter ? (
          <Text
            color={new Date(u.certificateNotAfter).getTime() <= Date.now() ? 'danger' : undefined}
          >
            {t('admin:users.certUntil', { date: formatDate(u.certificateNotAfter) })}
          </Text>
        ) : (
          '—'
        ),
    },
    {
      id: 'createdAt',
      name: t('admin:users.createdAt'),
      template: (u) => formatDate(u.createdAt),
    },
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
              aria-label={t('common:action.edit')}
              title={t('common:action.edit')}
              onClick={() => setEditing(u)}
            >
              <Icon data={Pencil} />
            </Button>
            {!self && (
              <Button
                view="flat"
                size="s"
                aria-label={t('admin:users.revokeSessions')}
                title={t('admin:users.revokeSessions')}
                onClick={() => setRevoking(u)}
              >
                <Icon data={PersonXmark} />
              </Button>
            )}
            {!self && (
              <Button
                view="flat"
                size="s"
                aria-label={u.blocked ? t('admin:users.unblock') : t('admin:users.block')}
                title={u.blocked ? t('admin:users.unblock') : t('admin:users.block')}
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
                aria-label={t('common:action.delete')}
                title={t('common:action.delete')}
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
        title={t('common:nav.users')}
        actions={
          <Button view="action" onClick={() => setCreateOpen(true)}>
            <Icon data={Plus} />
            {t('admin:users.add')}
          </Button>
        }
      />
      <ErrorAlert error={users.error} />
      {groups.error && <ErrorAlert error={groups.error} title={t('admin:loadFailed.groups')} />}
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
        title={t('admin:users.deleteTitle')}
        text={
          <>
            {t('admin:users.deleteText', { login: deleteTarget?.login ?? '' })}
            <br />
            {t('admin:users.deleteHint')}
          </>
        }
        confirmText={t('common:action.delete')}
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
      <ConfirmDialog
        open={!!revoking}
        title={t('admin:users.revokeSessions')}
        text={t('admin:users.revokeText', { login: revoking?.login ?? '' })}
        confirmText={t('admin:users.revokeConfirm')}
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}
