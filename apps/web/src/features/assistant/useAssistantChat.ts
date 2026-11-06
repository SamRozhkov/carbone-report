import type { Card, EditorDraft } from '@carbone-reports/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation } from 'react-router';
import { ApiRequestError } from '../../api/client';
import { api } from '../../api/endpoints';
import { meKey } from '../../api/session';
import { useAssistantBridge } from './bridge';
import { loadAssistant, saveAssistant, toHistory, type AssistantState } from './storage';

export interface AssistantChat {
  open: boolean;
  messages: AssistantState['messages'];
  pending: boolean;
  error: string | null;
  /** Открыт отчёт `/reports/:id` — есть что «сформировать» по подсказке. */
  reportId: string | null;
  setOpen: (open: boolean) => void;
  send: (text: string) => void;
  stop: () => void;
  reset: () => void;
}

/** Предел текста карточки в истории (§52.4), как у реплики. */
const MAX_CARD_TEXT = 4000;

/** Текст карточки для истории модели: модель видит, что предлагала (§51.5). */
export function useCardText(): (c: Card) => string {
  const { t } = useTranslation();
  return useCallback(
    (c: Card) => {
      switch (c.type) {
        case 'run':
          return t('common:assistant.cardText', {
            name: c.reportName,
            params: c.display.map((d) => `${d.label}: ${d.value}`).join(', '),
          });
        case 'query':
          return t('common:assistant.cardQueryText', {
            key: c.key,
            mode: t(
              c.mode === 'list'
                ? 'common:assistant.cardModeList'
                : 'common:assistant.cardModeSingle',
            ),
            sql: c.sql,
          });
        case 'param':
          return t('common:assistant.cardParamText', {
            name: c.param.name,
            type: c.param.type,
          });
        case 'tags':
          return t('common:assistant.cardTagsText', {
            text: c.text,
          });
        case 'table':
          return t('common:assistant.cardTableText', {
            key: c.key,
            columns: c.rows[0]?.join(', ') ?? '',
          });
        case 'document': {
          // Заголовки блоков; без заголовков — начало первого абзаца (§52.4).
          const headings = c.blocks.flatMap((b) => (b.type === 'heading' ? [b.text] : []));
          const first = c.blocks.find((b) => b.type === 'p');
          const text = headings.length
            ? headings.join('; ')
            : first?.type === 'p'
              ? first.text.slice(0, 100)
              : '';
          return t('common:assistant.cardDocumentText', { text }).slice(0, MAX_CARD_TEXT);
        }
        case 'replace':
          return t('common:assistant.cardReplaceText', {
            items: c.items.length,
            tables: c.tables.length,
          });
        case 'sheet':
          return t('common:assistant.cardSheetText', { key: c.key }).slice(0, MAX_CARD_TEXT);
        case 'sheetReplace':
          return t(
            c.table
              ? 'common:assistant.cardSheetReplaceText'
              : 'common:assistant.cardSheetReplaceItemsText',
            { items: c.items.length },
          );
      }
    },
    [t],
  );
}

/** Состояние панели ассистента (§50.5): диалог в sessionStorage, запросы к POST /api/assistant/chat. */
export function useAssistantChat(): AssistantChat {
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AssistantState>(loadAssistant);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const reportId = matchPath('/reports/:id', pathname)?.params.id ?? null;
  const bridge = useAssistantBridge();

  useEffect(() => saveAssistant(state), [state]);

  const cardText = useCardText();

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setPending(false);
  }, []);

  const send = (text: string) => {
    const content = text.trim();
    if (!content || pending) return;
    const messages = [...state.messages, { role: 'user' as const, content }];
    setState((s) => ({ ...s, messages }));
    setError(null);
    setPending(true);
    const c = new AbortController();
    controller.current = c;
    const editor = bridge.editor;
    // Открыт редактор шаблона: несохранённые черновики «Данных» и «Параметров» (§51.3).
    const draft: EditorDraft | undefined = editor ? (bridge.draft() ?? undefined) : undefined;
    // Открыт документ или лист этого шаблона: снимок через connector и признак возможности
    // (§52.2, §52.3, §53.4). Снимок не получился — без обоих полей: сервер тогда не даёт
    // инструментов формирования. document и sheet вместе не отправляются (схема EditorDraft).
    const withDocument = async (): Promise<EditorDraft | undefined> => {
      if (!editor || !draft) return draft;
      if (bridge.sheet?.templateId === editor.templateId) {
        const sheet = await bridge.sheetSnapshot();
        return sheet ? { ...draft, sheet, documentAutomation: true } : draft;
      }
      if (bridge.document?.templateId !== editor.templateId) return draft;
      const document = await bridge.snapshot();
      return document ? { ...draft, document, documentAutomation: true } : draft;
    };
    withDocument()
      .then((editorDraft) => {
        if (c.signal.aborted) throw new DOMException('aborted', 'AbortError');
        return api.assistant.chat(
          {
            messages: toHistory(messages, cardText),
            page: {
              path: pathname,
              ...(reportId ? { reportId } : {}),
              ...(editor ? { templateId: editor.templateId, editor: editorDraft } : {}),
            },
          },
          c.signal,
        );
      })
      .then((reply) => {
        if (c.signal.aborted) return;
        setState((s) => ({
          ...s,
          messages: [
            ...s.messages,
            {
              role: 'assistant',
              content: reply.reply,
              ...(reply.cards.length > 0 ? { cards: reply.cards } : {}),
            },
          ],
        }));
      })
      .catch((e: unknown) => {
        // Остановлено пользователем или «Новый диалог» — молча.
        if (c.signal.aborted || (e as Error).name === 'AbortError') return;
        if (e instanceof ApiRequestError && e.status === 404) {
          // Админ выключил ассистента: панель закрывается, пункт подвала уйдёт с обновлением /me.
          setState((s) => ({ ...s, open: false }));
          void queryClient.invalidateQueries({ queryKey: meKey });
          return;
        }
        setError((e as Error).message);
      })
      .finally(() => {
        if (controller.current === c) {
          controller.current = null;
          setPending(false);
        }
      });
  };

  const reset = () => {
    stop();
    setError(null);
    setState((s) => ({ ...s, messages: [] }));
  };

  const setOpen = (open: boolean) => setState((s) => ({ ...s, open }));

  return {
    open: state.open,
    messages: state.messages,
    pending,
    error,
    reportId,
    setOpen,
    send,
    stop,
    reset,
  };
}
