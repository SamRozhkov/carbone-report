import { LOCALE_NAMES, LOCALES, isLocale, type Locale } from '@carbone-reports/shared/i18n';
import { Select, useToaster, type SelectProps } from '@gravity-ui/uikit';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '../api/client';
import { errorMessage } from '../api/errors';
import { meKey, useMe, type SessionUser } from '../api/session';
import { changeLocale, i18n, storedLocale } from '.';

const BROWSER = 'browser';

/**
 * Переключатель языка (§44.1). `server` — в меню: выбор сохраняется у пользователя;
 * `local` — на странице входа: выбор хранится только в браузере.
 */
export function LocaleSwitcher({
  persist,
  renderControl,
  size,
  width,
}: {
  persist: 'server' | 'local';
} & Pick<SelectProps, 'renderControl' | 'size' | 'width'>) {
  const { t } = useTranslation();
  const toaster = useToaster();
  const queryClient = useQueryClient();
  const me = useMe().data;
  const [chosen, setChosen] = useState<Locale | null>(() =>
    persist === 'server' ? (me?.locale ?? null) : storedLocale(),
  );
  const [busy, setBusy] = useState(false);

  const options = [
    { value: BROWSER, content: t('common:locale.browser') },
    ...LOCALES.map((l) => ({ value: l, content: LOCALE_NAMES[l] })),
  ];

  async function select(value: string) {
    const choice = isLocale(value) ? value : null;
    setBusy(true);
    try {
      await changeLocale(choice, { persist });
      setChosen(choice);
      if (persist === 'server') {
        queryClient.setQueryData<SessionUser | null>(meKey, (old) =>
          old ? { ...old, locale: choice } : old,
        );
      }
    } catch (e) {
      // Ошибка API — язык уже сменился, не сохранился только выбор; иначе не загрузился чанк языка.
      const apiFailed = e instanceof ApiRequestError;
      if (apiFailed) setChosen(choice);
      toaster.add({
        name: 'locale-failed',
        theme: 'danger',
        // t из рендера привязан к прежнему языку; сообщение — на текущем.
        title: i18n.t(apiFailed ? 'common:locale.saveFailed' : 'common:locale.loadFailed'),
        content: errorMessage(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Select
      value={[chosen ?? BROWSER]}
      options={options}
      onUpdate={(v) => void select(v[0] ?? BROWSER)}
      renderControl={renderControl}
      size={size}
      width={width}
      disabled={busy}
      title={t('common:locale.title')}
      aria-label={t('common:locale.title')}
    />
  );
}
