import { AppError } from '../../lib/errors';

export interface AgentResponse {
  status: number;
  /** undefined — пустое тело (204). */
  body: unknown;
}

export interface AgentClient {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AgentResponse>;
}

/** 502 (§26.3). internal — причина только для журнала API, без токена. */
export const agentUnavailable = (internal?: unknown) =>
  new AppError('backup_agent_unavailable', 502, 'Агент бэкапа недоступен', undefined, internal);

export function createAgentClient(o: {
  url: string;
  token: string;
  timeoutMs?: number;
}): AgentClient {
  const base = o.url.replace(/\/$/, '');
  const timeoutMs = o.timeoutMs ?? 10_000;
  return {
    async request(method, path, body) {
      let status: number;
      let text: string;
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${o.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        text = await res.text();
      } catch (e) {
        throw agentUnavailable(e instanceof Error ? e.message : String(e));
      }
      if (status === 401) throw agentUnavailable('агент отклонил BACKUP_AGENT_TOKEN');
      if (status >= 500) throw agentUnavailable(`агент ответил HTTP ${status}`);
      if (!text) return { status, body: undefined };
      try {
        return { status, body: JSON.parse(text) as unknown };
      } catch {
        throw agentUnavailable(`агент ответил не JSON (HTTP ${status})`);
      }
    },
  };
}
