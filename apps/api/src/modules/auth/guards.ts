import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { forbidden, unauthorized } from '../../lib/errors';
import { SESSION_COOKIE, verifySession, type SessionUser } from './session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function makeGuards(deps: AppDeps) {
  async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = req.cookies[SESSION_COOKIE];
    const session = token ? await verifySession(token, deps.config.appSecret) : null;
    if (!session) throw unauthorized();
    // Роль, блокировка и версия сессий берутся из БД: изменения применяются сразу, без перевыпуска cookie.
    const [row] = await deps.db.select().from(users).where(eq(users.id, session.id));
    if (!row || row.blocked || row.sessionVersion !== session.sv) throw unauthorized();
    req.user = { id: row.id, login: row.login, role: row.role };
  }

  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireUser(req, reply);
    if (req.user!.role !== 'admin') throw forbidden();
  }

  return { requireUser, requireAdmin };
}

export type Guards = ReturnType<typeof makeGuards>;
