import { fillPdfText, MAX_PDF_RESULT_BYTES, type PdfOptions } from '@carbone-reports/shared';
import type { TemplateAttachmentRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError, badRequest } from '../../lib/errors';
import type { TemplateFull } from '../templates/service';
import { sanitizePdfText } from './font';
import type { PdfPostJob } from './postprocess';

/** Настройки PDF шаблона для сборки отчёта (§36.4). */
export interface TemplatePdf {
  options: PdfOptions;
  /** В порядке итогового документа (loadTemplateAttachments). */
  attachments: Pick<
    TemplateAttachmentRow,
    'name' | 'placement' | 'sortOrder' | 'filePath' | 'pages' | 'pdfa'
  >[];
  templateName: string;
}

export const templatePdf = (full: TemplateFull): TemplatePdf => ({
  options: full.pdfOptions,
  attachments: full.attachments,
  templateName: full.row.name,
});

/** Без водяного знака, нумерации, метаданных и приложений PDF не обрабатывается (только PDF/A — тоже). */
export function needsPostprocess(p: TemplatePdf): boolean {
  const o = p.options;
  return Boolean(o.watermark || o.pageNumbers || o.metadata || p.attachments.length);
}

/** Тексты — с подставленными тегами и очищенные (R2); пустой водяной знак не ставится. */
export function buildPdfJob(
  p: TemplatePdf,
  data: unknown,
  now: Date,
  files: Uint8Array[],
): PdfPostJob {
  const o = p.options;
  const fill = (s: string) => sanitizePdfText(fillPdfText(s, data)).trim();
  const wmText = o.watermark ? fill(o.watermark.text) : '';
  return {
    pdfa: o.pdfa,
    watermark: o.watermark && wmText ? { ...o.watermark, text: wmText } : null,
    pageNumbers: o.pageNumbers ?? null,
    metadata: o.metadata
      ? {
          title: fill(o.metadata.title) || p.templateName,
          author: fill(o.metadata.author),
          subject: fill(o.metadata.subject),
          keywords: fill(o.metadata.keywords),
        }
      : null,
    attachments: p.attachments.map((a, i) => ({ placement: a.placement, data: files[i]! })),
    now: now.toISOString(),
  };
}

/** Итоговый PDF: приложения из хранилища, обработка в пуле, лимит 100 МБ (§36.4). */
export async function finishPdf(
  deps: Pick<AppDeps, 'storage' | 'pdf'>,
  pdf: Buffer,
  p: TemplatePdf,
  data: unknown,
  timeoutMs: number,
): Promise<Buffer> {
  if (!needsPostprocess(p)) return pdf;
  const files = await Promise.all(
    p.attachments.map(async (a) => {
      try {
        return await deps.storage.read(a.filePath);
      } catch (e) {
        throw new AppError(
          'STORAGE_ERROR',
          502,
          `приложенный файл «${a.name}» недоступен`,
          undefined,
          e,
        );
      }
    }),
  );
  const out = await deps.pdf(pdf, buildPdfJob(p, data, new Date(), files), timeoutMs);
  if (out.length > MAX_PDF_RESULT_BYTES) throw badRequest('итоговый PDF больше 100 МБ');
  return out;
}
