import { createHash } from 'node:crypto';
import {
  MAX_TRANSFER_ARCHIVE_BYTES,
  MAX_TRANSFER_UNPACKED_BYTES,
  TRANSFER_FILE_EXT,
  TRANSFER_FORMAT,
  TRANSFER_FORMAT_VERSION,
  TRANSFER_MANIFEST_FILE,
  transferFilePath,
  type TransferManifest,
  type TransferParam,
  type TransferQuery,
  type TransferTemplate,
} from '@carbone-reports/shared/template-transfer';
import { asc, eq, inArray } from 'drizzle-orm';
import JSZip from 'jszip';
import {
  categories,
  datasources,
  groups,
  templateGroups,
  templateParams,
  templateQueries,
  templates,
} from '../../../db/schema';
import type { AppDeps } from '../../../deps';
import { AppError, badRequest, notFound } from '../../../lib/errors';
import { templateFileRef } from '../service';

export type ExportDeps = Pick<AppDeps, 'db' | 'storage'> & {
  config: Pick<AppDeps['config'], 'appVersion' | 'tz'>;
};

export interface ExportResult {
  filename: string;
  buffer: Buffer;
}

/**
 * Имя файла архива из названия шаблона: недопустимые в файловых системах символы
 * (`\ / : * ? " < > |`, управляющие) и пробельные серии — в «_», точки и пробелы по краям
 * убираются, длина до 100 символов. Кириллица остаётся (Content-Disposition передаёт UTF-8).
 */
export function exportFileName(name: string): string {
  const safe = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 100)
    .replace(/[._]+$/g, '');
  return `${safe || 'template'}${TRANSFER_FILE_EXT}`;
}

/** Дата в часовом поясе приложения, YYYY-MM-DD. */
export function localDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export interface ArchiveItem {
  meta: Omit<TransferTemplate, 'file' | 'sha256'>;
  data: Buffer;
}

/** Собирает zip: manifest.json и templates/<n>/template.<ext>. Чистая функция, без обращений к БД. */
export async function buildArchive(
  items: ArchiveItem[],
  info: { appVersion: string; now: Date },
): Promise<Buffer> {
  const zip = new JSZip();
  const manifest: TransferManifest = {
    format: TRANSFER_FORMAT,
    formatVersion: TRANSFER_FORMAT_VERSION,
    appVersion: info.appVersion,
    exportedAt: info.now.toISOString(),
    templates: items.map((it, i) => ({
      ...it.meta,
      file: transferFilePath(i, it.meta.fileExt),
      sha256: createHash('sha256').update(it.data).digest('hex'),
    })),
  };
  zip.file(TRANSFER_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  manifest.templates.forEach((t, i) => zip.file(t.file, items[i]!.data, { createFolders: false }));
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/** Выгрузка шаблонов в архив (§33.1). Пароли, CA, идентификаторы, даты, авторы и история запусков не выгружаются. */
export async function buildExport(
  deps: ExportDeps,
  ids: string[],
  now: Date = new Date(),
): Promise<ExportResult> {
  const { db } = deps;
  const uniqueIds = [...new Set(ids)];
  const rows = await db
    .select({ row: templates, ds: datasources, category: categories.name })
    .from(templates)
    .innerJoin(datasources, eq(datasources.id, templates.datasourceId))
    .leftJoin(categories, eq(categories.id, templates.categoryId))
    .where(inArray(templates.id, uniqueIds));
  const byId = new Map(rows.map((r) => [r.row.id, r]));
  const missing = uniqueIds.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new AppError('NOT_FOUND', 404, notFound('шаблон').message, { ids: missing });
  }

  const [gs, qs, ps] = await Promise.all([
    db
      .select({ templateId: templateGroups.templateId, name: groups.name })
      .from(templateGroups)
      .innerJoin(groups, eq(groups.id, templateGroups.groupId))
      .where(inArray(templateGroups.templateId, uniqueIds))
      .orderBy(asc(groups.name)),
    db
      .select()
      .from(templateQueries)
      .where(inArray(templateQueries.templateId, uniqueIds))
      .orderBy(asc(templateQueries.sortOrder)),
    db
      .select()
      .from(templateParams)
      .where(inArray(templateParams.templateId, uniqueIds))
      .orderBy(asc(templateParams.sortOrder)),
  ]);

  const items: ArchiveItem[] = [];
  let total = 0;
  for (const id of uniqueIds) {
    const { row, ds, category } = byId.get(id)!;
    const data = await templateFileRef(deps as AppDeps, row).read();
    total += data.length;
    if (total > MAX_TRANSFER_UNPACKED_BYTES) {
      throw badRequest('файлы выбранных шаблонов больше 200 МБ — выгрузите их частями');
    }
    items.push({
      data,
      meta: {
        name: row.name,
        description: row.description,
        fileExt: row.fileExt,
        defaultOutput: row.defaultOutput,
        public: row.public,
        category,
        groups: gs.filter((g) => g.templateId === id).map((g) => g.name),
        datasource: {
          name: ds.name,
          host: ds.host,
          port: ds.port,
          database: ds.database,
          username: ds.username,
          sslMode: ds.sslMode,
        },
        queries: qs
          .filter((q) => q.templateId === id)
          .map((q): TransferQuery => ({
            key: q.key,
            sql: q.sql,
            mode: q.mode,
            sortOrder: q.sortOrder,
          })),
        params: ps
          .filter((p) => p.templateId === id)
          .map((p): TransferParam => ({
            name: p.name,
            label: p.label,
            type: p.type,
            required: p.required,
            defaultValue: p.defaultValue ?? null,
            options: p.options ?? null,
            sql: p.sql,
            multiple: p.multiple,
            sortOrder: p.sortOrder,
          })),
      },
    });
  }

  const buffer = await buildArchive(items, { appVersion: deps.config.appVersion, now });
  if (buffer.length > MAX_TRANSFER_ARCHIVE_BYTES) {
    throw badRequest('архив получается больше 50 МБ — выгрузите шаблоны частями');
  }
  const filename =
    items.length === 1
      ? exportFileName(items[0]!.meta.name)
      : `templates-${localDate(now, deps.config.tz)}${TRANSFER_FILE_EXT}`;
  return { filename, buffer };
}
