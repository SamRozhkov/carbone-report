import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it } from 'vitest';
import { createFastify, type AppDeps } from '../../app';
import { registerErrorHandler } from '../../lib/errors';
import { makeGuards } from '../auth/guards';
import { registerAuthRoutes } from '../auth/routes';
import { sessionCookieName, signSession } from '../auth/session';

const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret');
const USER = { id: 'u1', login: 'ivan', role: 'user' as const };

describe('feedback feature advertised to authenticated clients', () => {
  it.each([false, true])('reports configured=%s in /api/auth/me', async (enabled) => {
    const deps = {
      config: {
        appSecret: SECRET,
        cookieSecure: true,
        feedback: enabled ? { to: 'support@example.test' } : null,
      },
      backupAgent: null,
      db: {
        select: () => ({
          from: () => ({
            where: async () => [{ ...USER, blocked: false, sessionVersion: 1 }],
          }),
        }),
      },
    } as unknown as AppDeps;
    const app = createFastify();
    registerErrorHandler(app);
    await app.register(cookie);
    await app.register(rateLimit, { global: false });
    registerAuthRoutes(app, deps, makeGuards(deps));
    try {
      const token = await signSession(USER, 1, SECRET);
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { [sessionCookieName(true)]: token },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().features).toEqual({ backups: false, feedback: enabled });
      expect(response.body).not.toContain('support@example.test');
    } finally {
      await app.close();
    }
  });
});
