import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers';

const IP_MESSAGE = 'слишком много попыток входа с этого адреса, повторите через минуту';

// nginx в тестах нет: адрес клиента, который nginx дописывает последним в
// X-Forwarded-For, эмулируется заголовком. При trustProxy: 1 req.ip — последний адрес.
const attempt = (t: TestApp, login: string, xff: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': xff },
    payload: { login, password: 'bad' },
  });

describe('лимит входа по IP', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.close());

  it('30 входов с разными логинами с одного IP проходят, 31-й — 429; другой IP не задет', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await attempt(t, `u${i}`, '10.0.0.1')).statusCode).toBe(401);
    }
    const res = await attempt(t, 'u30', '10.0.0.1');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      error: { code: 'TOO_MANY_ATTEMPTS', message: IP_MESSAGE },
    });
    expect((await attempt(t, 'u31', '10.0.0.2')).statusCode).toBe(401);
  });

  it('подставленный клиентом адрес в начале X-Forwarded-For не учитывается', async () => {
    // 1.2.3.4 подставил клиент, 10.0.0.1 дописал nginx: считается 10.0.0.1.
    for (let i = 0; i < 30; i++) {
      expect((await attempt(t, `u${i}`, '1.2.3.4, 10.0.0.1')).statusCode).toBe(401);
    }
    const res = await attempt(t, 'u30', '5.6.7.8, 10.0.0.1');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: { message: IP_MESSAGE } });
  });

  it('лимит по логину работает как раньше: 11-я попытка одного логина — 429', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await attempt(t, 'x', '10.0.0.1')).statusCode).toBe(401);
    }
    const res = await attempt(t, 'x', '10.0.0.1');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      error: {
        code: 'TOO_MANY_ATTEMPTS',
        message: 'слишком много попыток входа, повторите через минуту',
      },
    });
  });
});
