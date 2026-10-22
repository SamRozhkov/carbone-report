import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodLocale } from '@carbone-reports/shared/i18n';
import { createTranslator } from '@carbone-reports/shared/i18n/server';
import { createFastify } from '../app';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  registerErrorHandler,
  unauthorized,
} from './errors';
import { registerRequestLocale } from './locale';

async function appWith(handler: () => unknown) {
  const app = createFastify();
  registerErrorHandler(app);
  app.post('/t', { schema: { body: z.object({ n: z.number() }) } }, async () => handler());
  await app.ready();
  return app;
}

describe('registerErrorHandler', () => {
  it('AppError → его статус и тело {error}', async () => {
    const app = await appWith(() => {
      throw new AppError('SQL_ERROR', 400, 'запрос "a": ошибка', { key: 'a' });
    });
    const res = await app.inject({ method: 'POST', url: '/t', payload: { n: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'SQL_ERROR', message: 'запрос "a": ошибка', details: { key: 'a' } },
    });
  });
  it('ошибка валидации zod → 400 VALIDATION', async () => {
    const app = await appWith(() => 'ok');
    const res = await app.inject({ method: 'POST', url: '/t', payload: { n: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
  it('неизвестная ошибка → 500 без утечки текста', async () => {
    const app = await appWith(() => {
      throw new Error('секрет в стектрейсе');
    });
    const res = await app.inject({ method: 'POST', url: '/t', payload: { n: 1 } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL', message: 'внутренняя ошибка сервера' },
    });
  });
});

describe('перевод ошибок на язык запроса', () => {
  async function localized(handler: () => unknown) {
    const app = createFastify();
    registerRequestLocale(app, 'ru');
    registerErrorHandler(app);
    app.post(
      '/t',
      {
        schema: {
          body: z.object({
            n: z.number(),
            s: z.string().min(3).optional(),
            id: z.string().optional(),
          }),
        },
      },
      async () => handler(),
    );
    app.post(
      '/v',
      { schema: { body: z.object({ id: z.string().min(5, 'v:invalidId') }) } },
      async () => 'ok',
    );
    await app.ready();
    return app;
  }
  const post = (
    app: Awaited<ReturnType<typeof localized>>,
    locale: string | null,
    payload: unknown,
    url = '/t',
  ) =>
    app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: locale ? { 'x-locale': locale } : {},
    });

  it('AppError с ключом — на языке запроса, err.message — по-русски', async () => {
    const err = new AppError('FORBIDDEN', 403, { key: 'forbidden' });
    expect(err.message).toBe('недостаточно прав');
    const app = await localized(() => {
      throw err;
    });
    expect((await post(app, null, { n: 1 })).json().error.message).toBe('недостаточно прав');
    expect((await post(app, 'en', { n: 1 })).json().error.message).toBe(
      createTranslator('en')('errors:forbidden'),
    );
    expect((await post(app, 'en', { n: 1 })).json().error.message).not.toMatch(/[а-яё]/i);
  });

  it('параметры ключа подставляются', async () => {
    const app = await localized(() => {
      throw new AppError('BAD_REQUEST', 400, { key: 'fileTooLarge', params: { size: 20 } });
    });
    expect((await post(app, null, { n: 1 })).json().error.message).toBe('файл больше 20 МБ');
    expect((await post(app, 'de', { n: 1 })).json().error.message).toContain('20');
  });

  it('AppError со строкой (до перевода вызовов на ключи) — текст как есть на любом языке', async () => {
    const app = await localized(() => {
      throw new AppError('CONFLICT', 409, 'логин уже занят');
    });
    expect((await post(app, 'en', { n: 1 })).json().error.message).toBe('логин уже занят');
  });

  it('помощники: ключ каталога переводится, прежний русский текст остаётся', async () => {
    expect(forbidden().msg).toEqual({ key: 'forbidden', params: undefined });
    expect(unauthorized().msg).toEqual({ key: 'unauthorized' });
    expect(badRequest('fileTooLarge', { size: 5 }).message).toBe('файл больше 5 МБ');
    expect(badRequest('укажите название').msg).toBe('укажите название');
    expect(notFound('шаблон').message).toBe('шаблон не найден');
    expect(conflict('логин уже занят').msg).toBe('логин уже занят');
  });

  it('встроенные сообщения zod — на языке запроса, по умолчанию по-русски', async () => {
    const app = await localized(() => 'ok');
    const ru = (await post(app, null, { n: 'x' })).json().error;
    expect(ru.message).toBe('неверные данные запроса');
    expect(ru.details[0]).toEqual({
      path: '/n',
      message: zodLocale('ru').localeError({
        code: 'invalid_type',
        expected: 'number',
        input: 'x',
      } as never),
    });
    const en = (await post(app, 'en', { n: 'x' })).json().error;
    expect(en.message).toBe(createTranslator('en')('errors:validation'));
    expect(en.details[0].message).toBe(
      zodLocale('en').localeError({
        code: 'invalid_type',
        expected: 'number',
        input: 'x',
      } as never),
    );
    const de = (await post(app, 'de', { n: 1, s: 'a' })).json().error;
    expect(de.details[0].path).toBe('/s');
    expect(de.details[0].message).not.toMatch(/[а-яё]/i);
    expect(de.details[0].message).not.toBe(
      (await post(app, 'en', { n: 1, s: 'a' })).json().error.details[0].message,
    );
  });

  it('сообщение схемы v:<ключ> — из каталога validation', async () => {
    const app = await localized(() => 'ok');
    const ru = (await post(app, null, { id: 'a' }, '/v')).json().error;
    expect(ru.details[0].message).toBe(createTranslator('ru')('validation:invalidId'));
    expect(ru.details[0].message).not.toContain('v:');
    const en = (await post(app, 'en', { id: 'a' }, '/v')).json().error;
    expect(en.details[0].message).toBe(createTranslator('en')('validation:invalidId'));
  });

  it('details AppError: v:<ключ> переводится, прочий текст — как есть', async () => {
    const app = await localized(() => {
      throw new AppError('VALIDATION', 400, { key: 'validation' }, [
        { path: '/a', message: 'v:invalidId' },
        { path: '/b', message: 'как есть' },
      ]);
    });
    const en = (await post(app, 'en', { n: 1 })).json().error;
    expect(en.details).toEqual([
      { path: '/a', message: createTranslator('en')('validation:invalidId') },
      { path: '/b', message: 'как есть' },
    ]);
  });

  it('ошибки Fastify (FST_*) — по ключам каталога', async () => {
    const app = await localized(() => 'ok');
    const bad = await app.inject({
      method: 'POST',
      url: '/t',
      headers: { 'content-type': 'application/json', 'x-locale': 'en' },
      payload: '{oops',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe(createTranslator('en')('errors:invalidJson'));
    const ru = await app.inject({
      method: 'POST',
      url: '/t',
      headers: { 'content-type': 'application/json' },
      payload: '{oops',
    });
    expect(ru.json().error.message).toBe('некорректный JSON в теле запроса');
  });

  it('неизвестная ошибка → 500 на языке запроса', async () => {
    const app = await localized(() => {
      throw new Error('секрет');
    });
    const res = await post(app, 'fr', { n: 1 });
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL', message: createTranslator('fr')('errors:internal') },
    });
  });
});
