import type { GroupDto, GroupPatch } from '@carbone-reports/shared';
import { Pencil, Persons, Plus, TrashBin } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import {
  Button,
  Dialog,
  Icon,
  Loader,
  Select,
  Table,
  TextArea,
  TextInput,
  useToaster,
} from '@gravity-ui/uikit';
import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { conflictMessage, errorMessage, fieldErrors } from '../../api/errors';
import { usePermissions } from '../../app/permissions';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { GeneralError } from '../../components/GeneralError';
import { PageHeader } from '../../components/PageHeader';

/** Группа влияет на пользователей, категории и доступ к шаблонам. */
const invalidateAccess = (queryClient: QueryClient) =>
  Promise.all(
    [['groups'], ['users'], ['categories'], ['templates'], ['template-access']].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey }),
    ),
  );

export function GroupsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const list = useQuery({ queryKey: ['groups'], queryFn: api.groups.list });
  const [dialog, setDialog] = useState<{ group: GroupDto | null } | null>(null);
  const [members, setMembers] = useState<GroupDto | null>(null);
  const [deleting, setDeleting] = useState<GroupDto | null>(null);
  const [lastDeleted, setLastDeleted] = useState<GroupDto | null>(null);

  const remove = useMutation({
    mutationFn: (g: GroupDto) => api.groups.remove(g.id),
    onSuccess: async () => {
      await invalidateAccess(queryClient);
      setDeleting(null);
    },
    onError: (e) => {
      setDeleting(null);
      add({
        name: `group-delete-${Date.now()}`,
        title: t('admin:deleteFailed'),
        content: errorMessage(e),
        theme: 'danger',
      });
    },
  });

  const columns: TableColumnConfig<GroupDto>[] = [
    { id: 'name', name: t('admin:field.name'), template: (g) => g.name },
    {
      id: 'description',
      name: t('admin:field.description'),
      template: (g) => g.description || '—',
    },
    {
      id: 'members',
      name: t('admin:groups.members'),
      align: 'end',
      template: (g) => g.memberIds.length,
    },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (g) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <Button
            view="flat"
            size="s"
            aria-label={t('admin:groups.members')}
            title={t('admin:groups.members')}
            onClick={() => setMembers(g)}
          >
            <Icon data={Persons} />
          </Button>
          <Button
            view="flat"
            size="s"
            aria-label={t('common:action.edit')}
            title={t('common:action.edit')}
            onClick={() => setDialog({ group: g })}
          >
            <Icon data={Pencil} />
          </Button>
          <Button
            view="flat-danger"
            size="s"
            aria-label={t('common:action.delete')}
            title={t('common:action.delete')}
            onClick={() => {
              setLastDeleted(g);
              setDeleting(g);
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
        title={t('common:nav.groups')}
        actions={
          <Button view="action" onClick={() => setDialog({ group: null })}>
            <Icon data={Plus} />
            {t('admin:groups.add')}
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
          getRowDescriptor={(g) => ({ id: g.id })}
          emptyMessage={t('admin:groups.empty')}
          width="max"
        />
      )}
      {dialog && (
        <GroupDialog
          key={dialog.group?.id ?? 'new'}
          group={dialog.group}
          onClose={() => setDialog(null)}
        />
      )}
      {members && (
        <MembersDialog key={members.id} group={members} onClose={() => setMembers(null)} />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t('admin:groups.deleteTitle')}
        text={t('admin:groups.deleteText', { name: (deleting ?? lastDeleted)?.name ?? '' })}
        confirmText={t('common:action.delete')}
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

function GroupDialog({ group, onClose }: { group: GroupDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const patchBody = (g: GroupDto): GroupPatch => ({
    ...(name !== g.name ? { name } : {}),
    ...(description !== g.description ? { description } : {}),
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!group) return api.groups.create({ name, description });
      const body = patchBody(group);
      // Пустой PATCH сервер отклоняет: без изменений просто закрываем диалог.
      return Object.keys(body).length ? api.groups.update(group.id, body) : group;
    },
    onSuccess: async () => {
      await invalidateAccess(queryClient);
      onClose();
    },
  });
  const errors = fieldErrors(save.error);
  const conflict = conflictMessage(save.error);
  const nameError = errors.name ?? conflict;

  return (
    <Dialog open onClose={onClose} aria-labelledby="cr-group-dialog">
      <Dialog.Header
        caption={group ? t('admin:groups.dialogEdit') : t('admin:groups.dialogNew')}
        id="cr-group-dialog"
      />
      <Dialog.Body>
        <div className="cr-form">
          <Field label={t('admin:field.name')} error={nameError}>
            <TextInput
              value={name}
              onUpdate={(v) => {
                save.reset();
                setName(v);
              }}
              validationState={nameError ? 'invalid' : undefined}
              controlProps={{ 'aria-label': t('admin:field.name') }}
            />
          </Field>
          <Field label={t('admin:field.description')} error={errors.description}>
            <TextArea
              value={description}
              onUpdate={setDescription}
              minRows={2}
              controlProps={{ 'aria-label': t('admin:field.description') }}
            />
          </Field>
          <GeneralError
            error={conflict ? null : save.error}
            errors={errors}
            shown={['name', 'description']}
          />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => save.mutate()}
        onClickButtonCancel={onClose}
        textButtonApply={group ? t('common:action.save') : t('admin:create')}
        textButtonCancel={t('common:action.cancel')}
        loading={save.isPending}
        propsButtonApply={{ disabled: !name.trim() }}
      />
    </Dialog>
  );
}

function MembersDialog({ group, onClose }: { group: GroupDto; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { isAdmin } = usePermissions();
  // Список пользователей — только администратору; менеджеру безопасности — справочник активных (§43.3).
  const users = useQuery<{ id: string; login: string }[]>({
    queryKey: isAdmin ? ['users'] : ['users', 'directory'],
    queryFn: isAdmin ? api.users.list : () => api.users.directory(),
  });
  const [userIds, setUserIds] = useState<string[]>(group.memberIds);
  // Заблокированных нет в справочнике: участник остаётся в списке, чтобы его можно было убрать.
  const known = new Set((users.data ?? []).map((u) => u.id));
  const options = [
    ...(users.data ?? []).map((u) => ({ value: u.id, content: u.login })),
    ...group.memberIds
      .filter((uid) => users.data && !known.has(uid))
      .map((uid) => ({ value: uid, content: t('admin:groups.blockedMember') })),
  ];
  const save = useMutation({
    mutationFn: () => api.groups.setMembers(group.id, userIds),
    onSuccess: async () => {
      await Promise.all(
        [['groups'], ['users']].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} aria-labelledby="cr-group-members">
      <Dialog.Header
        caption={t('admin:groups.membersTitle', { name: group.name })}
        id="cr-group-members"
      />
      <Dialog.Body>
        <div className="cr-form">
          <Field label={t('admin:groups.members')} group>
            <Select
              aria-label={t('admin:groups.members')}
              value={userIds}
              onUpdate={setUserIds}
              options={options}
              multiple
              filterable
              hasClear
              loading={users.isPending}
              placeholder={t('admin:groups.noMembers')}
              width="max"
            />
          </Field>
          {users.error && <ErrorAlert error={users.error} title={t('admin:loadFailed.users')} />}
          <ErrorAlert error={save.error} />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => save.mutate()}
        onClickButtonCancel={onClose}
        textButtonApply={t('common:action.save')}
        textButtonCancel={t('common:action.cancel')}
        loading={save.isPending}
        propsButtonApply={{ disabled: !users.data }}
      />
    </Dialog>
  );
}
