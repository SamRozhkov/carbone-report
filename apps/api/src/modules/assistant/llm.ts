// Клиент OpenAI-совместимого API (§50.3): POST /chat/completions с tools, без потока.
import type { AssistantErrorCode } from '@carbone-reports/shared';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string | null;
}
export interface LlmRequest {
  messages: LlmMessage[];
  tools: ToolSpec[];
  toolChoice?: { type: 'function'; function: { name: string } };
}
export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
}
export type LlmClient = (req: LlmRequest, signal?: AbortSignal) => Promise<LlmResponse>;
export type LlmErrorCode = Exclude<AssistantErrorCode, 'limit'>;

export const LLM_TIMEOUT_MS = 60_000;

/** Ошибка провайдера; detail — для журнала (без ключа), пользователю — текст по коду. */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    readonly detail: string,
  ) {
    super(`модель: ${code}: ${detail}`);
    this.name = 'LlmError';
  }
}

const codeFor = (status: number): LlmErrorCode =>
  status === 401 || status === 403
    ? 'auth'
    : status === 404 || status === 400 || status === 422
      ? 'model'
      : 'unavailable';

export function createLlmClient(
  cfg: LlmConfig,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): LlmClient {
  const doFetch = opts.fetch ?? fetch;
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const hide = (s: string) => (cfg.apiKey ? s.split(cfg.apiKey).join('***') : s);
  const fail = (code: LlmErrorCode, detail: string) =>
    new LlmError(code, hide(detail).slice(0, 500));

  return async (req, signal) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? LLM_TIMEOUT_MS);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: req.messages,
      stream: false,
    };
    if (req.tools.length > 0) body.tools = req.tools;
    if (req.toolChoice) body.tool_choice = req.toolChoice;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw fail('unavailable', e instanceof Error ? e.message : String(e));
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw fail(codeFor(res.status), `HTTP ${res.status}: ${text}`);
    let message: { content?: unknown; tool_calls?: unknown } | undefined;
    try {
      message = (JSON.parse(text) as { choices?: { message?: typeof message }[] }).choices?.[0]
        ?.message;
    } catch {
      message = undefined;
    }
    if (!message) throw fail('unavailable', `неразборчивый ответ: ${text}`);
    const toolCalls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as ToolCall[]).filter((c) => c?.function?.name)
      : [];
    return {
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls: toolCalls.map((c, i) => ({
        id: c.id || `call_${i}`,
        type: 'function',
        function: { name: c.function.name, arguments: c.function.arguments ?? '{}' },
      })),
    };
  };
}

/** Проверка подключения (§50.2): модель должна вызвать инструмент ping. */
export async function testLlm(llm: LlmClient): Promise<void> {
  const r = await llm({
    messages: [
      { role: 'system', content: 'Call the ping tool.' },
      { role: 'user', content: 'ping' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'ping',
          description: 'Connectivity check',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    toolChoice: { type: 'function', function: { name: 'ping' } },
  });
  if (!r.toolCalls.some((c) => c.function.name === 'ping'))
    throw new LlmError('model', 'модель не вызвала инструмент');
}
