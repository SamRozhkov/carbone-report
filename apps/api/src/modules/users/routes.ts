import { CreateUserBody, IdParams, UpdateUserBody, type UserDto } from '@carbone-reports/shared';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { App } from '../../app';
import { reportRuns, users, type UserRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import { hashPassword } from '../auth/password';

export const toUserDto = (r: UserRow): UserDto => ({
  id: r.id,
  login: r.login,
  role: r.role,
  blocked: r.blocked,
  createdAt: r.createdAt.toISOString(),
});

const isUniqueViolation = (e: unknown) =>
  (e as { code?: string })?.code === '23505' ||
  (e as { cause?: { code?: string } })?.cause?.code === '23505';

export function registerUserRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const pre = { preHandler: guards.requireAdmin };

  app.get('/api/users', pre, async () => {
    const rows = await deps.db.select().from(users).orderBy(asc(users.login));
    return rows.map(toUserDto);
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
      if (isUniqueViolation(e)) throw conflict('пользователь с таким логином уже существует');
      throw e;
    }
  });

  app.patch(
    '/api/users/:id',
    { ...pre, schema: { params: IdParams, body: UpdateUserBody } },
    async (req) => {
      const me = currentUser(req);
      const { password, role, blocked } = req.body;
      if (req.params.id === me.id && (blocked === true || role === 'user')) {
        throw badRequest('нельзя заблокировать или понизить собственную учётную запись');
      }
      const patch: Partial<UserRow> = {};
      if (password !== undefined) patch.passwordHash = await hashPassword(password);
      if (role !== undefined) patch.role = role;
      if (blocked !== undefined) patch.blocked = blocked;
      if (Object.keys(patch).length === 0) throw badRequest('нет изменений');
      const [row] = await deps.db
        .update(users)
        .set(patch)
        .where(eq(users.id, req.params.id))
        .returning();
      if (!row) throw notFound('пользователь');
      return toUserDto(row);
    },
  );

  app.delete('/api/users/:id', { ...pre, schema: { params: IdParams } }, async (req, reply) => {
    if (req.params.id === currentUser(req).id)
      throw badRequest('нельзя удалить собственную учётную запись');
    // Запуски удаляются каскадом, поэтому пути файлов нужно собрать до удаления пользователя.
    const files = await deps.db
      .select({ filePath: reportRuns.filePath })
      .from(reportRuns)
      .where(
        and(
          eq(reportRuns.userId, req.params.id),
          isNotNull(reportRuns.filePath),
          eq(reportRuns.fileDeleted, false),
        ),
      );
    const [row] = await deps.db.delete(users).where(eq(users.id, req.params.id)).returning();
    if (!row) throw notFound('пользователь');
    for (const f of files) {
      await deps.storage
        .remove(f.filePath!)
        .catch((err) =>
          req.log.warn({ err, filePath: f.filePath }, 'не удалось удалить файл отчёта'),
        );
    }
    return reply.status(204).send();
  });
}
