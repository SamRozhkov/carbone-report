import { describe, expect, it, vi } from 'vitest';
import { createLlmClient, LlmError, testLlm, type LlmRequest } from './llm';

const req: LlmRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [] };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (message: object) => json(200, { choices: [{ message }] });

async function codeOf(p: Promise<unknown>) {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(LlmError);
  return e as LlmError;
}

describe('createLlmClient', () => {
  it('POST {baseUrl}/chat/completions с моделью, tools и Bearer', async () => {
    const fetch = vi.fn(async () => ok({ content: 'привет' }));
    const llm = createLlmClient({ baseUrl: 'http://x/v1/', model: 'm', apiKey: 'k' }, { fetch });
    expect(await llm(req)).toEqual({ content: 'привет', toolCalls: [] });
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://x/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'm', messages: req.messages, stream: false });
    expect(body.tools).toBeUndefined(); // пустой список инструментов не отправляется
  });

  it('без ключа — без Authorization', async () => {
    const fetch = vi.fn(async (_u: unknown, _i?: RequestInit) => ok({ content: 'x' }));
    await createLlmClient({ baseUrl: 'http://x', model: 'm', apiKey: null }, { fetch })(req);
    const init = fetch.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('tool_calls разбираются', async () => {
    const call = {
      id: 'c1',
      type: 'function',
      function: { name: 'list_reports', arguments: '{}' },
    };
    const fetch = vi.fn(async () => ok({ content: null, tool_calls: [call] }));
    const r = await createLlmClient(
      { baseUrl: 'http://x', model: 'm', apiKey: null },
      { fetch },
    )(req);
    expect(r).toEqual({ content: null, toolCalls: [call] });
  });

  it('arguments объектом (некоторые шлюзы) — строка JSON; отсутствуют — {}', async () => {
    const calls = [
      { id: 'c1', type: 'function', function: { name: 'a', arguments: { search: 'x' } } },
      { id: 'c2', type: 'function', function: { name: 'b' } },
    ];
    const fetch = vi.fn(async () => ok({ content: null, tool_calls: calls }));
    const r = await createLlmClient(
      { baseUrl: 'http://x', model: 'm', apiKey: null },
      { fetch },
    )(req);
    expect(r.toolCalls.map((c) => c.function.arguments)).toEqual(['{"search":"x"}', '{}']);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'model'],
    [400, 'model'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('HTTP %i → %s', async (status, code) => {
    const fetch = vi.fn(async () => json(status, { error: { message: 'boom' } }));
    const e = await codeOf(
      createLlmClient({ baseUrl: 'http://x', model: 'm', apiKey: null }, { fetch })(req),
    );
    expect(e.code).toBe(code);
    expect(e.detail).toContain(String(status));
  });

  it('сеть и неразборчивый ответ → unavailable', async () => {
    const cfg = { baseUrl: 'http://x', model: 'm', apiKey: null };
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await codeOf(createLlmClient(cfg, { fetch: down })(req))).code).toBe('unavailable');
    const junk = vi.fn(async () => new Response('<html>', { status: 200 }));
    expect((await codeOf(createLlmClient(cfg, { fetch: junk })(req))).code).toBe('unavailable');
    const empty = vi.fn(async () => json(200, { choices: [] }));
    expect((await codeOf(createLlmClient(cfg, { fetch: empty })(req))).code).toBe('unavailable');
  });

  it('таймаут → unavailable', async () => {
    const hang = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_r, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    const llm = createLlmClient(
      { baseUrl: 'http://x', model: 'm', apiKey: null },
      { fetch: hang as unknown as typeof fetch, timeoutMs: 20 },
    );
    expect((await codeOf(llm(req))).code).toBe('unavailable');
  });

  it('ключ в теле ошибки заменяется на ***', async () => {
    const fetch = vi.fn(async () => json(401, { error: 'bad key sk-SECRET-1' }));
    const e = await codeOf(
      createLlmClient({ baseUrl: 'http://x', model: 'm', apiKey: 'sk-SECRET-1' }, { fetch })(req),
    );
    expect(e.detail).not.toContain('sk-SECRET-1');
    expect(e.message).not.toContain('sk-SECRET-1');
    expect(e.detail).toContain('***');
  });
});

describe('testLlm', () => {
  it('модель вызвала ping — ок; не вызвала — model', async () => {
    const pinged = vi.fn(async (_r: LlmRequest) => ({
      content: null,
      toolCalls: [
        { id: '1', type: 'function' as const, function: { name: 'ping', arguments: '{}' } },
      ],
    }));
    await expect(testLlm(pinged)).resolves.toBeUndefined();
    expect(pinged.mock.calls[0]![0].toolChoice).toEqual({
      type: 'function',
      function: { name: 'ping' },
    });
    const silent = vi.fn(async () => ({ content: 'pong', toolCalls: [] }));
    expect((await codeOf(testLlm(silent))).code).toBe('model');
  });
});
