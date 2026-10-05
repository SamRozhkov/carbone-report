import {
  CategoryBody,
  GroupBody,
  GroupIdsBody,
  IdParams,
  MembersBody,
  TemplateAccess,
  type CategoryDto,
  type GroupDto,
} from '@carbone-reports/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { App } from '../../app';
import type { Db } from '../../db/client';
import {
  categories,
  categoryGroups,
  groups,
  templateGroups,
  templates,
  userGroups,
  users,
  type CategoryRow,
  type GroupRow,
} from '../../db/schema';
import type { AppDeps } from '../../deps';
import { isUniqueViolation } from '../../lib/db-errors';
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { Guards } from '../auth/guards';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const unique = (ids: string[]) => [...new Set(ids)];

/** Все id должны существовать: одним запросом, иначе 400 с текстом. */
async function assertAllExist(
  db: Db | Tx,
  table: typeof users | typeof groups | typeof categories,
  ids: string[],
  message: string,
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.select({ id: table.id }).from(table).where(inArray(table.id, ids));
  if (rows.length !== ids.length) throw badRequest(message);
}

const toGroupDto = (r: GroupRow, memberIds: string[]): GroupDto => ({
  id: r.id,
  name: r.name,
  description: r.description,
  memberIds,
  createdAt: r.createdAt.toISOString(),
});

const toCategoryDto = (r: CategoryRow, groupIds: string[], templateCount: number): CategoryDto => ({
  id: r.id,
  name: r.name,
  sortOrder: r.sortOrder,
  public: r.public,
  groupIds,
  templateCount,
});

