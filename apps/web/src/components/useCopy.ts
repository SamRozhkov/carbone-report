import { useToaster } from '@gravity-ui/uikit';

let toastSeq = 0;

/** Копирование в буфер обмена с уведомлением. `label` — что показать в «Скопировано: …». */
export function useCopy() {
  const { add } = useToaster();
  return async (text: string, label: string = text) => {
    // Имя уникально для каждого события, иначе Toaster склеит повторные уведомления.
    const name = `copy-${++toastSeq}`;
    try {
      await navigator.clipboard.writeText(text);
      add({ name, title: `Скопировано: ${label}`, theme: 'success', autoHiding: 2000 });
    } catch {
      add({ name, title: 'Не удалось скопировать — выделите тег вручную', theme: 'warning' });
    }
  };
}
