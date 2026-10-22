import {
  fillPdfText,
  hasPdfProtection,
  MAX_PDF_RESULT_BYTES,
  type PdfOptions,
} from '@carbone-reports/shared';
import { PAGE_FORMATS } from '@carbone-reports/shared/i18n';
import type { TemplateAttachmentRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { decryptSecret } from '../../lib/crypto';
import { AppError, badRequest } from '../../lib/errors';
import type { TemplateFull } from '../templates/service';
import { cleanPdfText } from './font';
import type { PdfPostJob } from './postprocess';
import type { PdfProtectJob } from './protect';

/** Настройки PDF шаблона для сборки отчёта (§36.4). */
export interface TemplatePdf {
  options: PdfOptions;
  /** В порядке итогового документа (loadTemplateAttachments). */
  attachments: Pick<
    TemplateAttachmentRow,
    'name' | 'placement' | 'sortOrder' | 'filePath' | 'pages' | 'pdfa'
  >[];
  templateName: string;
  /** Шифрование (§37.2); null — без пароля и запретов или предпросмотр. */
  protection: PdfProtectJob | null;
}

/** `key` — ключ секретов (config.encryptionKey); null — без защиты: предпросмотр администратора (§37.2). */
export function templatePdf(full: TemplateFull, key: Buffer | null): TemplatePdf {
  const o = full.pdfOptions;
  const enc = full.row.pdfPasswordEnc;
  return {
    options: o,
    attachments: full.attachments,
    templateName: full.row.name,
    protection:
      key && hasPdfProtection(o, enc !== null)
        ? {
            userPassword: enc === null ? '' : decryptSecret(enc, key),
            noPrint: o.protection?.noPrint ?? false,
            noCopy: o.protection?.noCopy ?? false,
            noModify: o.protection?.noModify ?? false,
          }
        : null,
  };
}

/** Без водяного знака, нумерации, метаданных и приложений PDF не обрабатывается (только PDF/A — тоже). */
export function needsPostprocess(p: TemplatePdf): boolean {
  const o = p.options;
  return Boolean(o.watermark || o.pageNumbers || o.metadata || p.attachments.length);
}

/**
 * Тексты — с подставленными тегами, управляющие символы → пробел; символы вне шрифта заменяет
 * постобработка по шрифту строки (§45.5, R2). Пустой водяной знак не ставится.
 */
export function buildPdfJob(
  p: TemplatePdf,
  data: unknown,
  now: Date,
  files: Uint8Array[],
): PdfPostJob {
  const o = p.options;
  const fill = (s: string) => cleanPdfText(fillPdfText(s, data)).trim();
  const wmText = o.watermark ? fill(o.watermark.text) : '';
  return {
    pdfa: o.pdfa,
    watermark: o.watermark && wmText ? { ...o.watermark, text: wmText } : null,
    // Формат не задан — по языку отчёта (§45.4); язык подключается в Task 3, до того — ru.
    pageNumbers: o.pageNumbers
      ? { ...o.pageNumbers, format: o.pageNumbers.format ?? PAGE_FORMATS.ru }
      : null,
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

/** Итоговый PDF: приложения из хранилища, обработка в пуле, шифрование последним шагом, лимит 100 МБ (§36.4, §37.2). */
export async function finishPdf(
  deps: Pick<AppDeps, 'storage' | 'pdf' | 'pdfProtect'>,
  pdf: Buffer,
  p: TemplatePdf,
  data: unknown,
  /** Остаток срока отчёта в мс: считается заново перед каждым шагом (qpdf не должен выйти за срок). */
  timeoutMs: () => number,
): Promise<Buffer> {
  const post = needsPostprocess(p);
  if (!post && !p.protection) return pdf;
  let out = pdf;
  if (post) {
    const files = await Promise.all(
      p.attachments.map(async (a) => {
        try {
          return await deps.storage.read(a.filePath);
        } catch (e) {
          throw new AppError(
            'STORAGE_ERROR',
            502,
            { key: 'pdf.attachmentUnavailable', params: { name: a.name } },
            undefined,
            e,
          );
        }
      }),
    );
    out = await deps.pdf(out, buildPdfJob(p, data, new Date(), files), timeoutMs());
  }
  if (p.protection) out = await deps.pdfProtect(out, p.protection, timeoutMs());
  if (out.length > MAX_PDF_RESULT_BYTES) throw badRequest('pdf.resultTooLarge', { size: 100 });
  return out;
}
