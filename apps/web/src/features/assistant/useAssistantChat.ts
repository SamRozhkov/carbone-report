import type { Card } from '@carbone-reports/shared';
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

/** Состояние панели ассистента (§50.5): диалог в sessionStorage, запросы к POST /api/assistant/chat. */
export function useAssistantChat(): AssistantChat {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AssistantState>(loadAssistant);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const reportId = matchPath('/reports/:id', pathname)?.params.id ?? null;
  const bridge = useAssistantBridge();

  useEffect(() => saveAssistant(state), [state]);

  // Текст карточки для истории модели. Для query/param/tags — временно без переводов (Task 5).
  const cardText = useCallback(
    (c: Card) => {
      switch (c.type) {
        case 'run':
          return t('common:assistant.cardText', {
            name: c.reportName,
            params: c.display.map((d) => `${d.label}: ${d.value}`).join(', '),
          });
        case 'query':
          return c.key;
        case 'param':
          return c.param.name;
        case 'tags':
          return c.text;
      }
    },
    [t],
  );

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
    api.assistant
      .chat(
        {
          messages: toHistory(messages, cardText),
          page: {
            path: pathname,
            ...(reportId ? { reportId } : {}),
            // Открыт редактор шаблона: несохранённые черновики «Данных» и «Параметров» (§51.3).
            ...(bridge.editor
              ? { templateId: bridge.editor.templateId, editor: bridge.draft() ?? undefined }
              : {}),
          },
        },
        c.signal,
      )
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
