import { useToaster } from '@gravity-ui/uikit';
import { i18n } from '../i18n';

let toastSeq = 0;

/** Копирование в буфер обмена с уведомлением. `label` — что показать в «Скопировано: …». */
export function useCopy() {
  const { add } = useToaster();
  return async (text: string, label: string = text) => {
    // Имя уникально для каждого события, иначе Toaster склеит повторные уведомления.
    const name = `copy-${++toastSeq}`;
    try {
      await navigator.clipboard.writeText(text);
      add({
        name,
        title: i18n.t('common:copy.done', { label }),
        theme: 'success',
        autoHiding: 2000,
      });
    } catch {
      add({ name, title: i18n.t('common:copy.failed'), theme: 'warning' });
    }
  };
}