export function registerAccessRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const { db } = deps;
  const pre = { preHandler: guards.requireAdmin };

  const memberIdsOf = async (groupId: string) =>
    (
      await db
        .select({ id: userGroups.userId })
        .from(userGroups)
        .where(eq(userGroups.groupId, groupId))
    ).map((r) => r.id);

  const groupDto = async (id: string): Promise<GroupDto> => {
    const [row] = await db.select().from(groups).where(eq(groups.id, id));
    if (!row) throw notFound('группа');
    return toGroupDto(row, await memberIdsOf(id));
  };

  const categoryDto = async (id: string): Promise<CategoryDto> => {
    const [row] = await db.select().from(categories).where(eq(categories.id, id));
    if (!row) throw notFound('категория');
    const gs = await db
      .select({ id: categoryGroups.groupId })
      .from(categoryGroups)
      .where(eq(categoryGroups.categoryId, id));
    const [cnt] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(templates)
      .where(eq(templates.categoryId, id));
    return toCategoryDto(
      row,
      gs.map((g) => g.id),
      cnt?.n ?? 0,
    );
  };

  // ---- группы ----

  app.get('/api/groups', pre, async () => {
    const rows = await db
      .select()
      .from(groups)
      .orderBy(asc(sql`lower(${groups.name})`), asc(groups.id));
    const links = await db.select().from(userGroups);
    const byGroup = new Map<string, string[]>();
    for (const l of links) byGroup.set(l.groupId, [...(byGroup.get(l.groupId) ?? []), l.userId]);
    return rows.map((r) => toGroupDto(r, byGroup.get(r.id) ?? []));
  });

  app.post('/api/groups', { ...pre, schema: { body: GroupBody } }, async (req, reply) => {
    try {
      const [row] = await db.insert(groups).values(req.body).returning();
      return reply.status(201).send(toGroupDto(row!, []));
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('группа с таким названием уже существует');
      throw e;
    }
  });

  app.patch(
    '/api/groups/:id',
    { ...pre, schema: { params: IdParams, body: GroupBody } },
    async (req) => {
      try {
        const [row] = await db
          .update(groups)
          .set(req.body)
          .where(eq(groups.id, req.params.id))
          .returning();
        if (!row) throw notFound('группа');
        return toGroupDto(row, await memberIdsOf(row.id));
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('группа с таким названием уже существует');
        throw e;
      }
    },
  );

  app.delete('/api/groups/:id', { ...pre, schema: { params: IdParams } }, async (req, reply) => {
    const [row] = await db
      .delete(groups)
      .where(eq(groups.id, req.params.id))
      .returning({ id: groups.id });
    if (!row) throw notFound('группа');
    return reply.status(204).send();
  });

  app.put(
    '/api/groups/:id/members',
    { ...pre, schema: { params: IdParams, body: MembersBody } },
    async (req) => {
      const userIds = unique(req.body.userIds);
      await db.transaction(async (tx) => {
        const [g] = await tx
          .select({ id: groups.id })
          .from(groups)
          .where(eq(groups.id, req.params.id))
          .for('update');
        if (!g) throw notFound('группа');
        await assertAllExist(tx, users, userIds, 'неизвестный пользователь');
        await tx.delete(userGroups).where(eq(userGroups.groupId, req.params.id));
        if (userIds.length > 0) {
          await tx
            .insert(userGroups)
            .values(userIds.map((userId) => ({ userId, groupId: req.params.id })));
        }
      });
      return groupDto(req.params.id);
    },
  );

  // ---- категории ----

  app.get('/api/categories', pre, async () => {
    const rows = await db
      .select()
      .from(categories)
      .orderBy(asc(categories.sortOrder), asc(sql`lower(${categories.name})`), asc(categories.id));
    const links = await db.select().from(categoryGroups);
    const byCat = new Map<string, string[]>();
    for (const l of links) byCat.set(l.categoryId, [...(byCat.get(l.categoryId) ?? []), l.groupId]);
    const counts = await db
      .select({ id: templates.categoryId, n: sql<number>`count(*)::int` })
      .from(templates)
      .groupBy(templates.categoryId);
    const countOf = new Map(counts.map((c) => [c.id, c.n]));
    return rows.map((r) => toCategoryDto(r, byCat.get(r.id) ?? [], countOf.get(r.id) ?? 0));
  });

  app.post('/api/categories', { ...pre, schema: { body: CategoryBody } }, async (req, reply) => {
    try {
      const [row] = await db.insert(categories).values(req.body).returning();
      return reply.status(201).send(toCategoryDto(row!, [], 0));
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('категория с таким названием уже существует');
      throw e;
    }
  });

  app.patch(
    '/api/categories/:id',
    { ...pre, schema: { params: IdParams, body: CategoryBody } },
    async (req) => {
      try {
        const [row] = await db
          .update(categories)
          .set(req.body)
          .where(eq(categories.id, req.params.id))
          .returning({ id: categories.id });
        if (!row) throw notFound('категория');
        return categoryDto(row.id);
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('категория с таким названием уже существует');
        throw e;
      }
    },
  );

  app.delete(
    '/api/categories/:id',
    { ...pre, schema: { params: IdParams } },
    async (req, reply) => {
      // templates.category_id и category_groups освобождаются внешними ключами (set null / cascade).
      const [row] = await db
        .delete(categories)
        .where(eq(categories.id, req.params.id))
        .returning({ id: categories.id });
      if (!row) throw notFound('категория');
      return reply.status(204).send();
    },
  );

  app.put(
    '/api/categories/:id/groups',
    { ...pre, schema: { params: IdParams, body: GroupIdsBody } },
    async (req) => {
      const groupIds = unique(req.body.groupIds);
      await db.transaction(async (tx) => {
        const [c] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.id, req.params.id))
          .for('update');
        if (!c) throw notFound('категория');
        await assertAllExist(tx, groups, groupIds, 'неизвестная группа');
        await tx.delete(categoryGroups).where(eq(categoryGroups.categoryId, req.params.id));
        if (groupIds.length > 0) {
          await tx
            .insert(categoryGroups)
            .values(groupIds.map((groupId) => ({ categoryId: req.params.id, groupId })));
        }
      });
      return categoryDto(req.params.id);
    },
  );

  // ---- доступ к шаблону ----

  const accessOf = async (templateId: string): Promise<TemplateAccess> => {
    const [t] = await db
      .select({ public: templates.public, categoryId: templates.categoryId })
      .from(templates)
      .where(eq(templates.id, templateId));
    if (!t) throw notFound('шаблон');
    const gs = await db
      .select({ id: templateGroups.groupId })
      .from(templateGroups)
      .where(eq(templateGroups.templateId, templateId));
    return { public: t.public, categoryId: t.categoryId, groupIds: gs.map((g) => g.id) };
  };

  app.get('/api/templates/:id/access', { ...pre, schema: { params: IdParams } }, (req) =>
    accessOf(req.params.id),
  );

  app.put(
    '/api/templates/:id/access',
    { ...pre, schema: { params: IdParams, body: TemplateAccess } },
    async (req) => {
      const { public: isPublic, categoryId } = req.body;
      const groupIds = unique(req.body.groupIds);
      await db.transaction(async (tx) => {
        const [t] = await tx
          .select({ id: templates.id })
          .from(templates)
          .where(eq(templates.id, req.params.id))
          .for('update');
        if (!t) throw notFound('шаблон');
        if (categoryId) await assertAllExist(tx, categories, [categoryId], 'неизвестная категория');
        await assertAllExist(tx, groups, groupIds, 'неизвестная группа');
        await tx
          .update(templates)
          .set({ public: isPublic, categoryId })
          .where(eq(templates.id, req.params.id));
        await tx.delete(templateGroups).where(eq(templateGroups.templateId, req.params.id));
        if (groupIds.length > 0) {
          await tx
            .insert(templateGroups)
            .values(groupIds.map((groupId) => ({ templateId: req.params.id, groupId })));
        }
      });
      return accessOf(req.params.id);
    },
  );

  // ---- группы пользователя ----

  const userGroupIds = async (userId: string) =>
    (
      await db
        .select({ id: userGroups.groupId })
        .from(userGroups)
        .where(eq(userGroups.userId, userId))
    ).map((r) => r.id);

  const assertUser = async (id: string) => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (!u) throw notFound('пользователь');
  };

  app.get('/api/users/:id/groups', { ...pre, schema: { params: IdParams } }, async (req) => {
    await assertUser(req.params.id);
    return userGroupIds(req.params.id);
  });

  app.put(
    '/api/users/:id/groups',
    { ...pre, schema: { params: IdParams, body: GroupIdsBody } },
    async (req) => {
      const groupIds = unique(req.body.groupIds);
      await db.transaction(async (tx) => {
        const [u] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, req.params.id))
          .for('update');
        if (!u) throw notFound('пользователь');
        await assertAllExist(tx, groups, groupIds, 'неизвестная группа');
        await tx.delete(userGroups).where(eq(userGroups.userId, req.params.id));
        if (groupIds.length > 0) {
          await tx
            .insert(userGroups)
            .values(groupIds.map((groupId) => ({ userId: req.params.id, groupId })));
        }
      });
      return userGroupIds(req.params.id);
    },
  );
}
