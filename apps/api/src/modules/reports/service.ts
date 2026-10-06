import {
  outputFormatsFor,
  type OutputFormat,
  type ParamValue,
  type ParamsInput,
} from '@carbone-reports/shared';
import type { AppDeps } from '../../deps';
import { type Deadline, reportTimeout } from '../../lib/deadline';
import { badRequest } from '../../lib/errors';
import { buildReportData } from '../queries/build-data';
import { runQueries } from '../queries/executor';
import { validateQueryParams } from '../queries/param-options';
import { resolveParams } from '../queries/params';
import { templateFileRef, type TemplateFull } from '../templates/service';

/**
 * Параметры, строгая проверка вариантов и SQL отчёта. С `deadline` таймаут SQL — не дольше
 * остатка срока, весь сбор ограничен сроком, а ошибка SQL после истечения срока — TIMEOUT 504.
 */
export function collectReportData(
  deps: AppDeps,
  full: TemplateFull,
  input: ParamsInput,
  deadline?: Deadline,
): Promise<{ data: Record<string, unknown>; params: Record<string, ParamValue> }> {
  const work = collect(deps, full, input, deadline);
  return deadline ? deadline.race(work) : work;
}

async function collect(
  deps: AppDeps,
  full: TemplateFull,
  input: ParamsInput,
  deadline?: Deadline,
): Promise<{ data: Record<string, unknown>; params: Record<string, ParamValue> }> {
  const params = resolveParams(full.params, input);
  try {
    // VALIDATION отсюда, как и от resolveParams, не создаёт запуск с ошибкой (см. reports/routes).
    await validateQueryParams(deps, full, params, deadline);
    if (full.queries.length === 0) return { data: buildReportData([], params), params };
    const { pool, name } = await deps.sources.get(full.row.datasourceId);
    const results = await runQueries(pool, name, full.queries, params, {
      timeoutMs: deadline ? deadline.cap(deps.config.queryTimeoutMs) : deps.config.queryTimeoutMs,
      maxRows: deps.config.queryMaxRows,
    });
    return { data: buildReportData(results, params), params };
  } catch (e) {
    // statement_timeout, урезанный до остатка срока, — это истечение срока отчёта, а не ошибка SQL.
    if (deadline && deadline.remaining() <= 0) throw reportTimeout();
    throw e;
  }
}

export function assertFormat(full: TemplateFull, format: OutputFormat): void {
  if (!outputFormatsFor(full.row.fileExt).includes(format)) {
    throw badRequest(`формат ${format} недоступен для шаблона .${full.row.fileExt}`);
  }
}

/** Рендер в Carbone. С `deadline` таймаут Carbone — не дольше остатка срока, ожидание ограничено сроком. */
export function renderReport(
  deps: AppDeps,
  full: TemplateFull,
  data: unknown,
  format: OutputFormat,
  deadline?: Deadline,
): Promise<Buffer> {
  // Срок уже истёк — не нагружать Carbone заведомо прерванной задачей.
  if (deadline && deadline.remaining() <= 0) return Promise.reject(reportTimeout());
  const work = deps.carbone.render(templateFileRef(deps, full.row), data, {
    convertTo: format,
    lang: 'ru-ru',
    timezone: deps.config.tz,
    timeoutMs: deadline ? deadline.cap(deps.config.renderTimeoutMs) : deps.config.renderTimeoutMs,
  });
  return deadline ? deadline.race(work) : work;
}
