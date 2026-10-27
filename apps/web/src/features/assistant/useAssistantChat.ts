import type { RunCard } from '@carbone-reports/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchPath, useLocation } from 'react-router';
import { ApiRequestError } from '../../api/client';
import { api } from '../../api/endpoints';
import { meKey } from '../../api/session';
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

  useEffect(() => saveAssistant(state), [state]);

  const cardText = useCallback(
    (c: RunCard) =>
      t('common:assistant.cardText', {
        name: c.reportName,
        params: c.display.map((d) => `${d.label}: ${d.value}`).join(', '),
      }),
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
          page: { path: pathname, ...(reportId ? { reportId } : {}) },
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
              ...(reply.card ? { card: reply.card } : {}),
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
