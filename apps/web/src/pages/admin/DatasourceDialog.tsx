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
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const editing = !!datasource;
  const [form, setForm] = useState({
    name: datasource?.name ?? '',
    host: datasource?.host ?? '',
    port: (datasource?.port ?? 5432) as number | null,
    database: datasource?.database ?? '',
    username: datasource?.username ?? '',
    password: '',
    sslMode: (datasource?.sslMode ?? 'disable') as SslMode,
    sslCa: datasource?.sslCa ?? '',
  });
  // Пустой порт не подменяем на 5432: при сохранении — ошибка у поля, запрос не уходит (§22.5).
  const [portMissing, setPortMissing] = useState(false);
  const body = (): DatasourceBody => {
    const { password, sslCa, port, ...rest } = form;
    // withPort не пускает сюда без порта
    if (port === null) throw new Error(t('admin:dsDialog.portRequired'));
    const base = {
      ...rest,
      port,
      sslCa: form.sslMode === 'verify' && sslCa.trim() ? sslCa : null,
    };
    return password ? { ...base, password } : base;
  };
  const withPort = (action: () => void) => () => {
    if (form.port === null) {
      setPortMissing(true);
      return;
    }
    action();
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
        caption={editing ? t('admin:dsDialog.titleEdit') : t('admin:dsDialog.titleNew')}
        id="cr-ds-dialog"
      />
      <Dialog.Body>
        <div className="cr-form">
          {text('name', t('admin:field.name'))}
          {text('host', t('admin:dsDialog.host'))}
          <Field
            label={t('admin:dsDialog.port')}
            error={portMissing ? t('admin:dsDialog.portRequired') : errors.port}
          >
            <NumberInput
              value={form.port}
              onUpdate={(v) => {
                setPortMissing(false);
                set('port', v);
              }}
              min={1}
              max={65535}
              validationState={portMissing || errors.port ? 'invalid' : undefined}
              controlProps={{ 'aria-label': t('admin:dsDialog.port') }}
            />
          </Field>
          {text('database', t('admin:dsDialog.database'))}
          {text('username', t('admin:datasources.dbUser'))}
          <Field label={t('admin:field.password')} error={errors.password}>
            <TextInput
              type="password"
              value={form.password}
              onUpdate={(v) => set('password', v)}
              placeholder={editing ? t('admin:field.keepPassword') : ''}
              controlProps={{ 'aria-label': t('admin:field.password') }}
            />
          </Field>
          <Field label="SSL" error={errors.sslMode} group>
            <RadioGroup
              direction="vertical"
              value={form.sslMode}
              onUpdate={(v) => set('sslMode', v as SslMode)}
              options={[
                { value: 'disable', content: t('admin:dsDialog.sslNone') },
                { value: 'require', content: t('admin:dsDialog.sslRequire') },
                { value: 'verify', content: t('admin:dsDialog.sslVerify') },
              ]}
            />
          </Field>
          {form.sslMode === 'verify' && (
            <Field
              label={t('admin:dsDialog.ca')}
              error={errors.sslCa}
              hint={t('admin:dsDialog.caHint')}
            >
              <TextArea
                value={form.sslCa}
                onUpdate={(v) => set('sslCa', v)}
                minRows={4}
                placeholder="-----BEGIN CERTIFICATE-----"
                validationState={errors.sslCa ? 'invalid' : undefined}
                controlProps={{ 'aria-label': t('admin:dsDialog.ca') }}
              />
            </Field>
          )}
          <div>
            <Button
              onClick={withPort(() => test.mutate())}
              loading={test.isPending}
              disabled={savedOnly && connDirty}
            >
              {t('admin:dsDialog.test')}
            </Button>
          </div>
          {savedOnly && !connDirty && (
            <Alert theme="info" message={t('admin:dsDialog.testSaved')} />
          )}
          {savedOnly && connDirty && (
            <Alert theme="warning" message={t('admin:dsDialog.testNeedsPassword')} />
          )}
          {test.data?.ok === true && <Alert theme="success" message={t('admin:dsDialog.testOk')} />}
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
        onClickButtonApply={withPort(() => save.mutate())}
        onClickButtonCancel={onClose}
        textButtonApply={t('common:action.save')}
        textButtonCancel={t('common:action.cancel')}
        loading={save.isPending}
      />
    </Dialog>
  );
}
