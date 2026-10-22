import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { zodLocale } from '@carbone-reports/shared/i18n';
import { createTranslator } from '@carbone-reports/shared/i18n/server';
import { createFastify } from '../app';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  issueText,
  localizedSafeParse,
  notFound,
  registerErrorHandler,
  ruText,
  text,
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
      throw new AppError(
        'SQL_ERROR',
        400,
        { key: 'sql.error', params: { what: text('sql.query', { key: 'a' }), message: 'ошибка' } },
        { key: 'a' },
      );
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

  it('вложенные сообщения и text(…) в details — на языке запроса; err.details — по-русски', async () => {
    const err = new AppError(
      'IMPORT_INVALID',
      400,
      {
        key: 'import.templateError',
        params: { template: 'Счёт', message: text('pdf.tooManyPages', { count: 500 }) },
      },
      { fields: { a: text('param.required') }, list: [{ path: '/x', message: 'v:invalidId' }] },
    );
    expect(err.message).toBe('шаблон «Счёт»: в приложенных файлах шаблона не больше 500 страниц');
    expect(err.details).toEqual({
      fields: { a: 'обязательный параметр' },
      list: [{ path: '/x', message: 'неверный идентификатор' }],
    });
    const app = await localized(() => {
      throw err;
    });
    const en = createTranslator('en');
    const body = (await post(app, 'en', { n: 1 })).json().error;
    expect(body.message).toBe(
      en('errors:import.templateError', {
        template: 'Счёт',
        message: en('errors:pdf.tooManyPages', { count: 500 }),
      }),
    );
    expect(body.details).toEqual({
      fields: { a: en('errors:param.required') },
      list: [{ path: '/x', message: en('validation:invalidId') }],
    });
    expect(JSON.stringify(body)).not.toMatch(/[а-яё]+ [а-яё]+/i);
  });

  it('issueText: сообщение zod строится на языке запроса, ввод в ответ не попадает', async () => {
    const r = localizedSafeParse(z.object({ n: z.number() }), { n: 'секрет' });
    expect(r.success).toBe(false);
    const app = await localized(() => {
      throw badRequest('import.invalidDecisions', { message: issueText(r.error!.issues[0]!) });
    });
    const ru = (await post(app, null, { n: 1 })).json().error.message;
    expect(ru).toBe(
      `неверные решения по шаблонам: ${zodLocale('ru').localeError({ code: 'invalid_type', expected: 'number', input: 'секрет' } as never)}`,
    );
    const de = (await post(app, 'de', { n: 1 })).json().error.message;
    expect(de).not.toMatch(/[а-яё]/i);
    expect(de).not.toContain('секрет');
  });

  it('ключа нет в каталоге — общий текст по статусу и предупреждение в журнал', async () => {
    const warn = vi.fn();
    const app = createFastify();
    registerRequestLocale(app, 'ru');
    registerErrorHandler(app);
    app.addHook('onRequest', async (req) => {
      req.log.warn = warn as never;
    });
    app.get('/400', async () => {
      throw badRequest('нет.такого');
    });
    app.get('/502', async () => {
      throw new AppError('X', 502, { key: 'missing.key' });
    });
    await app.ready();
    const get = (url: string, locale?: string) =>
      app.inject({ method: 'GET', url, headers: locale ? { 'x-locale': locale } : {} });
    expect((await get('/400')).json().error).toEqual({
      code: 'BAD_REQUEST',
      message: 'некорректный запрос',
    });
    expect((await get('/400', 'en')).json().error.message).toBe(
      createTranslator('en')('errors:badRequest'),
    );
    expect(warn).toHaveBeenCalledWith(
      { key: 'нет.такого', code: 'BAD_REQUEST' },
      'нет ключа в каталоге errors',
    );
    expect((await get('/502', 'en')).json().error.message).toBe(
      createTranslator('en')('errors:internal'),
    );
  });

  it('issueText не отдаёт ввод при сериализации', () => {
    const r = localizedSafeParse(z.object({ n: z.number() }), { n: 'секрет' });
    expect(JSON.stringify(issueText(r.error!.issues[0]!))).not.toContain('секрет');
  });

  it('помощники: только ключи каталога', async () => {
    expect(forbidden().msg).toEqual({ key: 'forbidden', params: undefined });
    expect(unauthorized().msg).toEqual({ key: 'unauthorized' });
    expect(badRequest('fileTooLarge', { size: 5 }).message).toBe('файл больше 5 МБ');
    expect(notFound('template').message).toBe('шаблон не найден');
    expect(notFound('group').message).toBe('группа не найдена');
    expect(conflict('user.loginTaken').msg).toEqual({ key: 'user.loginTaken', params: undefined });
  });

  it('множественное число по count: ru 1/2/5/21, en 1/2', () => {
    const ru = (count: number) => ruText('sign.tooManyPasswords', { count });
    expect(ru(1)).toBe('слишком много неверных паролей — попробуйте через 1 минуту');
    expect(ru(2)).toBe('слишком много неверных паролей — попробуйте через 2 минуты');
    expect(ru(5)).toBe('слишком много неверных паролей — попробуйте через 5 минут');
    expect(ru(21)).toBe('слишком много неверных паролей — попробуйте через 21 минуту');
    expect(ru(15)).toBe('слишком много неверных паролей — попробуйте через 15 минут');
    const en = createTranslator('en');
    expect(en('errors:sign.tooManyPasswords', { count: 1 })).toBe(
      'too many wrong passwords — try again in 1 minute',
    );
    expect(en('errors:sign.tooManyPasswords', { count: 2 })).toBe(
      'too many wrong passwords — try again in 2 minutes',
    );
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
