import type { Role, UpdateUserBody, UserDto } from '@carbone-reports/shared';
import { Button, Dialog, Select, Switch, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { fieldErrors } from '../../api/errors';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { GeneralError } from '../../components/GeneralError';
import { sameIds } from '../../lib/ids';

// От меньших прав к большим; подписи — из каталога common (§43.5, §44.3).
const ROLES = ['user', 'editor', 'access_manager', 'admin'] as const;
function useRoleOptions() {
  const { t } = useTranslation();
  return ROLES.map((value) => ({ value, content: t(`common:role.${value}`) }));
}

export function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const roleOptions = useRoleOptions();
  const queryClient = useQueryClient();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const create = useMutation({
    mutationFn: () => api.users.create({ login, password, role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      close();
    },
  });
  const errors = fieldErrors(create.error);

  function close() {
    setLogin('');
    setPassword('');
    setRole('user');
    create.reset();
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} aria-labelledby="cr-user-create">
      <Dialog.Header caption={t('admin:userDialog.createTitle')} id="cr-user-create" />
      <Dialog.Body>
        <div className="cr-form">
          <Field label={t('admin:field.login')} error={errors.login}>
            <TextInput
              value={login}
              onUpdate={setLogin}
              validationState={errors.login ? 'invalid' : undefined}
              controlProps={{ 'aria-label': t('admin:field.login') }}
            />
          </Field>
          <Field
            label={t('admin:field.password')}
            hint={t('admin:userDialog.passwordHint')}
            error={errors.password}
          >
            <TextInput
              type="password"
              value={password}
              onUpdate={setPassword}
              validationState={errors.password ? 'invalid' : undefined}
              controlProps={{ 'aria-label': t('admin:field.password') }}
            />
          </Field>
          <Field label={t('admin:field.role')}>
            <Select
              value={[role]}
              options={roleOptions}
              onUpdate={([v]) => setRole((v as Role) ?? 'user')}
              width="max"
            />
          </Field>
          <GeneralError error={create.error} errors={errors} shown={['login', 'password']} />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => create.mutate()}
        onClickButtonCancel={close}
        textButtonApply={t('admin:create')}
        textButtonCancel={t('common:action.cancel')}
        loading={create.isPending}
        propsButtonApply={{ disabled: !login || !password }}
      />
    </Dialog>
  );
}

export function EditUserDialog({
  user,
  isSelf,
  onClose,
}: {
  user: UserDto | null;
  isSelf: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const roleOptions = useRoleOptions();
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups.list });
  const [role, setRole] = useState<Role>(user?.role ?? 'user');
  const [password, setPassword] = useState('');
  const [blocked, setBlocked] = useState(user?.blocked ?? false);
  const [groupIds, setGroupIds] = useState<string[]>(user?.groupIds ?? []);
  const buildBody = (): UpdateUserBody => {
    const body: UpdateUserBody = {};
    if (user && role !== user.role) body.role = role;
    if (user && blocked !== user.blocked) body.blocked = blocked;
    if (password) body.password = password;
    return body;
  };
  const groupsChanged = !!user && !sameIds(groupIds, user.groupIds);
  const changed = Object.keys(buildBody()).length > 0 || groupsChanged;
  const save = useMutation({
    mutationFn: async () => {
      const body = buildBody();
      if (Object.keys(body).length) await api.users.update(user!.id, body);
      if (groupsChanged) await api.users.setGroups(user!.id, groupIds);
    },
    // onSettled: PATCH мог пройти, даже если следующий PUT groups упал, — список обновляем всегда.
    onSettled: async (_data, error) => {
      if (changed) {
        await Promise.all(
          [['users'], ['groups']].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
      }
      if (!error) onClose();
    },
  });
  const errors = fieldErrors(save.error);
  const [confirmCert, setConfirmCert] = useState(false);
  const removeCert = useMutation({
    mutationFn: () => api.users.removeCertificate(user!.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] });
      setConfirmCert(false);
      onClose();
    },
  });

  return (
    <Dialog open={!!user} onClose={onClose} aria-labelledby="cr-user-edit">
      <Dialog.Header
        caption={t('admin:userDialog.editTitle', { login: user?.login ?? '' })}
        id="cr-user-edit"
      />
      <Dialog.Body>
        <div className="cr-form">
          <Field label={t('admin:field.role')}>
            <Select
              value={[role]}
              options={roleOptions}
              onUpdate={([v]) => setRole((v as Role) ?? role)}
              disabled={isSelf}
              aria-label={t('admin:field.role')}
              width="max"
            />
          </Field>
          <Field label={t('admin:userDialog.newPassword')} error={errors.password}>
            <TextInput
              type="password"
              value={password}
              onUpdate={setPassword}
              placeholder={t('admin:field.keepPassword')}
              validationState={errors.password ? 'invalid' : undefined}
              controlProps={{ 'aria-label': t('admin:userDialog.newPassword') }}
            />
          </Field>
          <Switch
            checked={blocked}
            onUpdate={setBlocked}
            disabled={isSelf}
            content={t('admin:userDialog.blocked')}
          />
          <Field label={t('admin:field.groups')} group>
            <Select
              aria-label={t('admin:field.groups')}
              value={groupIds}
              onUpdate={setGroupIds}
              options={(groups.data ?? []).map((g) => ({ value: g.id, content: g.name }))}
              multiple
              filterable
              hasClear
              loading={groups.isPending}
              placeholder={t('admin:noGroups')}
              width="max"
            />
          </Field>
          {groups.error && <ErrorAlert error={groups.error} title={t('admin:loadFailed.groups')} />}
          {user?.certificateNotAfter && (
            <Button view="outlined-danger" onClick={() => setConfirmCert(true)}>
              {t('admin:userDialog.removeCert')}
            </Button>
          )}
          <GeneralError error={save.error} errors={errors} shown={['password']} />
        </div>
        <ConfirmDialog
          open={confirmCert}
          title={t('admin:userDialog.removeCertTitle')}
          text={t('admin:userDialog.removeCertText', { login: user?.login ?? '' })}
          confirmText={t('common:action.delete')}
          danger
          loading={removeCert.isPending}
          onConfirm={() => removeCert.mutate()}
          onCancel={() => setConfirmCert(false)}
        />
        {removeCert.error && <ErrorAlert error={removeCert.error} />}
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => save.mutate()}
        onClickButtonCancel={onClose}
        textButtonApply={t('common:action.save')}
        textButtonCancel={t('common:action.cancel')}
        loading={save.isPending}
      />
    </Dialog>
  );
}
