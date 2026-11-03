import { useToaster } from '@gravity-ui/uikit';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAssistantBridge } from './bridge';
import type { DocumentAdapter } from './documentAdapter';

/** Действие с документом; false — автор отменил (документ не менялся, без уведомления). */
export type DocumentAction = (a: DocumentAdapter) => Promise<boolean | void>;

export interface DocumentActionState {
  /** Формирование доступно в редакторе шаблона карточки (§52.2): кнопки показываются. */
  visible: boolean;
  /** Документ открыт только для просмотра (нет блокировки §38): кнопки неактивны с подсказкой. */
  readOnly: boolean;
  busy: boolean;
  run: (action: DocumentAction) => void;
  /** Компонент смонтирован: отложенное действие не трогает состояние снятой карточки. */
  mounted: () => boolean;
}

/**
 * Кнопки формирования карточек (§52.4). Видны, пока у редактора шаблона карточки есть connector
 * (в том числе когда вкладка «Документ» размонтирована: применится после её открытия). Отложенное
 * действие выполняется мостом позже и его результат сюда не возвращается, поэтому уведомления
 * показывает само действие, и блокировка проверяется в момент запуска.
 */
export function useDocumentAction(templateId: string): DocumentActionState {
  const { t } = useTranslation();
  const bridge = useAssistantBridge();
  const { add } = useToaster();
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const doc = bridge.document?.templateId === templateId ? bridge.document : null;
  const notify = (
    key:
      'cardDocumentChanged' | 'cardDocumentFailed' | 'cardDocumentReadOnly' | 'cardQueuedDocument',
    theme: 'success' | 'danger' | 'warning' | 'info',
  ) => add({ name: `assistant-${key}`, theme, title: t(`common:assistant.${key}`) });

  const run = (action: DocumentAction) => {
    if (busy) return;
    setBusy(true);
    // Кнопка занята, пока действие не выполнено: отложенное (вкладка «Документ» открывается) —
    // до запуска мостом или снятия (clearPending, revokeDocument), иначе повторный клик поставил
    // бы его в очередь второй раз.
    const release = () => {
      if (mountedRef.current) setBusy(false);
    };
    void bridge
      .applyDocument(
        templateId,
        async (adapter, editable) => {
          try {
            if (!editable()) return notify('cardDocumentReadOnly', 'warning');
            try {
              if ((await action(adapter)) !== false) notify('cardDocumentChanged', 'success');
            } catch {
              notify('cardDocumentFailed', 'danger');
            }
          } finally {
            release();
          }
        },
        release,
      )
      .then((r) => {
        if (r === 'queued') notify('cardQueuedDocument', 'info');
        // null — шаблон не открыт: действие не ставилось.
        if (r === null) release();
      })
      .catch(release);
  };

  return {
    visible: bridge.documentAutomation === templateId,
    readOnly: doc !== null && !doc.editable(),
    busy,
    run,
    mounted: () => mountedRef.current,
  };
}
