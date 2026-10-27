import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistantSettings } from '../src/db/schema';
import { decryptSecret } from '../src/lib/crypto';
import { fakeLlm } from './fake-llm';
import { createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let user: string;

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
});
afterAll(() => t.close());

const put = (payload: object, cookie = admin) =>
  t.app.inject({ method: 'PUT', url: '/api/admin/assistant', headers: { cookie }, payload });
const get = (cookie = admin) =>
  t.app.inject({ method: 'GET', url: '/api/admin/assistant', headers: { cookie } });
const me = (cookie: string) =>
  t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

const ON = {
  enabled: true,
  baseUrl: 'http://llm.local/v1',
  model: 'm1',
  extraInstructions: 'Продажи — в «Коммерции»',
};

describe('настройки ассистента', () => {
  it('по умолчанию выключен; features.assistant = false', async () => {
    expect((await get()).json()).toEqual({
      enabled: false,
      baseUrl: '',
      model: '',
      hasApiKey: false,
      extraInstructions: '',
    });
    expect((await me(user)).json().features.assistant).toBe(false);
  });

  it('только admin', async () => {
    expect((await get(user)).statusCode).toBe(403);
    expect((await put(ON, user)).statusCode).toBe(403);
  });

  it('ключ шифруется, не возвращается и не меняется без поля apiKey', async () => {
    expect((await put({ ...ON, apiKey: 'sk-secret' })).statusCode).toBe(204);
    const dto = (await get()).json();
    expect(dto).toEqual({ ...ON, hasApiKey: true });
    expect(JSON.stringify(dto)).not.toContain('sk-secret');
    const [row] = await t.deps.db
      .select()
      .from(assistantSettings)
      .where(eq(assistantSettings.id, 1));
    expect(row!.apiKeyEnc).not.toContain('sk-secret');
    expect(decryptSecret(row!.apiKeyEnc!, t.deps.config.encryptionKey)).toBe('sk-secret');

    expect((await put({ ...ON, model: 'm2' })).statusCode).toBe(204);
    const [row2] = await t.deps.db
      .select()
      .from(assistantSettings)
      .where(eq(assistantSettings.id, 1));
    expect(decryptSecret(row2!.apiKeyEnc!, t.deps.config.encryptionKey)).toBe('sk-secret');

    expect((await put({ ...ON, apiKey: null })).statusCode).toBe(204);
    expect((await get()).json().hasApiKey).toBe(false);
  });

  it('включённый ассистент виден в features.assistant', async () => {
    await put(ON);
    expect((await me(user)).json().features.assistant).toBe(true);
    await put({ ...ON, enabled: false });
    expect((await me(user)).json().features.assistant).toBe(false);
  });

  it('включение без адреса — 400 с полем baseUrl', async () => {
    const r = await put({ ...ON, baseUrl: '' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('baseUrl');
  });
});

describe('проверка подключения', () => {
  const ping = {
    content: null,
    tool_calls: [{ id: '1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
  };
  const test = (payload: object, cookie = admin) =>
    t.app.inject({
      method: 'POST',
      url: '/api/admin/assistant/test',
      headers: { cookie },
      payload,
    });

  it('ok и ключ из формы', async () => {
    const llm = await fakeLlm(() => ({ message: ping }));
    const r = await test({ baseUrl: llm.url, model: 'm', apiKey: 'form-key' });
    expect(r.json()).toEqual({ ok: true });
    expect(llm.auth).toEqual(['Bearer form-key']);
    await llm.close();
  });

  it('без apiKey берётся сохранённый ключ', async () => {
    await put({ ...ON, apiKey: 'saved-key' });
    const llm = await fakeLlm(() => ({ message: ping }));
    await test({ baseUrl: llm.url, model: 'm' });
    expect(llm.auth).toEqual(['Bearer saved-key']);
    await llm.close();
  });

  it('401 → auth с текстом; недоступный адрес → unavailable; только admin', async () => {
    const llm = await fakeLlm(() => ({ status: 401 }));
    expect((await test({ baseUrl: llm.url, model: 'm', apiKey: 'k' })).json()).toEqual({
      ok: false,
      code: 'auth',
      message: 'Провайдер модели отклонил ключ. Обратитесь к администратору',
    });
    await llm.close();
    const down = await test({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: null });
    expect(down.json()).toMatchObject({ ok: false, code: 'unavailable' });
    expect((await test({ baseUrl: llm.url, model: 'm' }, user)).statusCode).toBe(403);
  });
});
