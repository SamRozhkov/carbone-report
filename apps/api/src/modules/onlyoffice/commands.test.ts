import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { createOnlyOfficeCommands } from './commands';
import { verifyOnlyOffice } from './jwt';

const secret = new TextEncoder().encode('o'.repeat(32));

function fake(response: unknown) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get('authorization'),
    });
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fn, calls };
}

describe('createOnlyOfficeCommands.forceSave', () => {
  it('шлёт подписанную команду на /command', async () => {
    const { fn, calls } = fake({ error: 0 });
    await createOnlyOfficeCommands({ baseUrl: 'http://oo', secret, fetch: fn }).forceSave('k1');
    expect(calls[0]!.url).toBe('http://oo/command');
    expect(calls[0]!.body).toMatchObject({ c: 'forcesave', key: 'k1' });
    expect(await verifyOnlyOffice(calls[0]!.body.token as string, secret)).toMatchObject({
      c: 'forcesave',
      key: 'k1',
    });
    const header = await verifyOnlyOffice(calls[0]!.auth!.replace('Bearer ', ''), secret);
    expect(header.payload).toMatchObject({ c: 'forcesave', key: 'k1' });
  });
  it('error 4 (нет изменений) — не ошибка', async () => {
    const { fn } = fake({ error: 4 });
    await expect(
      createOnlyOfficeCommands({ baseUrl: 'http://oo', secret, fetch: fn }).forceSave('k'),
    ).resolves.toBeUndefined();
  });
  it('error 1 (документ не открыт) → понятная ошибка 409', async () => {
    const { fn } = fake({ error: 1 });
    const e = await createOnlyOfficeCommands({ baseUrl: 'http://oo', secret, fetch: fn })
      .forceSave('k')
      .catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect([e.code, e.status]).toEqual(['NOT_OPEN', 409]);
  });
  it('другая ошибка → 502', async () => {
    const { fn } = fake({ error: 6 });
    const e = await createOnlyOfficeCommands({ baseUrl: 'http://oo', secret, fetch: fn })
      .forceSave('k')
      .catch((x) => x);
    expect([e.code, e.status]).toEqual(['ONLYOFFICE_ERROR', 502]);
  });
});
