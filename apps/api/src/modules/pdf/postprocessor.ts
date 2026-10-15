import type { PdfPostprocessor } from '../../deps';
import { AppError } from '../../lib/errors';
import { RenderTimeoutError, TemplateRenderError, type RenderPool } from '../render/pool';
import { postprocessPdf } from './postprocess';

const failed = (message: string, cause?: unknown) =>
  new AppError('PDF_ERROR', 502, `ошибка обработки PDF: ${message}`, undefined, cause);

/** Обработка PDF задачей пула рендера: тяжёлая работа не блокирует главный поток (§36.4). */
export function createPoolPdfPostprocessor(pool: Pick<RenderPool, 'run'>): PdfPostprocessor {
  return async (pdf, job, timeoutMs) => {
    const { attachments, ...rest } = job;
    try {
      const r = await pool.run(
        {
          kind: 'pdf',
          template: pdf,
          ext: 'pdf',
          data: { ...rest, attachments: attachments.map((a) => ({ placement: a.placement })) },
          options: { lang: '', timezone: '' },
          extra: attachments.map((a) => a.data),
        },
        Date.now() + timeoutMs,
      );
      return r.out;
    } catch (e) {
      if (e instanceof RenderTimeoutError)
        throw new AppError('TIMEOUT', 504, 'превышено время ожидания');
      if (e instanceof TemplateRenderError) throw failed(e.message);
      throw failed('поток рендера недоступен', e);
    }
  };
}

/** В этом потоке — для тестов API (createTestApp) и инструментов без пула. */
export const inProcessPdfPostprocessor: PdfPostprocessor = async (pdf, job) => {
  try {
    return Buffer.from(await postprocessPdf(pdf, job));
  } catch (e) {
    throw failed(e instanceof Error ? e.message : String(e));
  }
};
