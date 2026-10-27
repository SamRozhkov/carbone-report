import { useToaster } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';

/** Копирование текста карточки в буфер обмена с уведомлением (§51.5). */
export function useCopy(): (text: string) => void {
  const { t } = useTranslation();
  const { add } = useToaster();
  return (text) => {
    // Буфер может быть недоступен (небезопасный контекст) — тогда молча ничего не делаем.
    void Promise.resolve(navigator.clipboard?.writeText(text))
      .then(() =>
        add({ name: 'assistant-copied', theme: 'info', title: t('common:assistant.cardCopied') }),
      )
      .catch(() => undefined);
  };
}
