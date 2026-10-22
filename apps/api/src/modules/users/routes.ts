import { CreateUserBody, IdParams, UpdateUserBody, type UserDto } from '@carbone-reports/shared';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import type { App } from '../../app';
import { reportRuns, userCertificates, userGroups, users, type UserRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { isUniqueViolation } from '../../lib/db-errors';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import { hashPassword } from '../auth/password';
import { setSessionCookie } from '../auth/routes';
import { loadUserCertificate } from '../signature/certificates';
import { runStoragePath } from '../reports/snapshot';

export const toUserDto = (
  r: UserRow,
  groupIds: string[] = [],
  certificateNotAfter: Date | null = null,
): UserDto => ({
  id: r.id,
  login: r.login,
  role: r.role,
  blocked: r.blocked,
  groupIds,
  createdAt: r.createdAt.toISOString(),
  certificateNotAfter: certificateNotAfter?.toISOString() ?? null,
});

const userGroupIds = async (deps: AppDeps, userId: string) =>
  (
    await deps.db
      .select({ id: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, userId))
  )
    .map((r) => r.id)
    .sort();

export function registerUserRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const pre = { preHandler: guards.requireAdmin };

  app.get('/api/users', pre, async () => {
    const rows = await deps.db.select().from(users).orderBy(asc(users.login));
    const links = await deps.db.select().from(userGroups);
    const byUser = new Map<string, string[]>();
    for (const l of links) byUser.set(l.userId, [...(byUser.get(l.userId) ?? []), l.groupId]);
    const certs = await deps.db
      .select({ userId: userCertificates.userId, notAfter: userCertificates.notAfter })
      .from(userCertificates);
    const notAfter = new Map(certs.map((c) => [c.userId, c.notAfter]));
    return rows.map((r) => toUserDto(r, byUser.get(r.id)?.sort(), notAfter.get(r.id) ?? null));
  });

  app.post('/api/users', { ...pre, schema: { body: CreateUserBody } }, async (req, reply) => {
    try {
      const [row] = await deps.db
        .insert(users)
        .values({
          login: req.body.login,
          role: req.body.role,
          passwordHash: await hashPassword(req.body.password),
        })
        .returning();
      return reply.status(201).send(toUserDto(row!));
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('user.loginTaken');
      throw e;
    }
  });

  app.patch(
    '/api/users/:id',
    { ...pre, schema: { params: IdParams, body: UpdateUserBody } },
    async (req, reply) => {
      const me = currentUser(req);
      const { password, role, blocked } = req.body;
      // Своя роль — только admin: иначе админ (в том числе последний) лишится доступа к админке.
      if (
        req.params.id === me.id &&
        (blocked === true || (role !== undefined && role !== 'admin'))
      ) {
        throw badRequest('user.cannotDemoteSelf');
      }
      const patch: Partial<UserRow> = {};
      if (password !== undefined) patch.passwordHash = await hashPassword(password);
      if (role !== undefined) patch.role = role;
      if (blocked !== undefined) patch.blocked = blocked;
      if (Object.keys(patch).length === 0) throw badRequest('noChanges');
      // Смена пароля, роли или блокировка завершает все выданные сессии пользователя.
      const revoke = password !== undefined || role !== undefined || blocked !== undefined;
      const isSelf = req.params.id === me.id;
      // Своя запись: обновляем, только если версия сессии не менялась с момента проверки в guard.
      const [row] = await deps.db
        .update(users)
        .set(revoke ? { ...patch, sessionVersion: sql`${users.sessionVersion} + 1` } : patch)
        .where(
          isSelf
            ? and(eq(users.id, req.params.id), eq(users.sessionVersion, req.sessionVersion!))
            : eq(users.id, req.params.id),
        )
        .returning();
      if (!row) throw isSelf ? unauthorized() : notFound('user');
      // Своя запись: текущая вкладка продолжает работать с новой cookie.
      if (revoke && row.id === me.id) {
        await setSessionCookie(
          reply,
          deps,
          { id: row.id, login: row.login, role: row.role },
          row.sessionVersion,
          // Сессия Keycloak сохраняется: иначе back-channel и OIDC logout её уже не завершат.
          req.oidcSessionId,
        );
      }
      return toUserDto(
        row,
        await userGroupIds(deps, row.id),
        (await loadUserCertificate(deps.db, row.id))?.notAfter ?? null,
      );
    },
  );

  app.post(
    '/api/users/:id/sessions/revoke',
    { ...pre, schema: { params: IdParams } },
    async (req, reply) => {
      if (req.params.id === currentUser(req).id) {
        throw badRequest('user.cannotEndOwnSessions');
      }
      const [row] = await deps.db
        .update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
        .where(eq(users.id, req.params.id))
        .returning({ id: users.id });
      if (!row) throw notFound('user');
      return reply.status(204).send();
    },
  );

  app.delete('/api/users/:id', { ...pre, schema: { params: IdParams } }, async (req, reply) => {
    if (req.params.id === currentUser(req).id) throw badRequest('user.cannotDeleteSelf');
    // Запуски удаляются каскадом, поэтому пути файлов нужно собрать до удаления пользователя.
    const runs = await deps.db
      .select({ id: reportRuns.id, filePath: reportRuns.filePath, snapshot: reportRuns.snapshot })
      .from(reportRuns)
      .where(
        and(
          eq(reportRuns.userId, req.params.id),
          isNotNull(reportRuns.filePath),
          eq(reportRuns.fileDeleted, false),
        ),
      );
    const [row] = await deps.db.delete(users).where(eq(users.id, req.params.id)).returning();
    if (!row) throw notFound('user');
    for (const r of runs) {
      // Снимок — каталог reports/<runId>/ целиком (§24.5), старый запуск — его файл.
      const path = runStoragePath(r)!;
      await deps.storage
        .remove(path)
        .catch((err) => req.log.warn({ err, filePath: path }, 'не удалось удалить файл отчёта'));
    }
    return reply.status(204).send();
  });
}
