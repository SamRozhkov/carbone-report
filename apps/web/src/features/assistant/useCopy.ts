import { useToaster } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';

/** Копирование текста карточки в буфер обмена с уведомлением (§51.5). */
export function useCopy(): (text: string) => void {
  const { t } = useTranslation();
  const { add } = useToaster();
  return (text) => {
    const fail = () =>
      add({
        name: 'assistant-copy-failed',
        theme: 'danger',
        title: t('common:assistant.cardCopyFailed'),
      });
    // Буфер недоступен (небезопасный контекст, http) — «Скопировано» не показываем.
    if (!navigator.clipboard) return fail();
    navigator.clipboard
      .writeText(text)
      .then(
        () =>
          add({ name: 'assistant-copied', theme: 'info', title: t('common:assistant.cardCopied') }),
        fail,
      );
  };
}
