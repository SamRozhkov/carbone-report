import type { DatasourceBody, DatasourceDto } from '@carbone-reports/shared';
import { Alert, Button, Checkbox, Dialog, NumberInput, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { fieldErrors } from '../../api/errors';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { GeneralError } from '../../components/GeneralError';

export function DatasourceDialog({
  open,
  datasource,
  onClose,
}: {
  open: boolean;
  datasource: DatasourceDto | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const editing = !!datasource;
  const [form, setForm] = useState({
    name: datasource?.name ?? '',
    host: datasource?.host ?? '',
    port: datasource?.port ?? 5432,
    database: datasource?.database ?? '',
    username: datasource?.username ?? '',
    password: '',
    ssl: datasource?.ssl ?? false,
  });
  const body = (): DatasourceBody => {
    const { password, ...rest } = form;
    return password ? { ...rest, password } : rest;
  };

  const test = useMutation({
    // Без нового пароля у существующего источника проверяем сохранённые параметры.
    mutationFn: () =>
      editing && !form.password
        ? api.datasources.testSaved(datasource!.id)
        : api.datasources.test(body()),
  });
  // Результат проверки относится к параметрам на момент запуска: любая правка делает его устаревшим.
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    test.reset();
    setForm((f) => ({ ...f, [k]: v }));
  };

  const save = useMutation({
    mutationFn: () =>
      editing ? api.datasources.update(datasource!.id, body()) : api.datasources.create(body()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['datasources'] });
      onClose();
    },
  });
  const errors = fieldErrors(save.error);
  const text = (k: 'name' | 'host' | 'database' | 'username', label: string) => (
    <Field label={label} error={errors[k]}>
      <TextInput
        value={form[k]}
        onUpdate={(v) => set(k, v)}
        validationState={errors[k] ? 'invalid' : undefined}
        controlProps={{ 'aria-label': label }}
      />
    </Field>
  );

  return (
    <Dialog open={open} onClose={onClose} aria-labelledby="cr-ds-dialog">
      <Dialog.Header
        caption={editing ? 'Источник данных' : 'Новый источник данных'}
        id="cr-ds-dialog"
      />
      <Dialog.Body>
        <div className="cr-form">
          {text('name', 'Название')}
          {text('host', 'Хост')}
          <Field label="Порт" error={errors.port}>
            <NumberInput
              value={form.port}
              onUpdate={(v) => set('port', v ?? 5432)}
              min={1}
              max={65535}
            />
          </Field>
          {text('database', 'База данных')}
          {text('username', 'Пользователь БД')}
          <Field label="Пароль" error={errors.password}>
            <TextInput
              type="password"
              value={form.password}
              onUpdate={(v) => set('password', v)}
              placeholder={editing ? 'не менять' : ''}
              controlProps={{ 'aria-label': 'Пароль' }}
            />
          </Field>
          <Checkbox
            checked={form.ssl}
            onUpdate={(v) => set('ssl', v)}
            content="SSL (сертификат сервера не проверяется)"
          />
          <div>
            <Button onClick={() => test.mutate()} loading={test.isPending}>
              Проверить соединение
            </Button>
          </div>
          {editing && !form.password && test.isIdle && (
            <Alert
              theme="info"
              message="Без нового пароля проверяются сохранённые параметры источника."
            />
          )}
          {test.data?.ok === true && <Alert theme="success" message="Соединение установлено" />}
          {test.data?.ok === false && <Alert theme="danger" message={test.data.message} />}
          <ErrorAlert error={test.error} />
          <GeneralError
            error={save.error}
            errors={errors}
            shown={['name', 'host', 'port', 'database', 'username', 'password']}
          />
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
