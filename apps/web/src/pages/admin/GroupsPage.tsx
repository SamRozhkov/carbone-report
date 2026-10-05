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
import { api } from '../../api/endpoints';
import { conflictMessage, errorMessage, fieldErrors } from '../../api/errors';
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
        title: 'Не удалось удалить',
        content: errorMessage(e),
        theme: 'danger',
      });
    },
  });

  const columns: TableColumnConfig<GroupDto>[] = [
    { id: 'name', name: 'Название', template: (g) => g.name },
    { id: 'description', name: 'Описание', template: (g) => g.description || '—' },
    { id: 'members', name: 'Участники', align: 'end', template: (g) => g.memberIds.length },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (g) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <Button
            view="flat"
            size="s"
            aria-label="Участники"
            title="Участники"
            onClick={() => setMembers(g)}
          >
            <Icon data={Persons} />
          </Button>
          <Button
            view="flat"
            size="s"
            aria-label="Изменить"
            title="Изменить"
            onClick={() => setDialog({ group: g })}
          >
            <Icon data={Pencil} />
          </Button>
          <Button
            view="flat-danger"
            size="s"
            aria-label="Удалить"
            title="Удалить"
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
        title="Группы"
        actions={
          <Button view="action" onClick={() => setDialog({ group: null })}>
            <Icon data={Plus} />
            Добавить группу
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
          emptyMessage="Групп пока нет"
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
        title="Удалить группу?"
        text={`Группа «${(deleting ?? lastDeleted)?.name ?? ''}» будет удалена. Участники потеряют доступ, выданный через эту группу.`}
        confirmText="Удалить"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

function GroupDialog({ group, onClose }: { group: GroupDto | null; onClose: () => void }) {
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
      <Dialog.Header caption={group ? 'Группа' : 'Новая группа'} id="cr-group-dialog" />
      <Dialog.Body>
        <div className="cr-form">
          <Field label="Название" error={nameError}>
            <TextInput
              value={name}
              onUpdate={(v) => {
                save.reset();
                setName(v);
              }}
              validationState={nameError ? 'invalid' : undefined}
              controlProps={{ 'aria-label': 'Название' }}
            />
          </Field>
          <Field label="Описание" error={errors.description}>
            <TextArea
              value={description}
              onUpdate={setDescription}
              minRows={2}
              controlProps={{ 'aria-label': 'Описание' }}
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
        textButtonApply={group ? 'Сохранить' : 'Создать'}
        textButtonCancel="Отмена"
        loading={save.isPending}
        propsButtonApply={{ disabled: !name.trim() }}
      />
    </Dialog>
  );
}

function MembersDialog({ group, onClose }: { group: GroupDto; onClose: () => void }) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list });
  const [userIds, setUserIds] = useState<string[]>(group.memberIds);
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
      <Dialog.Header caption={`Участники группы ${group.name}`} id="cr-group-members" />
      <Dialog.Body>
        <div className="cr-form">
          <Field label="Участники" group>
            <Select
              aria-label="Участники"
              value={userIds}
              onUpdate={setUserIds}
              options={(users.data ?? []).map((u) => ({ value: u.id, content: u.login }))}
              multiple
              filterable
              hasClear
              loading={users.isPending}
              placeholder="нет участников"
              width="max"
            />
          </Field>
          {users.error && (
            <ErrorAlert error={users.error} title="Не удалось загрузить пользователей" />
          )}
          <ErrorAlert error={save.error} />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => save.mutate()}
        onClickButtonCancel={onClose}
        textButtonApply="Сохранить"
        textButtonCancel="Отмена"
        loading={save.isPending}
        propsButtonApply={{ disabled: !users.data }}
      />
    </Dialog>
  );
}
