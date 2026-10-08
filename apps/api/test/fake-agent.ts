import Fastify from 'fastify';

export interface FakeAgentRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Тело как есть (не JSON). */
  raw?: string;
  delayMs?: number;
}

export interface FakeAgent {
  url: string;
  token: string;
  requests: FakeAgentRequest[];
  respond(method: 'GET' | 'POST', path: string, r: FakeResponse): void;
  close(): Promise<void>;
}

/** Агент бэкапа для тестов API: настоящий HTTP на 127.0.0.1, ответы задаёт тест (по умолчанию 404). */
export async function startFakeAgent(token = 'a'.repeat(40)): Promise<FakeAgent> {
  const app = Fastify({ logger: false });
  const requests: FakeAgentRequest[] = [];
  const responses = new Map<string, FakeResponse>();
  app.all('/*', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    requests.push({ method: req.method, path, auth: req.headers.authorization, body: req.body });
    const r = responses.get(`${req.method} ${path}`);
    if (!r)
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'нет ответа в тесте' } });
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    if (r.raw !== undefined) return reply.code(r.status).type('text/plain').send(r.raw);
    return r.body === undefined ? reply.code(r.status).send() : reply.code(r.status).send(r.body);
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    url,
    token,
    requests,
    respond: (method, path, r) => void responses.set(`${method} ${path}`, r),
    close: () => app.close(),
  };
}
