import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFastify } from '../app';
import { AppError, registerErrorHandler } from './errors';

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
