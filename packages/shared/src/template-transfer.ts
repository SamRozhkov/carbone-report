import { z } from 'zod';
import {
  outputFormatsFor,
  OutputFormat,
  QueryMode,
  SslMode,
  TemplateExt,
  TemplateParam,
  TemplateQuery,
} from './index';

// ---- Перенос шаблонов между средами (§33) ----

export const TRANSFER_FORMAT = 'carbone-reports/templates';
export const TRANSFER_FORMAT_VERSION = 1;
export const TRANSFER_MANIFEST_FILE = 'manifest.json';
export const TRANSFER_FILE_EXT = '.crt.zip';

/** Лимиты архива (§33.2). */
export const MAX_TRANSFER_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_TRANSFER_UNPACKED_BYTES = 200 * 1024 * 1024;
export const MAX_TRANSFER_ENTRIES = 1000;
/** Шаблонов в одном архиве и идентификаторов в запросе выгрузки. */
export const MAX_TRANSFER_TEMPLATES = 200;

/** Путь файла шаблона в архиве: нумерация с 1 по порядку в манифесте. */
export const transferFilePath = (index: number, ext: TemplateExt) =>
  `templates/${index + 1}/template.${ext}`;

export const ExportTemplatesBody = z.object({
  ids: z.array(z.uuid('неверный идентификатор')).min(1).max(MAX_TRANSFER_TEMPLATES),
});
export type ExportTemplatesBody = z.infer<typeof ExportTemplatesBody>;

/** Источник данных — только для сведения и сопоставления; пароль и CA не выгружаются. */
export const TransferDatasource = z.strictObject({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1),
  username: z.string(),
  sslMode: SslMode,
});
export type TransferDatasource = z.infer<typeof TransferDatasource>;

const SortOrder = z.number().int().min(0);

/** Запрос шаблона: поля TemplateQuery (ключ, SQL, режим) + порядок. */
export const TransferQuery = z.strictObject({
  key: TemplateQuery.shape.key,
  sql: TemplateQuery.shape.sql,
  mode: QueryMode,
  sortOrder: SortOrder,
});
export type TransferQuery = z.infer<typeof TransferQuery>;

/** Параметр шаблона: все поля `template_params` без id/templateId — схема TemplateParam + порядок. */
export const TransferParam = TemplateParam.and(z.object({ sortOrder: SortOrder }));
export type TransferParam = z.infer<typeof TransferParam>;

const uniqueBy = <T>(items: T[], pick: (t: T) => string): string | null => {
  const seen = new Set<string>();
  for (const it of items) {
    const k = pick(it);
    if (seen.has(k)) return k;
    seen.add(k);
  }
  return null;
};

export const TransferTemplate = z
  .strictObject({
    name: z.string().trim().min(1, 'укажите название').max(255),
    description: z.string(),
    fileExt: TemplateExt,
    defaultOutput: OutputFormat,
    public: z.boolean(),
    /** Имя категории; `null` — без категории. */
    category: z.string().trim().min(1).max(100).nullable(),
    /** Имена групп доступа. */
    groups: z.array(z.string().trim().min(1).max(100)).max(1000),
    datasource: TransferDatasource,
    queries: z.array(TransferQuery).max(1000),
    params: z.array(TransferParam).max(1000),
    /** Путь файла шаблона в архиве. */
    file: z.string().min(1).max(200),
    /** sha256 файла шаблона, hex в нижнем регистре. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'ожидается sha256 в hex'),
  })
  .superRefine((t, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (!outputFormatsFor(t.fileExt).includes(t.defaultOutput))
      issue(['defaultOutput'], `формат ${t.defaultOutput} недоступен для .${t.fileExt}`);
    if (!t.file.endsWith(`/template.${t.fileExt}`))
      issue(['file'], `файл шаблона должен иметь расширение .${t.fileExt}`);
    const dupGroup = uniqueBy(t.groups, (g) => g.toLowerCase());
    if (dupGroup !== null) issue(['groups'], `группа "${dupGroup}" повторяется`);
    const dupKey = uniqueBy(t.queries, (q) => q.key);
    if (dupKey !== null) issue(['queries'], `ключ запроса "${dupKey}" повторяется`);
    const dupParam = uniqueBy(t.params, (p) => p.name);
    if (dupParam !== null) issue(['params'], `параметр "${dupParam}" повторяется`);
  });
export type TransferTemplate = z.infer<typeof TransferTemplate>;

export const TransferManifest = z
  .strictObject({
    format: z.literal(TRANSFER_FORMAT),
    formatVersion: z.literal(TRANSFER_FORMAT_VERSION),
    appVersion: z.string(),
    /** ISO-8601, UTC. */
    exportedAt: z.iso.datetime(),
    templates: z.array(TransferTemplate).min(1).max(MAX_TRANSFER_TEMPLATES),
  })
  .superRefine((m, ctx) => {
    m.templates.forEach((t, i) => {
      if (t.file !== transferFilePath(i, t.fileExt))
        ctx.addIssue({
          code: 'custom',
          path: ['templates', i, 'file'],
          message: `ожидается путь ${transferFilePath(i, t.fileExt)}`,
        });
    });
  });
export type TransferManifest = z.infer<typeof TransferManifest>;
