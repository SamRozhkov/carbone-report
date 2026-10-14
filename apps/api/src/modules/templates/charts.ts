import {
  buildChartOption,
  ChartDataError,
  type ChartValue,
  type TemplateChart,
  type TemplateQuery,
} from '@carbone-reports/shared';
import { AppError } from '../../lib/errors';

/** Ключ данных отчёта с описаниями графиков: `d.charts.<key>` (§35.4). */
export const CHARTS_DATA_KEY = 'charts';
export const CHARTS_KEY_TAKEN = 'ключ charts занят графиками';

export interface ChartIssue {
  path: string;
  message: string;
}

/** Проверки `PUT …/charts` сверх схемы: запрос есть и в режиме «Список строк»; ключ charts свободен. */
export function chartIssues(
  charts: readonly TemplateChart[],
  queries: readonly TemplateQuery[],
): ChartIssue[] {
  const issues: ChartIssue[] = [];
  const byKey = new Map(queries.map((q) => [q.key, q]));
  charts.forEach((c, i) => {
    const q = byKey.get(c.query);
    if (!q) issues.push({ path: `/${i}/query`, message: `нет запроса «${c.query}»` });
    else if (q.mode !== 'list')
      issues.push({
        path: `/${i}/query`,
        message: `запрос «${c.query}» возвращает одну строку — нужен режим «Список строк»`,
      });
  });
  if (charts.length > 0 && byKey.has(CHARTS_DATA_KEY))
    issues.push({ path: '', message: CHARTS_KEY_TAKEN });
  return issues;
}

/** Проверки `PUT …/queries` при графиках (R8): ключ charts, запросы графиков остаются списками. */
export function queryIssuesForCharts(
  queries: readonly TemplateQuery[],
  charts: readonly TemplateChart[],
): ChartIssue[] {
  if (charts.length === 0) return [];
  const issues: ChartIssue[] = [];
  queries.forEach((q, i) => {
    if (q.key === CHARTS_DATA_KEY) issues.push({ path: `/${i}/key`, message: CHARTS_KEY_TAKEN });
  });
  for (const c of charts) {
    const i = queries.findIndex((q) => q.key === c.query);
    if (i === -1)
      issues.push({ path: '', message: `запрос «${c.query}» используется графиком «${c.key}»` });
    else if (queries[i]!.mode !== 'list')
      issues.push({
        path: `/${i}/mode`,
        message: `запрос используется графиком «${c.key}» — нужен режим «Список строк»`,
      });
  }
  return issues;
}

export function assertNoIssues(issues: ChartIssue[]): void {
  if (issues.length) throw new AppError('VALIDATION', 400, 'неверные данные запроса', issues);
}

/**
 * `data.charts[key] = buildChartOption(...)` для каждого графика шаблона — в отчёте и предпросмотре.
 * Без графиков data не меняется. Ошибка данных графика — 400 CARBONE_TEMPLATE.
 */
export function injectCharts(
  data: Record<string, unknown>,
  charts: readonly TemplateChart[],
): Record<string, unknown> {
  if (charts.length === 0) return data;
  const out: Record<string, ChartValue> = {};
  for (const c of charts) {
    const rows = data[c.query];
    try {
      out[c.key] = buildChartOption(c, Array.isArray(rows) ? rows : []);
    } catch (e) {
      if (e instanceof ChartDataError)
        throw new AppError('CARBONE_TEMPLATE', 400, `ошибка шаблона: ${e.message}`);
      throw e;
    }
  }
  data[CHARTS_DATA_KEY] = out;
  return data;
}
