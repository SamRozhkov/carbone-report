import type { AssistantSettingsBody, AssistantSettingsDto } from '@carbone-reports/shared';
import {
  Alert,
  Button,
  Loader,
  Switch,
  Text,
  TextArea,
  TextInput,
  useToaster,
} from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { fieldErrors } from '../../api/errors';
import { meKey } from '../../api/session';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { GeneralError } from '../../components/GeneralError';
import { PageHeader } from '../../components/PageHeader';

/** Что делать с ключом при отправке: оставить, заменить введённым или удалить. */
type KeyMode = 'keep' | 'replace' | 'remove';

export function AssistantPage() {
  const { t } = useTranslation();
  const settings = useQuery({ queryKey: ['admin-assistant'], queryFn: api.assistant.settings });
  return (
    <>
      <PageHeader title={t('admin:assistant.title')} />
      {settings.isPending && <Loader />}
      <ErrorAlert error={settings.error} />
      {settings.data && <AssistantForm data={settings.data} />}
    </>
  );
}

function AssistantForm({ data }: { data: AssistantSettingsDto }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const [form, setForm] = useState({
    enabled: data.enabled,
    baseUrl: data.baseUrl,
    model: data.model,
    extraInstructions: data.extraInstructions,
  });
  const [keyMode, setKeyMode] = useState<KeyMode>('keep');
  const [keyValue, setKeyValue] = useState('');

  // apiKey: строка — заменить, null — удалить, нет поля — не менять (в т.ч. когда ключа ещё нет и поле пустое).
  const keyPart = (): { apiKey?: string | null } => {
    if (keyMode === 'remove') return { apiKey: null };
    if (keyMode === 'replace' || !data.hasApiKey) return keyValue ? { apiKey: keyValue } : {};
    return {};
  };
  const test = useMutation({
    mutationFn: () =>
      api.assistant.test({ baseUrl: form.baseUrl, model: form.model, ...keyPart() }),
  });
  const save = useMutation({
    mutationFn: () => api.assistant.save({ ...form, ...keyPart() } satisfies AssistantSettingsBody),
    onSuccess: async () => {
      setKeyMode('keep');
      setKeyValue('');
      add({
        name: `assistant-saved-${Date.now()}`,
        theme: 'success',
        title: t('admin:assistant.saved'),
      });
      // Пункт меню и кнопка ассистента зависят от features.assistant из /api/auth/me.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-assistant'] }),
        queryClient.invalidateQueries({ queryKey: meKey }),
      ]);
    },
  });
  // Результат проверки относится к значениям на момент запуска: любая правка делает его устаревшим.
  const touch = () => {
    test.reset();
    save.reset();
  };
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    touch();
    setForm((f) => ({ ...f, [k]: v }));
  };
  const changeKey = (mode: KeyMode, value = '') => {
    touch();
    setKeyMode(mode);
    setKeyValue(value);
  };
  const errors = fieldErrors(save.error);
  const showInput = keyMode === 'replace' || !data.hasApiKey;

  return (
    <div className="cr-form">
      <Switch
        checked={form.enabled}
        onUpdate={(v) => set('enabled', v)}
        content={t('admin:assistant.enabled')}
      />
      <Field
        label={t('admin:assistant.baseUrl')}
        error={errors.baseUrl}
        hint={t('admin:assistant.baseUrlHint')}
      >
        <TextInput
          value={form.baseUrl}
          onUpdate={(v) => set('baseUrl', v)}
          validationState={errors.baseUrl ? 'invalid' : undefined}
          controlProps={{ 'aria-label': t('admin:assistant.baseUrl') }}
        />
      </Field>
      <Field label={t('admin:assistant.model')} error={errors.model}>
        <TextInput
          value={form.model}
          onUpdate={(v) => set('model', v)}
          validationState={errors.model ? 'invalid' : undefined}
          controlProps={{ 'aria-label': t('admin:assistant.model') }}
        />
      </Field>
      {showInput ? (
        <>
          <Field
            label={t('admin:assistant.apiKey')}
            error={errors.apiKey}
            hint={t('admin:assistant.apiKeyHint')}
          >
            <TextInput
              type="password"
              autoComplete="off"
              value={keyValue}
              onUpdate={(v) => changeKey('replace', v)}
              validationState={errors.apiKey ? 'invalid' : undefined}
              controlProps={{ 'aria-label': t('admin:assistant.apiKey') }}
            />
          </Field>
          {data.hasApiKey && (
            <div>
              <Button view="flat" onClick={() => changeKey('keep')}>
                {t('common:action.cancel')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <Field label={t('admin:assistant.apiKey')} group>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text>
              {keyMode === 'remove'
                ? t('admin:assistant.apiKeyRemove')
                : t('admin:assistant.apiKeySet')}
            </Text>
            {keyMode === 'remove' ? (
              <Button view="flat" onClick={() => changeKey('keep')}>
                {t('common:action.cancel')}
              </Button>
            ) : (
              <>
                <Button onClick={() => changeKey('replace')}>
                  {t('admin:assistant.apiKeyReplace')}
                </Button>
                <Button view="outlined-danger" onClick={() => changeKey('remove')}>
                  {t('admin:assistant.apiKeyRemove')}
                </Button>
              </>
            )}
          </div>
        </Field>
      )}
      <Field
        label={t('admin:assistant.extra')}
        error={errors.extraInstructions}
        hint={t('admin:assistant.extraHint')}
      >
        <TextArea
          value={form.extraInstructions}
          onUpdate={(v) => set('extraInstructions', v)}
          minRows={4}
          validationState={errors.extraInstructions ? 'invalid' : undefined}
          controlProps={{ 'aria-label': t('admin:assistant.extra'), maxLength: 2000 }}
        />
      </Field>
      <Alert
        theme="info"
        message={
          <>
            <p style={{ margin: 0 }}>{t('admin:assistant.privacy')}</p>
            <p style={{ margin: '8px 0 0' }}>{t('admin:assistant.privacyAuthor')}</p>
          </>
        }
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => test.mutate()} loading={test.isPending}>
          {t('admin:assistant.test')}
        </Button>
        <Button view="action" onClick={() => save.mutate()} loading={save.isPending}>
          {t('admin:assistant.save')}
        </Button>
      </div>
      {test.data?.ok === true && <Alert theme="success" message={t('admin:assistant.testOk')} />}
      {test.data?.ok === false && <Alert theme="danger" message={test.data.message} />}
      <ErrorAlert error={test.error} />
      <GeneralError
        error={save.error}
        errors={errors}
        shown={['enabled', 'baseUrl', 'model', 'apiKey', 'extraInstructions']}
      />
    </div>
  );
}
