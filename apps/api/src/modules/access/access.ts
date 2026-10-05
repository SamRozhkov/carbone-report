import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { categories, categoryGroups, templateGroups, templates, userGroups } from '../../db/schema';
import { notFound } from '../../lib/errors';
import type { SessionUser } from '../auth/session';

/** exists() из drizzle не берёт сырой sql`` в скобки (получается `exists select …`). */
const existsSub = (subquery: SQL): SQL => sql`exists (${subquery})`;

/**
 * Единственное правило доступа к шаблону (§19.1). undefined — без ограничений (админ).
 * Колонки внутри sql`` drizzle выводит с именем таблицы ("templates"."id"): в подзапросах
 * templates не участвует, поэтому ссылки на неё связываются с внешним запросом.
 */
export function accessibleTemplates(user: SessionUser): SQL | undefined {
  if (user.role === 'admin') return undefined;
  return or(
    eq(templates.public, true),
    existsSub(
      sql`select 1 from ${categories} where ${categories.id} = ${templates.categoryId} and ${categories.public}`,
    ),
    existsSub(
      sql`select 1 from ${categoryGroups} join ${userGroups} on ${userGroups.groupId} = ${categoryGroups.groupId}
          where ${categoryGroups.categoryId} = ${templates.categoryId} and ${userGroups.userId} = ${user.id}`,
    ),
    existsSub(
      sql`select 1 from ${templateGroups} join ${userGroups} on ${userGroups.groupId} = ${templateGroups.groupId}
          where ${templateGroups.templateId} = ${templates.id} and ${userGroups.userId} = ${user.id}`,
    ),
  );
}

/** Недоступный шаблон для пользователя неотличим от несуществующего. */
export async function assertTemplateAccess(
  db: Db,
  user: SessionUser,
  templateId: string,
): Promise<void> {
  if (user.role === 'admin') return;
  const [row] = await db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.id, templateId), accessibleTemplates(user)));
  if (!row) throw notFound('шаблон');
}
