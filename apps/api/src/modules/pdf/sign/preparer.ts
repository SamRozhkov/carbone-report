import type { PdfSignPreparer } from '../../../deps';
import { AppError } from '../../../lib/errors';
import { RenderTimeoutError, TemplateRenderError, type RenderPool } from '../../render/pool';
import { prepareSignaturePdf } from './prepare';

const failed = (message: string, cause?: unknown) =>
  new AppError('PDF_ERROR', 502, `ошибка подготовки PDF к подписи: ${message}`, undefined, cause);

/** Подготовка — задачей пула рендера: pdf-lib не блокирует главный поток (R3). */
export function createPoolSignPreparer(pool: Pick<RenderPool, 'run'>): PdfSignPreparer {
  return async (pdf, job, timeoutMs) => {
    try {
      const r = await pool.run(
        { kind: 'sign', template: pdf, ext: 'pdf', data: job, options: { lang: '', timezone: '' } },
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

/** В этом потоке — для тестов API (createTestApp). */
export const inProcessSignPreparer: PdfSignPreparer = async (pdf, job) => {
  try {
    return Buffer.from(await prepareSignaturePdf(pdf, job));
  } catch (e) {
    throw failed(e instanceof Error ? e.message : String(e));
  }
};
