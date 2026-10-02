import { outputFormatsFor, type OutputFormat, type ParamValue, type ParamsInput } from '@carbone-reports/shared';
import type { AppDeps } from '../../deps';
import { badRequest } from '../../lib/errors';
import { buildReportData } from '../queries/build-data';
import { runQueries } from '../queries/executor';
import { resolveParams } from '../queries/params';
import { templateFileRef, type TemplateFull } from '../templates/service';

export async function collectReportData(
  deps: AppDeps,
  full: TemplateFull,
  input: ParamsInput,
): Promise<{ data: Record<string, unknown>; params: Record<string, ParamValue> }> {
  const params = resolveParams(full.params, input);
  if (full.queries.length === 0) return { data: buildReportData([], params), params };
  const { pool, name } = await deps.sources.get(full.row.datasourceId);
  const results = await runQueries(pool, name, full.queries, params, {
    timeoutMs: deps.config.queryTimeoutMs,
    maxRows: deps.config.queryMaxRows,
  });
  return { data: buildReportData(results, params), params };
}

export function assertFormat(full: TemplateFull, format: OutputFormat): void {
  if (!outputFormatsFor(full.row.fileExt).includes(format)) {
    throw badRequest(`формат ${format} недоступен для шаблона .${full.row.fileExt}`);
  }
}

export function renderReport(deps: AppDeps, full: TemplateFull, data: unknown, format: OutputFormat): Promise<Buffer> {
  return deps.carbone.render(templateFileRef(deps, full.row), data, {
    convertTo: format,
    lang: 'ru-ru',
    timezone: deps.config.tz,
    timeoutMs: deps.config.renderTimeoutMs,
  });
}
