import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { templateEditors, templates } from '../../db/schema';
import { forbidden, notFound } from '../../lib/errors';
import type { SessionUser } from '../auth/session';
import { assertTemplateAccess, existsSub } from './access';

/** Роли, которые создают и правят шаблоны (§43.2). */
export const AUTHOR_ROLES = ['admin', 'editor'] as const;
/** Роли, которые ведут доступ к шаблонам, группы и категории (§43.2). */
export const ACCESS_ROLES = ['admin', 'access_manager'] as const;

export const NO_EDIT_RIGHT = 'access.noEditRight';

/** Чистое правило §43.1: роль + владелец + список редакторов. */
export function editRight(
  user: SessionUser,
  t: { ownerId: string | null },
  isGranted: boolean,
): boolean {
  if (user.role === 'admin') return true;
  return user.role === 'editor' && (t.ownerId === user.id || isGranted);
}

/** Удалить шаблон и вести его редакторов: admin или владелец с ролью editor. */
export function deleteRight(user: SessionUser, t: { ownerId: string | null }): boolean {
  return user.role === 'admin' || (user.role === 'editor' && t.ownerId === user.id);
}

/** Права текущего пользователя для DTO конструктора. */
export function templateRights(
  user: SessionUser,
  t: { ownerId: string | null },
): { canDelete: boolean; canManageEditors: boolean } {
  const owner = deleteRight(user, t);
  return { canDelete: owner, canManageEditors: owner };
}

/**
 * Условие на шаблоны, которые пользователь может править (editRight в SQL).
 * undefined — без ограничений (админ); роли без права правки — ни одного шаблона.
 */
export function editableTemplates(user: SessionUser): SQL | undefined {
  if (user.role === 'admin') return undefined;
  if (user.role !== 'editor') return sql`false`;
  return or(
    eq(templates.ownerId, user.id),
    existsSub(
      sql`select 1 from ${templateEditors} where ${templateEditors.templateId} = ${templates.id} and ${templateEditors.userId} = ${user.id}`,
    ),
  );
}

/** Шаблон существует и пользователь может его править. */
export async function canEditTemplate(db: Db, user: SessionUser, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.id, id), editableTemplates(user)));
  return Boolean(row);
}

/** Нет шаблона или не виден ни для правки, ни по §19 — 404; виден по §19 — 403 «нет права на правку шаблона». */
export async function assertTemplateEdit(db: Db, user: SessionUser, id: string): Promise<void> {
  if (await canEditTemplate(db, user, id)) return;
  // Админ правит любой шаблон: отказ означает, что шаблона нет.
  if (user.role === 'admin') throw notFound('template');
  // Несуществующий и невидимый по §19 шаблон неотличимы: 404.
  await assertTemplateAccess(db, user, id);
  throw forbidden(NO_EDIT_RIGHT);
}

/** Удаление и редакторы: admin или владелец-editor; иначе — как assertTemplateEdit, затем 403. */
export async function assertTemplateOwner(db: Db, user: SessionUser, id: string): Promise<void> {
  await assertTemplateEdit(db, user, id);
  if (user.role === 'admin') return;
  const [row] = await db
    .select({ ownerId: templates.ownerId })
    .from(templates)
    .where(eq(templates.id, id));
  if (!row) throw notFound('template');
  if (!deleteRight(user, row)) throw forbidden(NO_EDIT_RIGHT);
}
