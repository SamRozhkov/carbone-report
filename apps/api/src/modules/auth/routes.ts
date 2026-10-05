import { LoginBody } from '@carbone-reports/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../../app';
import { users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { currentUser, type Guards } from './guards';
import { DUMMY_HASH_PROMISE, verifyPassword } from './password';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, type SessionUser } from './session';

export async function setSessionCookie(
  reply: FastifyReply,
  deps: AppDeps,
  user: SessionUser,
  sv: number,
): Promise<void> {
  reply.setCookie(SESSION_COOKIE, await signSession(user, sv, deps.config.appSecret), {
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.config.cookieSecure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function registerAuthRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const loginRateLimit = {
    max: 10,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    // Ключ — логин, а не IP: за nginx все запросы приходят с одного адреса.
    keyGenerator: (req: FastifyRequest) =>
      String((req.body as { login?: unknown } | undefined)?.login ?? '')
        .trim()
        .toLowerCase(),
    errorResponseBuilder: () =>
      new AppError('TOO_MANY_ATTEMPTS', 429, 'слишком много попыток входа, повторите через минуту'),
  };

  app.post(
    '/api/auth/login',
    { schema: { body: LoginBody }, config: { rateLimit: loginRateLimit } },
    async (req, reply) => {
      const [row] = await deps.db.select().from(users).where(eq(users.login, req.body.login));
      const ok = await verifyPassword(
        row?.passwordHash ?? (await DUMMY_HASH_PROMISE),
        req.body.password,
      );
      if (!row || !ok || row.blocked) {
        throw new AppError('INVALID_CREDENTIALS', 401, 'неверный логин или пароль');
      }
      const user = { id: row.id, login: row.login, role: row.role };
      await setSessionCookie(reply, deps, user, row.sessionVersion);
      return user;
    },
  );

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.post('/api/auth/logout-all', { preHandler: guards.requireUser }, async (req, reply) => {
    await deps.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, currentUser(req).id));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: guards.requireUser }, async (req) => currentUser(req));
}
