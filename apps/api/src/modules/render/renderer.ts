import { outputFormatsFor } from '@carbone-reports/shared';
import type { CarboneRenderer } from '../../deps';
import { AppError } from '../../lib/errors';
import { communityError } from '../carbone/community';
import type { RenderHandoff } from './handoff';
import type { Converter } from './onlyoffice-convert';
import { RenderTimeoutError, TemplateRenderError, type RenderPool } from './pool';

const timeout = () => new AppError('TIMEOUT', 504, { key: 'timeout' });

/** Сколько предупреждений рендера попадает в журнал; остальные — одной строкой «и ещё N». */
const MAX_LOGGED_WARNINGS = 20;

/** Первые MAX_LOGGED_WARNINGS предупреждений и «и ещё N», если их больше. */
function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_LOGGED_WARNINGS) return warnings;
  return [
    ...warnings.slice(0, MAX_LOGGED_WARNINGS),
    `и ещё ${warnings.length - MAX_LOGGED_WARNINGS}`,
  ];
}

/**
 * Рендер встроенной сборкой Carbone: поток пула собирает отчёт в формате шаблона;
 * другой формат делает Document Server, забирая файл у этой реплики по разовой ссылке.
 */
export function createEmbeddedRenderer(opts: {
  pool: Pick<RenderPool, 'run'>;
  handoff: RenderHandoff;
  convert: Converter;
  selfUrl: string;
  /** Хосты для загрузки изображений по адресу (§32.2); пусто — выключена. */
  imageUrlAllowlist: string[];
  /** Тайм-аут загрузки одного изображения по адресу, мс. */
  imageUrlTimeoutMs: number;
  /** Журнал ошибок шаблона и предупреждений рендера (только текст Carbone, без данных отчёта). */
  log?: { info(o: object, m: string): void; warn(o: object, m: string): void };
}): CarboneRenderer & { active(): number; idle(): Promise<void> } {
  let active = 0;
  let waiters: Array<() => void> = [];
  const selfUrl = opts.selfUrl.replace(/\/$/, '');
  const renderOne: CarboneRenderer['render'] = async (tpl, data, ro) => {
    if (!outputFormatsFor(tpl.ext).includes(ro.convertTo)) {
      throw new AppError('BAD_REQUEST', 400, {
        key: 'render.formatUnavailable',
        params: { format: ro.convertTo, ext: tpl.ext },
      });
    }
    const deadlineAt = Date.now() + ro.timeoutMs;
    const template = await tpl.read(); // ошибка чтения — как есть (ENOENT обрабатывают вызывающие)
    let out: Buffer;
    try {
      const result = await opts.pool.run(
        {
          template,
          ext: tpl.ext,
          data,
          options: {
            lang: ro.lang,
            timezone: ro.timezone,
            imageUrlAllowlist: opts.imageUrlAllowlist,
            imageUrlTimeoutMs: opts.imageUrlTimeoutMs,
          },
        },
        deadlineAt,
      );
      out = result.out;
      // Сбой загрузки изображения по адресу: картинка убрана, отчёт строится; адрес — без query-строки.
      // В журнал — не больше 20 предупреждений (цикл с тысячей мёртвых адресов не раздувает строку).
      if (result.warnings.length > 0) {
        opts.log?.warn(
          { templateId: tpl.id, warnings: capWarnings(result.warnings) },
          'изображение не загружено',
        );
      }
    } catch (e) {
      if (e instanceof RenderTimeoutError) throw timeout();
      if (e instanceof TemplateRenderError) {
        opts.log?.info(
          { templateId: tpl.id, version: tpl.version, carboneError: e.message },
          'ошибка шаблона Carbone',
        );
        const community = communityError(e.message);
        if (community) throw new AppError('CARBONE_COMMUNITY', 400, community);
        // Наш текст (данные не сериализуются) — переводится; текст Carbone — как есть.
        const message = e.text ?? e.message;
        // Ошибка метки (builder, drop, изображения…): Carbone дописывает « Source: "{метка}"» — R1.
        if (e.message.includes(' Source: "')) {
          throw new AppError('CARBONE_TEMPLATE', 400, {
            key: 'render.templateError',
            params: { message },
          });
        }
        throw new AppError('CARBONE_ERROR', 502, {
          key: 'render.generationError',
          params: { message },
        });
      }
      throw new AppError('CARBONE_ERROR', 502, { key: 'render.unavailable' }, undefined, e);
    }
    if (ro.convertTo === tpl.ext) return out;

    const left = deadlineAt - Date.now();
    if (left <= 0) throw timeout();
    const { id, token } = await opts.handoff.put(out, tpl.ext, deadlineAt);
    try {
      return await opts.convert({
        filetype: tpl.ext,
        // PDF/A-2b делает сам Document Server (§36.4).
        outputtype: ro.convertTo === 'pdf' && ro.pdfa ? 'pdfa' : ro.convertTo,
        title: `report.${tpl.ext}`,
        url: `${selfUrl}/internal/render-files/${id}?t=${encodeURIComponent(token)}`,
        signal: AbortSignal.timeout(left),
      });
    } finally {
      opts.handoff.remove(id);
    }
  };
  return {
    async render(tpl, data, ro) {
      active++;
      try {
        return await renderOne(tpl, data, ro);
      } finally {
        if (--active === 0) {
          const w = waiters;
          waiters = [];
          for (const f of w) f();
        }
      }
    },
    active: () => active,
    idle: () => (active === 0 ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
  };
}
