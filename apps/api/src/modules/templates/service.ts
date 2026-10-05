import {
  outputFormatsFor,
  type TemplateAdminDetails,
  type TemplateCategoryRef,
  type TemplateDetails,
  type TemplateExt,
  type TemplateParam,
  type TemplateParamDto,
  type TemplateQuery,
  type TemplateSummary,
} from '@carbone-reports/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  categories,
  templateParams,
  templateQueries,
  templates,
  type TemplateRow,
} from '../../db/schema';
import type { AppDeps, TemplateFileRef } from '../../deps';
import { notFound } from '../../lib/errors';
import { paramRefs } from '../queries/param-deps';
import type { Storage } from '../../lib/storage';
import { STORAGE_REMOVE_LOCK_KEY } from '../../lib/storage-gate';

export interface TemplateFull {
  row: TemplateRow;
  category: TemplateCategoryRef | null;
  queries: TemplateQuery[];
  params: TemplateParam[];
}

export const templateDir = (id: string) => `templates/${id}`;
/** Каждая версия — отдельный файл: строка переключается на него атомарно в транзакции. */
export const templateFilePath = (id: string, ext: TemplateExt, version: number) =>
  `${templateDir(id)}/v${version}.${ext}`;

/**
 * Убирает файл версии, которую не удалось зафиксировать. Под блокировкой строки и только если строка
 * на него не ссылается: коммит мог пройти, несмотря на ошибку (обрыв соединения), или тот же путь
 * успел записать и зафиксировать следующий писатель.
 */
export async function discardUncommittedFile(
  deps: { db: Db; storage: Storage },
  id: string,
  path: string,
  log?: { warn: (msg: string) => void },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ filePath: templates.filePath })
      .from(templates)
      .where(eq(templates.id, id))
      .for('update');
    if (row?.filePath === path) return;
    // Под блокировкой строки не ждём бэкап: сирота безвреден, блокировка строки — нет.
    // Блокировка берётся на соединении самой транзакции (без пула шлюза) и снимается при её конце.
    const { rows } = await tx.execute(
      sql`select pg_try_advisory_xact_lock_shared(${STORAGE_REMOVE_LOCK_KEY}) as ok`,
    );
    if ((rows[0] as { ok: boolean }).ok !== true) {
      log?.warn(`идёт бэкап — файл-сирота оставлен: ${path}`);
      return;
    }
    await deps.storage.removeUngated(path);
  });
}

export async function loadTemplate(db: Db, id: string): Promise<TemplateRow> {
  const [row] = await db.select().from(templates).where(eq(templates.id, id));
  if (!row) throw notFound('шаблон');
  return row;
}

export async function loadTemplateFull(db: Db, id: string): Promise<TemplateFull> {
  const row = await loadTemplate(db, id);
  const [qs, ps, cat] = await Promise.all([
    db
      .select()
      .from(templateQueries)
      .where(eq(templateQueries.templateId, id))
      .orderBy(asc(templateQueries.sortOrder)),
    db
      .select()
      .from(templateParams)
      .where(eq(templateParams.templateId, id))
      .orderBy(asc(templateParams.sortOrder)),
    loadCategoryRef(db, row.categoryId),
  ]);
  return {
    row,
    category: cat,
    queries: qs.map((q) => ({ key: q.key, sql: q.sql, mode: q.mode })),
    params: ps.map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      required: p.required,
      defaultValue: p.defaultValue ?? null,
      options: p.options ?? null,
      sql: p.sql,
      multiple: p.multiple,
    })),
  };
}

export const categoryRefColumns = {
  id: categories.id,
  name: categories.name,
  sortOrder: categories.sortOrder,
};

export async function loadCategoryRef(
  db: Db,
  categoryId: string | null,
): Promise<TemplateCategoryRef | null> {
  if (!categoryId) return null;
  const [cat] = await db
    .select(categoryRefColumns)
    .from(categories)
    .where(eq(categories.id, categoryId));
  return cat ?? null;
}

export const toSummary = (
  r: TemplateRow,
  category: TemplateCategoryRef | null,
): TemplateSummary => ({
  id: r.id,
  name: r.name,
  description: r.description,
  fileExt: r.fileExt,
  defaultOutput: r.defaultOutput,
  updatedAt: r.updatedAt.toISOString(),
  category,
});

function toParamDto(p: TemplateParam, withSql: boolean): TemplateParamDto {
  return { ...p, sql: withSql ? p.sql : null, dependsOn: paramRefs(p) };
}

/** Карточка для пользователя: SQL параметров скрыт, зависимости (dependsOn) — нет. */
export const toDetails = (f: TemplateFull, withSql = false): TemplateDetails => ({
  ...toSummary(f.row, f.category),
  params: f.params.map((p) => toParamDto(p, withSql)),
  outputFormats: outputFormatsFor(f.row.fileExt),
});

export const toAdminDetails = (f: TemplateFull): TemplateAdminDetails => ({
  ...toDetails(f, true),
  datasourceId: f.row.datasourceId,
  version: f.row.version,
  queries: f.queries,
  lastSaveError: f.row.lastSaveError,
});

export function templateFileRef(deps: AppDeps, row: TemplateRow): TemplateFileRef {
  return {
    id: row.id,
    version: row.version,
    ext: row.fileExt,
    read: async () => {
      try {
        return await deps.storage.read(row.filePath);
      } catch (e) {
        // Пока шли запросы, сохранили новую версию и удалили прежний файл — берём актуальный.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        return deps.storage.read((await loadTemplate(deps.db, row.id)).filePath);
      }
    },
  };
}
