import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Фейковый OpenAI: отвечает handler(body); запоминает заголовки Authorization. */
export async function fakeLlm(
  handler: (body: { messages: unknown[]; tools?: unknown[] }) => {
    status?: number;
    message?: object;
  },
): Promise<{ url: string; auth: (string | undefined)[]; close(): Promise<void> }> {
  const auth: (string | undefined)[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      auth.push(req.headers.authorization);
      const r = handler(JSON.parse(raw));
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.message ? { choices: [{ message: r.message }] } : { error: 'x' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    auth,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
