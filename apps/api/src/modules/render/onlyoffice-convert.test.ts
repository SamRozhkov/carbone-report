import { describe, expect, it } from 'vitest';
import { verifyOnlyOffice } from '../onlyoffice/jwt';
import { createOnlyOfficeConverter } from './onlyoffice-convert';

const secret = new TextEncoder().encode('s'.repeat(32));
const BASE = 'http://onlyoffice';
const req = (signal = AbortSignal.timeout(5000)) => ({
  filetype: 'docx' as const,
  outputtype: 'pdf' as const,
  title: 'report.docx',
  url: 'http://10.0.0.5:3000/internal/render-files/abc?t=tok',
  signal,
});

function fake(converter: unknown, file: Response | (() => Response) = new Response('%PDF-1.7 ok')) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/converter')) {
      return converter instanceof Response ? converter : Response.json(converter);
    }
    return typeof file === 'function' ? file() : file;
  }) as typeof fetch;
  return { fn, calls };
}

describe('createOnlyOfficeConverter', () => {
  it('тело запроса, JWT тела, accept json, скачивание результата по внутреннему адресу', async () => {
    const { fn, calls } = fake({
      endConvert: true,
      fileUrl: 'https://reports.example/onlyoffice/cache/files/data/k/output.pdf?md5=1&expires=2',
      percent: 100,
    });
    const out = await createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req());
    expect(out.toString()).toBe('%PDF-1.7 ok');
    expect(calls[0]!.url).toBe('http://onlyoffice/converter');
    expect(new Headers(calls[0]!.init!.headers).get('accept')).toBe('application/json');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({
      async: false,
      filetype: 'docx',
      outputtype: 'pdf',
      title: 'report.docx',
      region: 'ru-RU',
      url: req().url,
    });
    expect(body.key).toMatch(/^[0-9a-f]{32}$/);
    const { token, ...rest } = body;
    expect(await verifyOnlyOffice(token, secret)).toMatchObject(rest);
    expect(calls[1]!.url).toBe('http://onlyoffice/cache/files/data/k/output.pdf?md5=1&expires=2');
  });

  it('ключ новый на каждый вызов', async () => {
    const { fn, calls } = fake({ endConvert: true, fileUrl: 'http://x/cache/files/a/output.pdf' });
    const convert = createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn });
    await convert(req());
    await convert(req());
    const keys = calls
      .filter((c) => c.url.endsWith('/converter'))
      .map((c) => JSON.parse(String(c.init!.body)).key);
    expect(new Set(keys).size).toBe(2);
  });

  it('error: -4 — CONVERT_ERROR «ошибка конвертации (код -4)»', async () => {
    const { fn } = fake({ error: -4 });
    await expect(
      createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req()),
    ).rejects.toMatchObject({
      code: 'CONVERT_ERROR',
      status: 502,
      message: 'ошибка конвертации (код -4)',
    });
  });

  it('Document Server недоступен — CONVERT_ERROR «сервис конвертации недоступен»', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(
      createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req()),
    ).rejects.toMatchObject({
      code: 'CONVERT_ERROR',
      message: 'сервис конвертации недоступен',
    });
  });

  it('HTTP 500 или не JSON — «сервис конвертации недоступен»', async () => {
    const { fn } = fake(new Response('<xml/>', { status: 500 }));
    await expect(
      createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req()),
    ).rejects.toMatchObject({
      message: 'сервис конвертации недоступен',
    });
  });

  it('ответ JSON, но не объект (null, число) — «сервис конвертации недоступен»', async () => {
    for (const body of ['null', '42']) {
      const { fn } = fake(new Response(body, { headers: { 'content-type': 'application/json' } }));
      await expect(
        createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req()),
      ).rejects.toMatchObject({ code: 'CONVERT_ERROR', message: 'сервис конвертации недоступен' });
    }
  });

  it('запрос к /converter и скачивание — без перехода по редиректам', async () => {
    const { fn, calls } = fake({ endConvert: true, fileUrl: 'http://x/cache/files/a/output.pdf' });
    await createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req());
    expect(calls.map((c) => c.init?.redirect)).toEqual(['error', 'error']);
  });

  it('адрес результата не из /cache/files/ — ошибка, файл не скачивается', async () => {
    const { fn, calls } = fake({ endConvert: true, fileUrl: 'http://evil/other' });
    await expect(
      createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req()),
    ).rejects.toMatchObject({
      code: 'CONVERT_ERROR',
    });
    expect(calls).toHaveLength(1);
  });

  it('результат больше лимита — ошибка', async () => {
    const { fn } = fake(
      { endConvert: true, fileUrl: 'http://x/cache/files/a/output.pdf' },
      new Response('%PDF' + 'x'.repeat(100)),
    );
    await expect(
      createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn, maxBytes: 50 })(req()),
    ).rejects.toMatchObject({
      code: 'CONVERT_ERROR',
    });
  });

  it('прерывание по сроку — TIMEOUT', async () => {
    const ctrl = new AbortController();
    const fn = (async (_u: string | URL, init?: RequestInit) => {
      ctrl.abort();
      throw init?.signal?.reason ?? new Error('aborted');
    }) as typeof fetch;
    await expect(
      createOnlyOfficeConverter({ baseUrl: BASE, secret, fetch: fn })(req(ctrl.signal)),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 504,
    });
  });
});
