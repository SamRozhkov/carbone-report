import {
  outputFormatsFor,
  type TemplateAdminDetails,
  type TemplateDetails,
  type TemplateExt,
  type TemplateParam,
  type TemplateQuery,
  type TemplateSummary,
} from '@carbone-reports/shared';
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { templateParams, templateQueries, templates, type TemplateRow } from '../../db/schema';
import type { AppDeps, TemplateFileRef } from '../../deps';
import { notFound } from '../../lib/errors';

export interface TemplateFull {
  row: TemplateRow;
  queries: TemplateQuery[];
  params: TemplateParam[];
}

export const templateFilePath = (id: string, ext: TemplateExt) => `templates/${id}.${ext}`;

export async function loadTemplate(db: Db, id: string): Promise<TemplateRow> {
  const [row] = await db.select().from(templates).where(eq(templates.id, id));
  if (!row) throw notFound('шаблон');
  return row;
}

export async function loadTemplateFull(db: Db, id: string): Promise<TemplateFull> {
  const row = await loadTemplate(db, id);
  const [qs, ps] = await Promise.all([
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
  ]);
  return {
    row,
    queries: qs.map((q) => ({ key: q.key, sql: q.sql, mode: q.mode })),
    params: ps.map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      required: p.required,
      defaultValue: p.defaultValue ?? null,
      options: p.options ?? null,
    })),
  };
}

export const toSummary = (r: TemplateRow): TemplateSummary => ({
  id: r.id,
  name: r.name,
  description: r.description,
  fileExt: r.fileExt,
  defaultOutput: r.defaultOutput,
  updatedAt: r.updatedAt.toISOString(),
});

export const toDetails = (f: TemplateFull): TemplateDetails => ({
  ...toSummary(f.row),
  params: f.params,
  outputFormats: outputFormatsFor(f.row.fileExt),
});

export const toAdminDetails = (f: TemplateFull): TemplateAdminDetails => ({
  ...toDetails(f),
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
    read: () => deps.storage.read(row.filePath),
  };
}
