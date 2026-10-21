import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFastify, type App, type AppDeps } from '../../app';
import { registerErrorHandler } from '../../lib/errors';
import { makeGuards } from '../auth/guards';
import { sessionCookieName, signSession } from '../auth/session';
import type { FeedbackSender } from './mail';
import { registerFeedbackRoutes } from './routes';

const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret');
const USER = { id: 'u1', login: 'ivan', role: 'user' as const };
const BODY = {
  subject: 'Не строится отчет',
  message: 'Ошибка при выборе периода',
  page: '/reports',
};

async function build(sender?: FeedbackSender) {
  // Смена строки нужна только для проверки отдельных квот двух пользователей.
  let row = { ...USER, blocked: false, sessionVersion: 1 };
  const deps = {
    config: { appSecret: SECRET, feedback: null },
    db: {
      select: () => ({ from: () => ({ where: async () => [row] }) }),
    },
  } as unknown as AppDeps;
  const app = createFastify();
  registerErrorHandler(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  registerFeedbackRoutes(app, deps, makeGuards(deps), sender);
  await app.ready();
  const token = await signSession(USER, 1, SECRET);
  return {
    app,
    cookies: { [sessionCookieName(false)]: token },
    setUser: (id: string, login: string) => {
      row = { ...row, id, login };
    },
  };
}

describe('POST /api/feedback', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('requires an authenticated session before attempting SMTP', async () => {
    const sender = vi.fn<FeedbackSender>().mockResolvedValue('feedback-1');
    ({ app } = await build(sender));
    const response = await app.inject({ method: 'POST', url: '/api/feedback', payload: BODY });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    expect(sender).not.toHaveBeenCalled();
  });

  it('adds the authenticated user identity and acknowledges successful SMTP submission', async () => {
    const sender = vi.fn<FeedbackSender>().mockResolvedValue('feedback-1');
    const fixture = await build(sender);
    app = fixture.app;
    const response = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      cookies: fixture.cookies,
      payload: { ...BODY, replyTo: 'ivan@example.test' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'sent', id: 'feedback-1' });
    expect(sender).toHaveBeenCalledExactlyOnceWith({
      ...BODY,
      replyTo: 'ivan@example.test',
      login: USER.login,
      userId: USER.id,
    });
  });

  it('returns 503 when mail is not configured', async () => {
    const fixture = await build();
    app = fixture.app;
    const response = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      cookies: fixture.cookies,
      payload: BODY,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('FEEDBACK_UNAVAILABLE');
  });

  it('returns a generic 502 for SMTP failures without leaking SMTP details', async () => {
    const sender = vi
      .fn<FeedbackSender>()
      .mockRejectedValue(new Error('SMTP AUTH smtp-private-password; internal.example.test'));
    const fixture = await build(sender);
    app = fixture.app;
    const response = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      cookies: fixture.cookies,
      payload: BODY,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('FEEDBACK_SEND_FAILED');
    expect(response.body).not.toContain('smtp-private-password');
    expect(response.body).not.toContain('internal.example.test');
  });

  it.each([
    { to: 'attacker@example.test' },
    { recipient: 'attacker@example.test' },
    { login: 'administrator' },
    { userId: 'administrator-id' },
    { subject: 'hello\r\nBcc: attacker@example.test' },
    { subject: 'x'.repeat(161) },
    { message: 'x'.repeat(5001) },
    { message: '   ' },
    { replyTo: 'invalid' },
    { replyTo: 'ivan@example.test\r\nBcc: attacker@example.test' },
    { page: '/reports?token=secret' },
    { page: '/reports#access_token=secret' },
    { page: '//attacker.example.test' },
    { page: 'https://attacker.example.test/reports' },
  ])(
    'rejects recipient/identity overrides, unsafe context, and invalid content: %j',
    async (change) => {
      const sender = vi.fn<FeedbackSender>().mockResolvedValue('feedback-1');
      const fixture = await build(sender);
      app = fixture.app;
      const response = await app.inject({
        method: 'POST',
        url: '/api/feedback',
        cookies: fixture.cookies,
        payload: { ...BODY, ...change },
      });
      expect(response.statusCode).toBe(400);
      expect(sender).not.toHaveBeenCalled();
    },
  );

  it('limits each authenticated user to 5 messages and does not charge anonymous requests', async () => {
    const sender = vi.fn<FeedbackSender>().mockResolvedValue('feedback-1');
    const fixture = await build(sender);
    app = fixture.app;
    for (let i = 0; i < 6; i++) {
      const response = await app.inject({ method: 'POST', url: '/api/feedback', payload: BODY });
      expect(response.statusCode).toBe(401);
    }
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/feedback',
        cookies: fixture.cookies,
        payload: BODY,
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      cookies: fixture.cookies,
      payload: BODY,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('FEEDBACK_LIMIT');
    expect(sender).toHaveBeenCalledTimes(5);

    fixture.setUser('u2', 'petr');
    const secondToken = await signSession({ id: 'u2', login: 'petr', role: 'user' }, 1, SECRET);
    const second = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      cookies: { [sessionCookieName(false)]: secondToken },
      payload: BODY,
    });
    expect(second.statusCode).toBe(200);
    expect(sender).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'u2', login: 'petr' }),
    );
  });
});
