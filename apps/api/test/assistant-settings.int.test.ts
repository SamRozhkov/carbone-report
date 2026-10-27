import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistantSettings } from '../src/db/schema';
import { decryptSecret } from '../src/lib/crypto';
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
