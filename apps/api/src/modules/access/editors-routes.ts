import {
  IdParams,
  Role,
  TemplateEditorsBody,
  TemplateOwnerBody,
  type TemplateEditors,
  type UserDirectoryEntry,
} from '@carbone-reports/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { App } from '../../app';
import type { Db } from '../../db/client';
import { templateEditors, templates, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import { ACCESS_ROLES, deleteRight, NO_EDIT_RIGHT } from './permissions';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const USER_NOT_FOUND = 'notFound.user';

const DirectoryQuery = z.object({ role: Role.optional() });

async function editorsOf(db: Db | Tx, templateId: string): Promise<TemplateEditors> {
  const [t] = await db
    .select({ ownerId: templates.ownerId })
    .from(templates)
    .where(eq(templates.id, templateId));
  if (!t) throw notFound('template');
  const rows = await db
    .select({ id: templateEditors.userId })
    .from(templateEditors)
    .where(eq(templateEditors.templateId, templateId));
  return { ownerId: t.ownerId, userIds: rows.map((r) => r.id).sort() };
}

/** Строка шаблона под блокировкой до конца транзакции; нет — 404. */
async function lockTemplate(tx: Tx, id: string): Promise<{ ownerId: string | null }> {
  const [t] = await tx
    .select({ ownerId: templates.ownerId })
    .from(templates)
    .where(eq(templates.id, id))
    .for('update');
  if (!t) throw notFound('template');
  return t;
}

/** Пользователи по id; FOR KEY SHARE — параллельное удаление ждёт конца транзакции. */
const loadUsers = (tx: Tx, ids: string[]) =>
  ids.length === 0
    ? Promise.resolve([])
    : tx
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(inArray(users.id, ids))
        .orderBy(asc(users.id))
        .for('key share');

/** Редакторы и владелец шаблона, справочник пользователей (§43.1, §43.3). */
export function registerTemplateEditorRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const { db } = deps;

  app.get(
    '/api/templates/:id/editors',
    { preHandler: guards.requireTemplateOwner, schema: { params: IdParams } },
    (req) => editorsOf(db, req.params.id),
  );

  // Список редакторов — не изменение шаблона (§33): updated_at и updated_by не трогаем.
  app.put(
    '/api/templates/:id/editors',
    {
      preHandler: guards.requireTemplateOwner,
      schema: { params: IdParams, body: TemplateEditorsBody },
    },
    async (req) => {
      const id = req.params.id;
      const userIds = [...new Set(req.body.userIds)];
      return db.transaction(async (tx) => {
        const t = await lockTemplate(tx, id);
        // Владельца мог сменить админ, пока запрос ждал блокировку: право проверяется ещё раз под ней.
        if (!deleteRight(currentUser(req), t)) throw forbidden(NO_EDIT_RIGHT);
        const current = new Set((await editorsOf(tx, id)).userIds);
        const found = await loadUsers(tx, userIds);
        if (found.length !== userIds.length) throw badRequest(USER_NOT_FOUND);
        // Роль проверяется только у добавляемых: записи понижённых остаются, но не действуют (§43.1).
        if (found.some((u) => !current.has(u.id) && u.role !== 'editor'))
          throw badRequest('access.grantEditorOnly');
        if (t.ownerId && userIds.includes(t.ownerId)) throw badRequest('access.ownerAlreadyEditor');
        await tx.delete(templateEditors).where(eq(templateEditors.templateId, id));
        if (userIds.length > 0) {
          await tx
            .insert(templateEditors)
            .values(userIds.map((userId) => ({ templateId: id, userId })));
        }
        return editorsOf(tx, id);
      });
    },
  );

  // Прежний владелец в редакторы не попадает; новый выходит из списка редакторов (§43.1).
  app.put(
    '/api/templates/:id/owner',
    {
      preHandler: guards.requireAdmin,
      schema: { params: IdParams, body: TemplateOwnerBody },
    },
    async (req) => {
      const id = req.params.id;
      const { userId } = req.body;
      return db.transaction(async (tx) => {
        await lockTemplate(tx, id);
        const [u] = await loadUsers(tx, [userId]);
        if (!u) throw badRequest(USER_NOT_FOUND);
        if (u.role !== 'editor') throw badRequest('access.ownerEditorOnly');
        await tx.update(templates).set({ ownerId: userId }).where(eq(templates.id, id));
        await tx
          .delete(templateEditors)
          .where(and(eq(templateEditors.templateId, id), eq(templateEditors.userId, userId)));
        return editorsOf(tx, id);
      });
    },
  );

  app.get(
    '/api/users/directory',
    {
      preHandler: guards.requireRole(...ACCESS_ROLES, 'editor'),
      schema: { querystring: DirectoryQuery },
    },
    async (req): Promise<UserDirectoryEntry[]> =>
      db
        .select({ id: users.id, login: users.login, role: users.role })
        .from(users)
        .where(
          and(
            eq(users.blocked, false),
            req.query.role ? eq(users.role, req.query.role) : undefined,
          ),
        )
        .orderBy(asc(sql`lower(${users.login})`), asc(users.id)),
  );
}
