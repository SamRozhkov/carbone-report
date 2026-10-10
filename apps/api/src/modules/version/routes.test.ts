import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it } from 'vitest';
import { createFastify, type App, type AppDeps } from '../../app';
import { registerErrorHandler } from '../../lib/errors';
import { makeGuards } from '../auth/guards';
import { SESSION_COOKIE, signSession } from '../auth/session';
import { registerVersionRoutes } from './routes';

const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret');
const USER = { id: 'u1', login: 'ivan', role: 'user' as const };

/** Заглушка БД: select().from().where() возвращает пользователя с версией сессий 1. */
const fakeDb = {
  select: () => ({
    from: () => ({
      where: async () => [{ ...USER, blocked: false, sessionVersion: 1 }],
    }),
  }),
};

async function build() {
  const deps = {
    config: {
      appSecret: SECRET,
      appVersion: '2.1.0',
      appCommit: 'abc1234',
      appBuildDate: '2026-10-10T12:00:00+03:00',
    },
    db: fakeDb,
  } as unknown as AppDeps;
  const app = createFastify();
  registerErrorHandler(app);
  await app.register(cookie);
  registerVersionRoutes(app, deps, makeGuards(deps));
  await app.ready();
  return app;
}

describe('GET /api/version', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('с сессией — 200 и три поля из конфигурации', async () => {
    app = await build();
    const token = await signSession(USER, 1, SECRET);
    const r = await app.inject({
      method: 'GET',
      url: '/api/version',
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      version: '2.1.0',
      commit: 'abc1234',
      builtAt: '2026-10-10T12:00:00+03:00',
    });
  });

  it('без сессии — 401 и версия не раскрывается', async () => {
    app = await build();
    const r = await app.inject({ method: 'GET', url: '/api/version' });
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain('2.1.0');
  });
});
