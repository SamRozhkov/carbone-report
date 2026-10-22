import { createHash } from 'node:crypto';
import {
  MAX_TRANSFER_ARCHIVE_BYTES,
  MAX_TRANSFER_MANIFEST_BYTES,
  TRANSFER_FILE_EXT,
  TRANSFER_FORMAT,
  TRANSFER_FORMAT_VERSION,
  TRANSFER_MANIFEST_FILE,
  transferAttachmentPath,
  transferFilePath,
  TransferManifest,
  type TransferAttachment,
  type TransferChart,
  type TransferParam,
  type TransferQuery,
  type TransferTemplate,
} from '@carbone-reports/shared/template-transfer';
import { PdfOptions } from '@carbone-reports/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import JSZip from 'jszip';
import {
  categories,
  datasources,
  groups,
  templateAttachments,
  templateCharts,
  templateGroups,
  templateParams,
  templateQueries,
  templates,
} from '../../../db/schema';
import type { AppDeps } from '../../../deps';
import { AppError, badRequest, issueText, localizedSafeParse, notFound } from '../../../lib/errors';
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
  // Зарезервированные имена Windows (CON, NUL, COM1…) получают префикс.
  const base = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe) ? `_${safe}` : safe;
  return `${base || 'template'}${TRANSFER_FILE_EXT}`;
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
  meta: Omit<TransferTemplate, 'file' | 'sha256' | 'attachments'> & {
    attachments?: Omit<TransferAttachment, 'file' | 'sha256'>[];
  };
  data: Buffer;
  /** Файлы приложений в порядке meta.attachments. */
  attachments?: Buffer[];
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
    templates: items.map(({ meta: { attachments, ...meta }, data, attachments: files }, i) => ({
      ...meta,
      ...(attachments
        ? {
            attachments: attachments.map((a, n) => ({
              ...a,
              file: transferAttachmentPath(i, n),
              sha256: createHash('sha256').update(files![n]!).digest('hex'),
            })),
          }
        : {}),
      file: transferFilePath(i, meta.fileExt),
      sha256: createHash('sha256').update(data).digest('hex'),
    })),
  };
  // Архив должен загрузиться: та же схема, что при загрузке (длина имени, правила параметров
  // и запросов могли ужесточиться после сохранения шаблона).
  // Сообщение issue входит в текст ошибки и переводится на язык запроса (§44.4).
  const checked = localizedSafeParse(TransferManifest, manifest);
  if (!checked.success) {
    const issue = checked.error.issues[0]!;
    const [first, index, ...rest] = issue.path;
    const name =
      first === 'templates' && typeof index === 'number' ? manifest.templates[index]?.name : null;
    const message = issueText(issue);
    if (name === null || name === undefined) throw badRequest('export.invalid', { message });
    throw rest.length
      ? badRequest('export.templateInvalidPath', { name, path: rest.join('.'), message })
      : badRequest('export.templateInvalid', { name, message });
  }
  const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2));
  if (manifestJson.length > MAX_TRANSFER_MANIFEST_BYTES) {
    throw badRequest('export.manifestTooLarge', {
      file: TRANSFER_MANIFEST_FILE,
      size: MAX_TRANSFER_MANIFEST_BYTES / 1024 / 1024,
    });
  }
  zip.file(TRANSFER_MANIFEST_FILE, manifestJson);
  manifest.templates.forEach((t, i) =>
    zip.file(t.file, items[i]!.data, { createFolders: false, compression: 'STORE' }),
  );
  manifest.templates.forEach((t, i) =>
    (t.attachments ?? []).forEach((a, n) =>
      zip.file(a.file, items[i]!.attachments![n]!, { createFolders: false, compression: 'STORE' }),
    ),
  );
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/** Не более двух выгрузок одновременно на процесс: остальные ждут своей очереди (в памяти — до 50 МБ файлов и архив). */
export const MAX_CONCURRENT_EXPORTS = 2;
let activeExports = 0;
const exportQueue: Array<() => void> = [];

export async function withExportSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    await new Promise<void>((resolve) => exportQueue.push(resolve));
  } else {
    activeExports++;
  }
  try {
    return await fn();
  } finally {
    // Слот передаётся следующему в очереди без освобождения.
    const next = exportQueue.shift();
    if (next) next();
    else activeExports--;
  }
}

/** Выгрузка шаблонов в архив (§33.1). Пароли, CA, идентификаторы, даты, авторы и история запусков не выгружаются. */
export function buildExport(
  deps: ExportDeps,
  ids: string[],
  opts: ExportOptions,
): Promise<ExportResult> {
  return withExportSlot(() => runExport(deps, ids, opts));
}

export interface ExportOptions {
  /** Выгружать настройки подключения источника (хост, порт, база, пользователь, SSL) — только `admin` (§43.2). */
  withConnection: boolean;
  now?: Date;
}

