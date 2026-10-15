import { z } from 'zod';

// Модуль не импортирует ./index: index реэкспортирует его и использует схемы в TemplateAdminDetails.

// ---- Настройки PDF шаблона (§36) ----

export const MAX_PDF_ATTACHMENTS = 10;
export const MAX_PDF_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Страниц во всех приложенных файлах шаблона. */
export const MAX_PDF_ATTACHMENT_PAGES = 500;
export const MAX_PDF_RESULT_BYTES = 100 * 1024 * 1024;
export const PDF_PAGE_FORMAT_DEFAULT = 'Стр. {page} из {pages}';

export const PdfColor = z.enum(['gray', 'red', 'blue']);
export type PdfColor = z.infer<typeof PdfColor>;
export const PDF_COLORS: Record<PdfColor, string> = {
  gray: '#808080',
  red: '#C00000',
  blue: '#1F4E9A',
};

export const PdfWatermark = z.strictObject({
  text: z.string().trim().min(1, 'укажите текст').max(200),
  opacity: z.number().int().min(10).max(50).default(20),
  color: PdfColor.default('gray'),
  angle: z.enum(['diagonal', 'horizontal']).default('diagonal'),
});
export type PdfWatermark = z.infer<typeof PdfWatermark>;

export const PdfPosition = z.enum(['bottom-center', 'bottom-right', 'top-right']);
export type PdfPosition = z.infer<typeof PdfPosition>;

export const PdfPageNumbers = z.strictObject({
  format: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((s) => s.includes('{page}'), 'нужен {page} — номер страницы')
    .default(PDF_PAGE_FORMAT_DEFAULT),
  position: PdfPosition.default('bottom-center'),
  skipFirst: z.boolean().default(false),
});
export type PdfPageNumbers = z.infer<typeof PdfPageNumbers>;

const MetaText = z.string().trim().max(500).default('');
export const PdfMetadata = z.strictObject({
  title: MetaText,
  author: MetaText,
  subject: MetaText,
  keywords: MetaText,
});
export type PdfMetadata = z.infer<typeof PdfMetadata>;

/** Выключенный блок — отсутствующий ключ (R1). */
export const PdfOptions = z.strictObject({
  pdfa: z.boolean().default(false),
  watermark: PdfWatermark.optional(),
  pageNumbers: PdfPageNumbers.optional(),
  metadata: PdfMetadata.optional(),
});
export type PdfOptions = z.infer<typeof PdfOptions>;

/** Метаданные без единого значения не хранятся (R1). */
export function normalizePdfOptions(o: PdfOptions): PdfOptions {
  const { metadata, ...rest } = o;
  if (!metadata || Object.values(metadata).every((v) => v === '')) return rest;
  return { ...rest, metadata };
}

export const PdfPlacement = z.enum(['start', 'end']);
export type PdfPlacement = z.infer<typeof PdfPlacement>;

/** Приложенный PDF-файл шаблона в карточке администратора. */
export const TemplateAttachment = z.object({
  id: z.string(),
  name: z.string(),
  placement: PdfPlacement,
  sortOrder: z.number().int(),
  size: z.number().int(),
  pages: z.number().int(),
  pdfa: z.boolean(),
});
export type TemplateAttachment = z.infer<typeof TemplateAttachment>;

/** Перемещение приложения: sortOrder — целевая позиция в группе (R6). */
export const MoveAttachmentBody = z.strictObject({
  placement: PdfPlacement.optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});
export type MoveAttachmentBody = z.infer<typeof MoveAttachmentBody>;

// ---- Теги в полях (§36.2) ----

const TAG_RE = /\{d\.([^{}]*)\}/g;
const PATH_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[\d+\])*$/;
const SEGMENT_RE = /([A-Za-z_]\w*)|\[(\d+)\]/g;

function resolvePath(data: unknown, path: string): unknown {
  let cur = data;
  for (const [, key, index] of path.matchAll(SEGMENT_RE)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (key !== undefined) {
      if (Array.isArray(cur) || !Object.hasOwn(cur, key)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    } else {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(index)];
    }
  }
  return cur;
}

/** Подставляет простые пути `{d.a.b}`, `{d.items[0].name}`; прочие теги остаются как есть. */
export function fillPdfText(text: string, data: unknown): string {
  return text.replace(TAG_RE, (whole, path: string) => {
    if (!PATH_RE.test(path)) return whole;
    const v = resolvePath(data, path);
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) return v.toISOString();
    return '';
  });
}

/** Ошибка у поля при сохранении: тег с форматтером, циклом или неверным путём. */
export function pdfTextIssues(text: string): string | null {
  for (const m of text.matchAll(TAG_RE)) {
    if (!PATH_RE.test(m[1]!)) return `в полях PDF теги без форматтеров: ${m[0]}`;
  }
  return null;
}

/** Постоянная часть текста — без тегов `{d.…}`. */
export function pdfStaticText(text: string): string {
  return text.replace(TAG_RE, '');
}
