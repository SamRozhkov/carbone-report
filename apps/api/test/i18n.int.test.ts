import { zodLocale } from '@carbone-reports/shared/i18n';
import { createTranslator } from '@carbone-reports/shared/i18n/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { createTestApp, loginAs, type TestApp } from './helpers';

const CYRILLIC = /[а-яё]/i;

let t: TestApp;
let admin: { cookie: string; user: { id: string; login: string } };
let user: { cookie: string; user: { id: string } };
beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t, 'admin');
  user = await loginAs(t, 'user');
});
afterAll(() => t.close());

const me = async (cookie: string) =>
  (await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json();
const putLocale = (cookie: string | null, payload: unknown) =>
  t.app.inject({
    method: 'PUT',
    url: '/api/me/locale',
    headers: cookie ? { cookie } : {},
    payload: payload as object,
  });

describe('GET /api/i18n', () => {
  it('без входа отдаёт язык по умолчанию', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/i18n' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ defaultLocale: 'ru' });
  });

  it('DEFAULT_LOCALE=en', async () => {
    const en = await createTestApp({}, { defaultLocale: 'en' });
    try {
      const r = await en.app.inject({ method: 'GET', url: '/api/i18n' });
      expect(r.json()).toEqual({ defaultLocale: 'en' });
      // Без X-Locale и Accept-Language ошибки — на языке по умолчанию.
      const unauth = await en.app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(unauth.json().error.message).toBe(createTranslator('en')('errors:unauthorized'));
    } finally {
      await en.close();
    }
  });
});

describe('PUT /api/me/locale', () => {
  it('сохраняет язык, /api/auth/me его отдаёт; null — сброс', async () => {
    expect((await me(user.cookie)).locale).toBeNull();
    expect((await putLocale(user.cookie, { locale: 'de' })).statusCode).toBe(204);
    expect((await me(user.cookie)).locale).toBe('de');
    expect((await putLocale(user.cookie, { locale: null })).statusCode).toBe(204);
    expect((await me(user.cookie)).locale).toBeNull();
  });

  it('значение вне LOCALES в БД читается как null', async () => {
    await t.deps.db.update(users).set({ locale: 'it' }).where(eq(users.id, user.user.id));
    expect((await me(user.cookie)).locale).toBeNull();
    await t.deps.db.update(users).set({ locale: null }).where(eq(users.id, user.user.id));
  });

  it('вход возвращает выбранный язык', async () => {
    expect((await putLocale(admin.cookie, { locale: 'zh-CN' })).statusCode).toBe(204);
    const [row] = await t.deps.db.select().from(users).where(eq(users.id, admin.user.id));
    expect(row!.locale).toBe('zh-CN');
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: row!.login, password: 'password123' },
    });
    expect(login.json()).toMatchObject({ id: admin.user.id, locale: 'zh-CN' });
    await putLocale(admin.cookie, { locale: null });
  });

  it('неизвестный язык → 400 VALIDATION', async () => {
    const r = await putLocale(user.cookie, { locale: 'it' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
    expect((await putLocale(user.cookie, {})).statusCode).toBe(400);
  });

  it('без входа → 401', async () => {
    const r = await putLocale(null, { locale: 'en' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toBe('требуется вход');
  });
});

describe('перевод ошибок', () => {
  const createUser = (headers: Record<string, string>) =>
    t.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin.cookie, ...headers },
      payload: { login: 'a', password: 'password1', role: 'user' },
    });
  // Тот же issue, что даёт CreateUserBody.login (trim().min(3)) на «a».
  const tooShort = {
    code: 'too_small',
    origin: 'string',
    minimum: 3,
    inclusive: true,
    input: 'a',
  } as never;

  it('ошибка zod: en, de, по умолчанию — ru', async () => {
    const en = await createUser({ 'x-locale': 'en' });
    expect(en.statusCode).toBe(400);
    expect(en.json().error.code).toBe('VALIDATION');
    expect(en.json().error.message).toBe(createTranslator('en')('errors:validation'));
    expect(en.json().error.details[0]).toEqual({
      path: '/login',
      message: zodLocale('en').localeError(tooShort),
    });
    expect(en.json().error.details[0].message).not.toMatch(CYRILLIC);

    const de = await createUser({ 'x-locale': 'de' });
    expect(de.json().error.details[0].message).toBe(zodLocale('de').localeError(tooShort));

    const ru = await createUser({});
    expect(ru.json().error.message).toBe('неверные данные запроса');
    expect(ru.json().error.details[0].message).toBe(zodLocale('ru').localeError(tooShort));
  });

  it('Accept-Language учитывается без X-Locale', async () => {
    const r = await createUser({ 'accept-language': 'fr-CA,fr;q=0.9' });
    expect(r.json().error.details[0].message).toBe(zodLocale('fr').localeError(tooShort));
  });

  it('AppError со строкой (до перевода вызовов) — русский текст на любом языке', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/datasources/${crypto.randomUUID()}/test`,
      headers: { cookie: admin.cookie, 'x-locale': 'en' },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe('источник данных не найден');
  });

  it('базовые ошибки переводятся: 401 и 403', async () => {
    const unauth = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { 'x-locale': 'en' },
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json().error.message).toBe(createTranslator('en')('errors:unauthorized'));
    expect(unauth.json().error.message).not.toMatch(CYRILLIC);
    const denied = await t.app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: user.cookie, 'x-locale': 'es' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(createTranslator('es')('errors:forbidden'));
  });

  it('FST_ERR_CTP_INVALID_JSON_BODY с X-Locale: en — по-английски', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'x-locale': 'en' },
      payload: '{oops',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe(createTranslator('en')('errors:invalidJson'));
    expect(r.json().error.message).not.toMatch(CYRILLIC);
  });
});