async function runExport(
  deps: ExportDeps,
  ids: string[],
  { withConnection, now = new Date() }: ExportOptions,
): Promise<ExportResult> {
  const { db } = deps;
  const uniqueIds = [...new Set(ids.map((id) => id.toLowerCase()))];
  const rows = await db
    .select({ row: templates, ds: datasources, category: categories.name })
    .from(templates)
    .innerJoin(datasources, eq(datasources.id, templates.datasourceId))
    .leftJoin(categories, eq(categories.id, templates.categoryId))
    .where(inArray(templates.id, uniqueIds));
  const byId = new Map(rows.map((r) => [r.row.id, r]));
  const missing = uniqueIds.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new AppError('NOT_FOUND', 404, notFound('template').msg, { ids: missing });
  }

  const [gs, qs, ps, cs, as] = await Promise.all([
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
      .orderBy(asc(templateQueries.sortOrder), asc(templateQueries.key)),
    db
      .select()
      .from(templateParams)
      .where(inArray(templateParams.templateId, uniqueIds))
      .orderBy(asc(templateParams.sortOrder), asc(templateParams.name)),
    db
      .select()
      .from(templateCharts)
      .where(inArray(templateCharts.templateId, uniqueIds))
      .orderBy(asc(templateCharts.sortOrder), asc(templateCharts.key)),
    db
      .select()
      .from(templateAttachments)
      .where(inArray(templateAttachments.templateId, uniqueIds))
      .orderBy(asc(templateAttachments.sortOrder), asc(templateAttachments.createdAt)),
  ]);

  // Архив с одинаковыми названиями не загрузится (§33.2): сообщаем сразу.
  const seenNames = new Set<string>();
  for (const { row } of byId.values()) {
    const k = row.name.toLowerCase();
    if (seenNames.has(k)) throw badRequest('export.nameDuplicate', { name: row.name });
    seenNames.add(k);
  }

  const items: ArchiveItem[] = [];
  let total = 0;
  for (const id of uniqueIds) {
    const { row, ds, category } = byId.get(id)!;
    const data = await templateFileRef(deps as AppDeps, row).read();
    total += data.length;
    // Файлы кладутся без сжатия: если они одни не помещаются в архив, дальше не читаем.
    if (total > MAX_TRANSFER_ARCHIVE_BYTES) {
      throw badRequest('export.filesTooLarge', { size: MAX_TRANSFER_ARCHIVE_BYTES / 1024 / 1024 });
    }
    const rowsOf = as.filter((a) => a.templateId === id);
    const ordered = [
      ...rowsOf.filter((a) => a.placement === 'start'),
      ...rowsOf.filter((a) => a.placement === 'end'),
    ];
    const attachmentData: Buffer[] = [];
    for (const a of ordered) {
      const buf = await deps.storage.read(a.filePath);
      total += buf.length;
      if (total > MAX_TRANSFER_ARCHIVE_BYTES) {
        throw badRequest('export.filesTooLarge', {
          size: MAX_TRANSFER_ARCHIVE_BYTES / 1024 / 1024,
        });
      }
      attachmentData.push(buf);
    }

    items.push({
      data,
      attachments: attachmentData,
      meta: {
        name: row.name,
        description: row.description,
        fileExt: row.fileExt,
        defaultOutput: row.defaultOutput,
        public: row.public,
        category,
        groups: gs.filter((g) => g.templateId === id).map((g) => g.name),
        datasource: withConnection
          ? {
              name: ds.name,
              host: ds.host,
              port: ds.port,
              database: ds.database,
              username: ds.username,
              sslMode: ds.sslMode,
            }
          : { name: ds.name },
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
        charts: cs
          .filter((c) => c.templateId === id)
          .map((c): TransferChart => ({ key: c.key, sortOrder: c.sortOrder, config: c.config })),
        pdfOptions: PdfOptions.parse(row.pdfOptions),
        ...(row.pdfPasswordEnc !== null ? { pdfPasswordSet: true } : {}),
        attachments: ordered.map((a) => ({
          name: a.name,
          placement: a.placement,
          sortOrder: a.sortOrder,
          pdfa: a.pdfa,
        })),
      },
    });
  }

  const buffer = await buildArchive(items, { appVersion: deps.config.appVersion, now });
  if (buffer.length > MAX_TRANSFER_ARCHIVE_BYTES) {
    throw badRequest('export.archiveTooLarge', { size: MAX_TRANSFER_ARCHIVE_BYTES / 1024 / 1024 });
  }
  const filename =
    items.length === 1
      ? exportFileName(items[0]!.meta.name)
      : `templates-${localDate(now, deps.config.tz)}${TRANSFER_FILE_EXT}`;
  return { filename, buffer };
}
