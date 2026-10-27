import { useToaster } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';

/** Содержимое для буфера: HTML (таблица) и его текстовая замена. */
export interface RichCopy {
  html: string;
  text: string;
}

/**
 * Копирование карточки в буфер обмена с уведомлением (§51.5). Строка — как текст;
 * { html, text } — оба формата (§51.8), а без clipboard.write/ClipboardItem (http) — текстом
 * с предупреждением, что таблицей копируется только по https.
 */
export function useCopy(): (content: string | RichCopy) => void {
  const { t } = useTranslation();
  const { add } = useToaster();
  return (content) => {
    const fail = () =>
      add({
        name: 'assistant-copy-failed',
        theme: 'danger',
        title: t('common:assistant.cardCopyFailed'),
      });
    const done = (key: 'cardCopied' | 'cardCopiedAsText') => () =>
      add({ name: 'assistant-copied', theme: 'info', title: t(`common:assistant.${key}`) });
    // Буфер недоступен (небезопасный контекст, http) — «Скопировано» не показываем.
    const clipboard = navigator.clipboard;
    if (!clipboard) return fail();
    if (typeof content === 'string') {
      clipboard.writeText(content).then(done('cardCopied'), fail);
      return;
    }
    if (typeof clipboard.write !== 'function' || typeof ClipboardItem === 'undefined') {
      clipboard.writeText(content.text).then(done('cardCopiedAsText'), fail);
      return;
    }
    let item: ClipboardItem;
    try {
      item = new ClipboardItem({
        'text/html': new Blob([content.html], { type: 'text/html' }),
        'text/plain': new Blob([content.text], { type: 'text/plain' }),
      });
    } catch {
      return fail();
    }
    clipboard.write([item]).then(done('cardCopied'), fail);
  };
}
