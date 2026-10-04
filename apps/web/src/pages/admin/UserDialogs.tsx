import type { Role, UpdateUserBody, UserDto } from '@carbone-reports/shared';
import { Alert, Dialog, Select, Switch, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { fieldErrors } from '../../api/errors';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';

const ROLE_OPTIONS = [
  { value: 'user', content: 'Пользователь' },
  { value: 'admin', content: 'Администратор' },
];

/** Общая ошибка: всё, что не относится к показанным полям, должно оставаться видимым. */
function GeneralError({
  error,
  errors,
  shown,
}: {
  error: unknown;
  errors: Record<string, string>;
  shown: string[];
}) {
  if (!error) return null;
  const keys = Object.keys(errors);
  if (keys.length === 0) return <ErrorAlert error={error} />;
  const unmatched = keys.filter((k) => !shown.includes(k));
  if (unmatched.length === 0) return null;
  return (
    <Alert
      theme="danger"
      message={unmatched.map((k) => (k === '_' ? errors[k] : `${k}: ${errors[k]}`)).join('; ')}
    />
  );
}

export function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      <Dialog.Header caption="Новый пользователь" id="cr-user-create" />
      <Dialog.Body>
        <div className="cr-form">
          <Field label="Логин" error={errors.login}>
            <TextInput
              value={login}
              onUpdate={setLogin}
              validationState={errors.login ? 'invalid' : undefined}
              controlProps={{ 'aria-label': 'Логин' }}
            />
          </Field>
          <Field label="Пароль" hint="не короче 8 символов" error={errors.password}>
            <TextInput
              type="password"
              value={password}
              onUpdate={setPassword}
              validationState={errors.password ? 'invalid' : undefined}
              controlProps={{ 'aria-label': 'Пароль' }}
            />
          </Field>
          <Field label="Роль">
            <Select
              value={[role]}
              options={ROLE_OPTIONS}
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
        textButtonApply="Создать"
        textButtonCancel="Отмена"
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
  const queryClient = useQueryClient();
  const [role, setRole] = useState<Role>(user?.role ?? 'user');
  const [password, setPassword] = useState('');
  const [blocked, setBlocked] = useState(user?.blocked ?? false);
  const buildBody = (): UpdateUserBody => {
    const body: UpdateUserBody = {};
    if (user && role !== user.role) body.role = role;
    if (user && blocked !== user.blocked) body.blocked = blocked;
    if (password) body.password = password;
    return body;
  };
  const changed = Object.keys(buildBody()).length > 0;
  const save = useMutation({
    mutationFn: () => {
      const body = buildBody();
      return Object.keys(body).length ? api.users.update(user!.id, body) : Promise.resolve(user!);
    },
    onSuccess: async () => {
      if (changed) await queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });
  const errors = fieldErrors(save.error);

  return (
    <Dialog open={!!user} onClose={onClose} aria-labelledby="cr-user-edit">
      <Dialog.Header caption={`Пользователь ${user?.login ?? ''}`} id="cr-user-edit" />
      <Dialog.Body>
        <div className="cr-form">
          <Field label="Роль">
            <Select
              value={[role]}
              options={ROLE_OPTIONS}
              onUpdate={([v]) => setRole((v as Role) ?? role)}
              disabled={isSelf}
              width="max"
            />
          </Field>
          <Field label="Новый пароль" error={errors.password}>
            <TextInput
              type="password"
              value={password}
              onUpdate={setPassword}
              placeholder="не менять"
              validationState={errors.password ? 'invalid' : undefined}
              controlProps={{ 'aria-label': 'Новый пароль' }}
            />
          </Field>
          <Switch
            checked={blocked}
            onUpdate={setBlocked}
            disabled={isSelf}
            content="Заблокирован"
          />
          <GeneralError error={save.error} errors={errors} shown={['password']} />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => save.mutate()}
        onClickButtonCancel={onClose}
        textButtonApply="Сохранить"
        textButtonCancel="Отмена"
        loading={save.isPending}
      />
    </Dialog>
  );
}
