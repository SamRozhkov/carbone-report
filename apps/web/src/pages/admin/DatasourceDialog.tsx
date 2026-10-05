import type { DatasourceBody, DatasourceDto } from '@carbone-reports/shared';
import {
  Alert,
  Button,
  Dialog,
  NumberInput,
  RadioGroup,
  TextArea,
  TextInput,
} from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { fieldErrors } from '../../api/errors';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { GeneralError } from '../../components/GeneralError';

type SslMode = DatasourceBody['sslMode'];

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
    sslMode: (datasource?.sslMode ?? 'disable') as SslMode,
    sslCa: datasource?.sslCa ?? '',
  });
  const body = (): DatasourceBody => {
    const { password, sslCa, ...rest } = form;
    const base = { ...rest, sslCa: form.sslMode === 'verify' && sslCa.trim() ? sslCa : null };
    return password ? { ...base, password } : base;
  };

  const savedOnly = editing && !form.password;
  const connDirty =
    !!datasource &&
    (form.host !== datasource.host ||
      form.port !== datasource.port ||
      form.database !== datasource.database ||
      form.username !== datasource.username ||
      form.sslMode !== datasource.sslMode ||
      (form.sslMode === 'verify' ? form.sslCa : '') !== (datasource.sslCa ?? ''));
  const test = useMutation({
    // Без нового пароля у существующего источника проверяем сохранённые параметры.
    mutationFn: () =>
      editing && !form.password
        ? api.datasources.testSaved(datasource!.id)
        : api.datasources.test(body()),
  });
  const save = useMutation({
    mutationFn: () =>
      editing ? api.datasources.update(datasource!.id, body()) : api.datasources.create(body()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['datasources'] });
      onClose();
    },
  });
  // Результат проверки относится к параметрам на момент запуска: любая правка делает его устаревшим.
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    test.reset();
    save.reset();
    setForm((f) => ({ ...f, [k]: v }));
  };
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
          <Field label="SSL" error={errors.sslMode}>
            <RadioGroup
              direction="vertical"
              value={form.sslMode}
              onUpdate={(v) => set('sslMode', v as SslMode)}
              options={[
                { value: 'disable', content: 'Без SSL' },
                { value: 'require', content: 'SSL без проверки сертификата' },
                { value: 'verify', content: 'SSL с проверкой сертификата' },
              ]}
            />
          </Field>
          {form.sslMode === 'verify' && (
            <Field
              label="CA-сертификат (PEM)"
              error={errors.sslCa}
              hint="Пусто — проверка по системным корневым сертификатам"
            >
              <TextArea
                value={form.sslCa}
                onUpdate={(v) => set('sslCa', v)}
                minRows={4}
                placeholder="-----BEGIN CERTIFICATE-----"
                validationState={errors.sslCa ? 'invalid' : undefined}
                controlProps={{ 'aria-label': 'CA-сертификат (PEM)' }}
              />
            </Field>
          )}
          <div>
            <Button
              onClick={() => test.mutate()}
              loading={test.isPending}
              disabled={savedOnly && connDirty}
            >
              Проверить соединение
            </Button>
          </div>
          {savedOnly && !connDirty && (
            <Alert theme="info" message="Проверяются сохранённые параметры источника." />
          )}
          {savedOnly && connDirty && (
            <Alert theme="warning" message="Введите пароль, чтобы проверить изменённые параметры" />
          )}
          {test.data?.ok === true && <Alert theme="success" message="Соединение установлено" />}
          {test.data?.ok === false && <Alert theme="danger" message={test.data.message} />}
          <ErrorAlert error={test.error} />
          <GeneralError
            error={save.error}
            errors={errors}
            shown={['name', 'host', 'port', 'database', 'username', 'password', 'sslMode', 'sslCa']}
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
