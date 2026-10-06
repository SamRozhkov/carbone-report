import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { CarboneClient } from './client';
import { memoryTemplateCache, type TemplateIdCache } from './template-cache';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
    };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pdf = () =>
  new Response(Buffer.from('%PDF-1.7 test'), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });

const tpl = (version = 1) => ({
  id: 'tpl-1',
  version,
  ext: 'docx' as const,
  read: async () => Buffer.from('PK\x03\x04docx'),
});
const opts = {
  convertTo: 'pdf' as const,
  lang: 'ru-ru',
  timezone: 'Europe/Moscow',
  timeoutMs: 1000,
};

describe('CarboneClient', () => {
  it('загружает шаблон, затем рендерит с download=true и заголовком версии', async () => {
    const { fn, calls } = fakeFetch((c) =>
      c.url.endsWith('/template')
        ? json(200, { success: true, data: { templateId: 'abc' } })
        : pdf(),
    );
    const client = new CarboneClient({ baseUrl: 'http://carbone:4000', fetch: fn });
    const out = await client.render(tpl(), { a: 1 }, opts);
    expect(out.toString()).toBe('%PDF-1.7 test');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://carbone:4000/template',
      'POST http://carbone:4000/render/abc?download=true',
    ]);
    expect(calls.every((c) => c.headers['carbone-version'] === '5')).toBe(true);
    expect(calls[0]!.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(calls[1]!.body))).toEqual({
      data: { a: 1 },
      convertTo: 'pdf',
      lang: 'ru-ru',
      timezone: 'Europe/Moscow',
    });
  });

  it('кэширует templateId для той же версии и перезагружает для новой', async () => {
    let uploads = 0;
    const { fn } = fakeFetch((c) => {
      if (c.url.endsWith('/template'))
        return json(200, { success: true, data: { templateId: `id${++uploads}` } });
      return pdf();
    });
    const cache = memoryTemplateCache();
    const client = new CarboneClient({ baseUrl: 'http://c', fetch: fn, cache });
    await client.render(tpl(1), {}, opts);
    await client.render(tpl(1), {}, opts);
    expect(uploads).toBe(1);
    expect(await cache.get('tpl-1')).toEqual({ version: 1, carboneId: 'id1' });
    await client.render(tpl(2), {}, opts);
    expect(uploads).toBe(2);
  });

  it('если Carbone потерял шаблон — загружает заново и повторяет один раз', async () => {
    let renders = 0;
    const { fn, calls } = fakeFetch((c) => {
      if (c.url.endsWith('/template'))
        return json(200, { success: true, data: { templateId: 'new' } });
      renders++;
      return renders === 2 ? json(404, { success: false, error: 'Template not found' }) : pdf();
    });
    const infos: { obj: object; msg: string }[] = [];
    const client = new CarboneClient({
      baseUrl: 'http://c',
      fetch: fn,
      log: { info: (obj, msg) => infos.push({ obj, msg }) },
    });
    await client.render(tpl(), {}, opts);
    await client.render(tpl(), {}, opts);
    expect(calls.filter((c) => c.url.endsWith('/template'))).toHaveLength(2);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.msg).toContain('загружаем повторно');
  });

  it('общий кэш: второй клиент не загружает шаблон повторно', async () => {
    let uploads = 0;
    const { fn } = fakeFetch((c) =>
      c.url.endsWith('/template')
        ? json(200, { success: true, data: { templateId: `id${++uploads}` } })
        : pdf(),
    );
    const cache = memoryTemplateCache();
    await new CarboneClient({ baseUrl: 'http://c', fetch: fn, cache }).render(tpl(), {}, opts);
    await new CarboneClient({ baseUrl: 'http://c', fetch: fn, cache }).render(tpl(), {}, opts);
    expect(uploads).toBe(1);
  });

  it('ошибки кэша не мешают рендеру: шаблон загружается, результат возвращается', async () => {
    let uploads = 0;
    const { fn, calls } = fakeFetch((c) =>
      c.url.endsWith('/template')
        ? json(200, { success: true, data: { templateId: `id${++uploads}` } })
        : pdf(),
    );
    const cache: TemplateIdCache = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => {
        throw new Error('redis down');
      },
    };
    const client = new CarboneClient({ baseUrl: 'http://c', fetch: fn, cache });
    const out = await client.render(tpl(), {}, opts);
    expect(out.toString()).toBe('%PDF-1.7 test');
    expect(uploads).toBe(1);
    expect(calls.at(-1)!.url).toBe('http://c/render/id1?download=true');
  });

  it('ошибка рендера → AppError CARBONE_ERROR 502 с текстом Carbone', async () => {
    const { fn } = fakeFetch((c) =>
      c.url.endsWith('/template')
        ? json(200, { success: true, data: { templateId: 'x' } })
        : json(400, { success: false, error: 'Error: formatter "foo" does not exist' }),
    );
    const client = new CarboneClient({ baseUrl: 'http://c', fetch: fn });
    const e = await client.render(tpl(), {}, opts).catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect([e.code, e.status]).toEqual(['CARBONE_ERROR', 502]);
    expect(e.message).toContain('formatter "foo" does not exist');
  });

  it('Carbone недоступен → CARBONE_ERROR 502', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const e = await new CarboneClient({ baseUrl: 'http://c', fetch: fn })
      .render(tpl(), {}, opts)
      .catch((x) => x);
    expect([e.code, e.status]).toEqual(['CARBONE_ERROR', 502]);
    expect(e.message).toBe('сервис генерации недоступен');
  });

  it('таймаут → TIMEOUT 504', async () => {
    const fn = (async (_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const e = await new CarboneClient({ baseUrl: 'http://c', fetch: fn })
      .render(tpl(), {}, { ...opts, timeoutMs: 50 })
      .catch((x) => x);
    expect([e.code, e.status]).toEqual(['TIMEOUT', 504]);
  });
});
