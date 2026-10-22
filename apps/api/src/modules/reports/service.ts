import { type OutputFormat, type ParamValue, type ParamsInput } from '@carbone-reports/shared';
import { CARBONE_LANGS, OFFICE_REGIONS, type Locale } from '@carbone-reports/shared/i18n';
import type { AppDeps, TemplateFileRef } from '../../deps';
import { type Deadline, reportTimeout } from '../../lib/deadline';
import { AppError } from '../../lib/errors';
import { buildReportData } from '../queries/build-data';
import { runQueries } from '../queries/executor';
import { validateQueryParams } from '../queries/param-options';
import { resolveParams } from '../queries/params';
import { finishPdf, type TemplatePdf } from '../pdf/finish';
import { injectCharts } from '../templates/charts';
import type { TemplateFull } from '../templates/service';

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
    if (full.queries.length === 0)
      return { data: injectCharts(buildReportData([], params), full.charts), params };
    deadline?.check();
    const { pool, name } = await deps.sources.get(full.row.datasourceId);
    deadline?.check();
    const results = await runQueries(pool, name, full.queries, params, {
      timeoutMs: deadline ? deadline.cap(deps.config.queryTimeoutMs) : deps.config.queryTimeoutMs,
      maxRows: deps.config.queryMaxRows,
      deadline,
    });
    return { data: injectCharts(buildReportData(results, params), full.charts), params };
  } catch (e) {
    // Ошибка SQL после истечения срока (statement_timeout, урезанный до остатка срока, и т. п.) —
    // это истечение срока отчёта, а не ошибка SQL. Настоящая VALIDATION остаётся VALIDATION.
    const validation = e instanceof AppError && e.code === 'VALIDATION';
    if (deadline && !validation && deadline.remaining() <= 0) throw reportTimeout();
    throw e;
  }
}

/**
 * Рендер в Carbone. С `deadline` таймаут Carbone — не дольше остатка срока, ожидание ограничено сроком.
 * `tpl` — живой файл шаблона (предпросмотр админа) или копия из снимка запуска. `pdf` — настройки PDF
 * шаблона (§36.4): действуют только для формата pdf. `locale` — язык отчёта, определённый один раз
 * на построение (§45.2): форматы Carbone, регион OnlyOffice и нумерация страниц PDF.
 */
export function renderReport(
  deps: AppDeps,
  tpl: TemplateFileRef,
  data: unknown,
  format: OutputFormat,
  locale: Locale,
  deadline?: Deadline,
  pdf?: TemplatePdf,
): Promise<Buffer> {
  // Срок уже истёк — не нагружать Carbone заведомо прерванной задачей.
  if (deadline && deadline.remaining() <= 0) return Promise.reject(reportTimeout());
  const timeoutMs = () =>
    deadline ? deadline.cap(deps.config.renderTimeoutMs) : deps.config.renderTimeoutMs;
  const pdfa = format === 'pdf' && pdf?.options.pdfa === true;
  const work = (async () => {
    const out = await deps.carbone.render(tpl, data, {
      convertTo: format,
      lang: CARBONE_LANGS[locale],
      region: OFFICE_REGIONS[locale],
      timezone: deps.config.tz,
      timeoutMs: timeoutMs(),
      ...(pdfa ? { pdfa: true } : {}),
    });
    if (format !== 'pdf' || !pdf) return out;
    return finishPdf(deps, out, pdf, data, timeoutMs, locale);
  })();
  return deadline ? deadline.race(work) : work;
}
