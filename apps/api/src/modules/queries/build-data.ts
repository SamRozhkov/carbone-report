import type { ParamValue, QueryMode } from '@carbone-reports/shared';

export interface QueryResult {
  key: string;
  mode: QueryMode;
  columns: string[];
  rows: Record<string, unknown>[];
}

export function buildReportData(
  results: QueryResult[],
  params: Record<string, ParamValue>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const r of results) {
    data[r.key] = r.mode === 'single' ? (r.rows[0] ?? null) : r.rows;
  }
  data.params = params;
  return data;
}
