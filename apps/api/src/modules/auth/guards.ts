import type { Role } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { oidcSessions, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { forbidden, unauthorized } from '../../lib/errors';
import { assertTemplateEdit, assertTemplateOwner, AUTHOR_ROLES } from '../access/permissions';
import { sessionCookieName, verifySession, type SessionUser } from './session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
    sessionVersion?: number;
    oidcSessionId?: string;
  }
}

export function currentUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function makeGuards(deps: AppDeps) {
  async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = req.cookies[sessionCookieName(deps.config.cookieSecure)];
    const session = token ? await verifySession(token, deps.config.appSecret) : null;
    if (!session) throw unauthorized();
    // Роль, блокировка и версия сессий берутся из БД: изменения применяются сразу, без перевыпуска cookie.
    const [row] = await deps.db.select().from(users).where(eq(users.id, session.id));
    if (!row || row.blocked || row.sessionVersion !== session.sv) throw unauthorized();
    if (session.oidcSessionId) {
      if (!deps.config.oidc) throw unauthorized();
      const [external] = await deps.db
        .select()
        .from(oidcSessions)
        .where(eq(oidcSessions.id, session.oidcSessionId));
      if (
        !external ||
        external.userId !== row.id ||
        external.revokedAt ||
        external.expiresAt.getTime() <= Date.now()
      )
        throw unauthorized();
      req.oidcSessionId = external.id;
    }
    req.sessionVersion = session.sv;
    req.user = { id: row.id, login: row.login, role: row.role };
  }

  /** preHandler: вход и одна из ролей; иначе 403 (§43.3). */
  const requireRole =
    (...roles: Role[]) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await requireUser(req, reply);
      if (!roles.includes(req.user!.role)) throw forbidden();
    };

  const requireAdmin = requireRole('admin');
  const requireAuthor = requireRole(...AUTHOR_ROLES);

  // preHandler выполняется после проверки params схемой маршрута: id уже UUID.
  const templateId = (req: FastifyRequest) => (req.params as { id: string }).id;

  /** Маршруты конструктора с :id — право правки шаблона (§43.1). */
  async function requireTemplateEdit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuthor(req, reply);
    await assertTemplateEdit(deps.db, req.user!, templateId(req));
  }

  /** Удаление шаблона и его редакторы — admin или владелец (§43.1). */
  async function requireTemplateOwner(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuthor(req, reply);
    await assertTemplateOwner(deps.db, req.user!, templateId(req));
  }

  return { requireUser, requireAdmin, requireRole, requireTemplateEdit, requireTemplateOwner };
}

export type Guards = ReturnType<typeof makeGuards>;
