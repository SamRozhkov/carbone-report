import { outputFormatsFor } from '@carbone-reports/shared';
import type { CarboneRenderer } from '../../deps';
import { AppError } from '../../lib/errors';
import { communityErrorMessage } from '../carbone/community';
import type { RenderHandoff } from './handoff';
import type { Converter } from './onlyoffice-convert';
import { RenderTimeoutError, TemplateRenderError, type RenderPool } from './pool';

const timeout = () => new AppError('TIMEOUT', 504, 'превышено время ожидания');

/**
 * Рендер встроенной сборкой Carbone: поток пула собирает отчёт в формате шаблона;
 * другой формат делает Document Server, забирая файл у этой реплики по разовой ссылке.
 */
export function createEmbeddedRenderer(opts: {
  pool: Pick<RenderPool, 'run'>;
  handoff: RenderHandoff;
  convert: Converter;
  selfUrl: string;
  /** Журнал ошибок шаблона (только текст Carbone, без данных отчёта). */
  log?: { info(o: object, m: string): void };
}): CarboneRenderer {
  const selfUrl = opts.selfUrl.replace(/\/$/, '');
  return {
    async render(tpl, data, ro) {
      if (!outputFormatsFor(tpl.ext).includes(ro.convertTo)) {
        throw new AppError(
          'BAD_REQUEST',
          400,
          `формат ${ro.convertTo} недоступен для шаблона ${tpl.ext}`,
        );
      }
      const deadlineAt = Date.now() + ro.timeoutMs;
      const template = await tpl.read(); // ошибка чтения — как есть (ENOENT обрабатывают вызывающие)
      let out: Buffer;
      try {
        out = await opts.pool.run(
          { template, ext: tpl.ext, data, options: { lang: ro.lang, timezone: ro.timezone } },
          deadlineAt,
        );
      } catch (e) {
        if (e instanceof RenderTimeoutError) throw timeout();
        if (e instanceof TemplateRenderError) {
          opts.log?.info(
            { templateId: tpl.id, version: tpl.version, carboneError: e.message },
            'ошибка шаблона Carbone',
          );
          const community = communityErrorMessage(e.message);
          if (community) throw new AppError('CARBONE_COMMUNITY', 400, community);
          throw new AppError('CARBONE_ERROR', 502, `ошибка генерации: ${e.message}`);
        }
        throw new AppError('CARBONE_ERROR', 502, 'сервис генерации недоступен', undefined, e);
      }
      if (ro.convertTo === tpl.ext) return out;

      const left = deadlineAt - Date.now();
      if (left <= 0) throw timeout();
      const { id, token } = await opts.handoff.put(out, tpl.ext, deadlineAt);
      try {
        return await opts.convert({
          filetype: tpl.ext,
          outputtype: ro.convertTo,
          title: `report.${tpl.ext}`,
          url: `${selfUrl}/internal/render-files/${id}?t=${encodeURIComponent(token)}`,
          signal: AbortSignal.timeout(left),
        });
      } finally {
        opts.handoff.remove(id);
      }
    },
  };
}
