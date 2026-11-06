import { useToaster } from '@gravity-ui/uikit';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formingKind, useAssistantBridge } from './bridge';
import type { DocumentAdapter } from './documentAdapter';
import type { SheetAdapter } from './sheetAdapter';

export type FormingKind = 'document' | 'sheet';
export type FormingAdapter<K extends FormingKind> = K extends 'sheet'
  ? SheetAdapter
  : DocumentAdapter;

/** Действие формирования; false — автор отменил (документ не менялся, без уведомления). */
export type FormingAction<K extends FormingKind> = (
  a: FormingAdapter<K>,
) => Promise<boolean | void>;
export type DocumentAction = FormingAction<'document'>;
export type SheetAction = FormingAction<'sheet'>;

export interface FormingActionState<K extends FormingKind> {
  /** Формирование этого вида доступно в редакторе шаблона карточки (§52.2, §53.4): вид совпадает
   *  с расширением шаблона (formingKind), кнопки показываются. */
  visible: boolean;
  /** Документ открыт только для просмотра (нет блокировки §38): кнопки неактивны с подсказкой. */
  readOnly: boolean;
  busy: boolean;
  run: (action: FormingAction<K>) => void;
  /** Компонент смонтирован: отложенное действие не трогает состояние снятой карточки. */
  mounted: () => boolean;
}
export type DocumentActionState = FormingActionState<'document'>;
export type SheetActionState = FormingActionState<'sheet'>;

/**
 * Кнопки формирования карточек (§52.4). Видны, пока у редактора шаблона карточки есть connector
 * (в том числе когда вкладка «Документ» размонтирована: применится после её открытия). Отложенное
 * действие выполняется мостом позже и его результат сюда не возвращается, поэтому уведомления
 * показывает само действие, и блокировка проверяется в момент запуска.
 */
export function useFormingAction<K extends FormingKind>(
  kind: K,
  templateId: string,
): FormingActionState<K> {
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
  const registered = kind === 'sheet' ? bridge.sheet : bridge.document;
  const doc = registered?.templateId === templateId ? registered : null;
  // Вид формирования — по расширению шаблона открытого редактора: в xlsx/ods действие документа
  // ждало бы регистрации документа вечно (там регистрируется лист), и наоборот.
  const editorKind =
    bridge.editor?.templateId === templateId ? formingKind(bridge.editor.fileExt) : null;
  const notify = (
    key:
      'cardDocumentChanged' | 'cardDocumentFailed' | 'cardDocumentReadOnly' | 'cardQueuedDocument',
    theme: 'success' | 'danger' | 'warning' | 'info',
  ) => add({ name: `assistant-${key}`, theme, title: t(`common:assistant.${key}`) });

  const run = (action: FormingAction<K>) => {
    if (busy) return;
    setBusy(true);
    // Кнопка занята, пока действие не выполнено: отложенное (вкладка «Документ» открывается) —
    // до запуска мостом или снятия (clearPending, revokeDocument), иначе повторный клик поставил
    // бы его в очередь второй раз.
    const release = () => {
      if (mountedRef.current) setBusy(false);
    };
    const apply = async (adapter: FormingAdapter<K>, editable: () => boolean) => {
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
    };
    // Вид K связывает адаптер действия с методом моста; TypeScript не сужает K по значению kind.
    const applied =
      kind === 'sheet'
        ? bridge.applySheet(templateId, (a, e) => apply(a as FormingAdapter<K>, e), release)
        : bridge.applyDocument(templateId, (a, e) => apply(a as FormingAdapter<K>, e), release);
    void applied
      .then((r) => {
        if (r === 'queued') notify('cardQueuedDocument', 'info');
        // null — шаблон не открыт: действие не ставилось.
        if (r === null) release();
      })
      .catch(release);
  };

  return {
    visible: bridge.documentAutomation === templateId && editorKind === kind,
    readOnly: doc !== null && !doc.editable(),
    busy,
    run,
    mounted: () => mountedRef.current,
  };
}

export const useDocumentAction = (templateId: string): DocumentActionState =>
  useFormingAction('document', templateId);

export const useSheetAction = (templateId: string): SheetActionState =>
  useFormingAction('sheet', templateId);
