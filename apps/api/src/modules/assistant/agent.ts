// Цикл ассистента (§50.3): модель → инструменты → … до текста или карточки запуска.
import type { AssistantChatReply, ChatTurn } from '@carbone-reports/shared';
import type { LlmClient, LlmMessage } from './llm';
import type { AgentTools } from './tools';

export const MAX_TOOL_CALLS = 8;
export const AGENT_DEADLINE_MS = 120_000;

/** Превышены шаги или срок, либо модель не дала ответа. */
export class AgentLimitError extends Error {
  constructor(reason: string) {
    super(`ассистент: ${reason}`);
    this.name = 'AgentLimitError';
  }
}

export async function runAgent(o: {
  llm: LlmClient;
  tools: AgentTools;
  system: string;
  history: ChatTurn[];
  maxToolCalls?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Исключение инструмента — в журнал; модели уходит только общая ошибка. */
  onToolError?: (name: string, e: unknown) => void;
}): Promise<AssistantChatReply> {
  const max = o.maxToolCalls ?? MAX_TOOL_CALLS;
  const deadline = AbortSignal.timeout(o.deadlineMs ?? AGENT_DEADLINE_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline]) : deadline;
  const messages: LlmMessage[] = [{ role: 'system', content: o.system }, ...o.history];
  let calls = 0;
  for (;;) {
    let res;
    try {
      res = await o.llm({ messages, tools: o.tools.specs }, signal);
    } catch (e) {
      if (deadline.aborted) throw new AgentLimitError('срок');
      throw e;
    }
    const text = res.content?.trim() ?? '';
    if (res.toolCalls.length === 0) {
      if (!text) throw new AgentLimitError('пустой ответ');
      return { reply: text, card: null };
    }
    messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
    for (const c of res.toolCalls) {
      if (++calls > max) throw new AgentLimitError('шаги');
      let content: unknown;
      let args: unknown;
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {
        content = { error: 'invalid JSON in arguments' };
      }
      if (content === undefined) {
        try {
          const out = await o.tools.run(c.function.name, args);
          if ('card' in out) return { reply: text, card: out.card };
          content = out.result;
        } catch (e) {
          // Граница данных (§50.1): текст исключения (pg, источник) может называть таблицы,
          // столбцы и хосты — модели только общая ошибка, подробности — в журнал.
          o.onToolError?.(c.function.name, e);
          content = { error: 'tool failed' };
        }
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(content) });
    }
  }
}
