import { TemplateChart } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import {
  assertNoIssues,
  chartIssues,
  CHARTS_KEY_TAKEN,
  injectCharts,
  queryIssuesForCharts,
} from './charts';

const chart = (over: Record<string, unknown> = {}) =>
  TemplateChart.parse({
    key: 'sales',
    query: 'orders',
    type: 'bar',
    category: 'm',
    series: [{ column: 'v' }],
    ...over,
  });
const Q = [
  { key: 'orders', mode: 'list' as const, sql: 'select 1' },
  { key: 'head', mode: 'single' as const, sql: 'select 1' },
];

describe('проверки графиков (§35.3)', () => {
  it('chartIssues: нет запроса, запрос «одна строка», ключ charts', () => {
    expect(chartIssues([chart()], Q)).toEqual([]);
    expect(chartIssues([chart({ query: 'nope' }), chart({ key: 'b', query: 'head' })], Q)).toEqual([
      { path: '/0/query', message: 'нет запроса «nope»' },
      {
        path: '/1/query',
        message: 'запрос «head» возвращает одну строку — нужен режим «Список строк»',
      },
    ]);
    expect(
      chartIssues([chart()], [...Q, { key: 'charts', mode: 'list', sql: 'select 1' }]),
    ).toEqual([{ path: '', message: CHARTS_KEY_TAKEN }]);
    expect(chartIssues([], [{ key: 'charts', mode: 'list', sql: 'select 1' }])).toEqual([]);
  });
  it('queryIssuesForCharts: ключ charts, удалённый и «одна строка» запрос графика (R8)', () => {
    expect(queryIssuesForCharts([{ key: 'charts', mode: 'list', sql: 'x' }], [])).toEqual([]);
    expect(
      queryIssuesForCharts(
        [
          { key: 'charts', mode: 'list', sql: 'x' },
          { key: 'orders', mode: 'single', sql: 'x' },
        ],
        [chart(), chart({ key: 'b', query: 'gone' })],
      ),
    ).toEqual([
      { path: '/0/key', message: CHARTS_KEY_TAKEN },
      {
        path: '/1/mode',
        message: 'запрос используется графиком «sales» — нужен режим «Список строк»',
      },
      { path: '', message: 'запрос «gone» используется графиком «b»' },
    ]);
  });
  it('assertNoIssues: VALIDATION с details', () => {
    expect(() => assertNoIssues([])).not.toThrow();
    try {
      assertNoIssues([{ path: '/0/query', message: 'x' }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect(e).toMatchObject({
        code: 'VALIDATION',
        status: 400,
        details: [{ path: '/0/query', message: 'x' }],
      });
    }
  });
});

describe('injectCharts (§35.4)', () => {
  it('без графиков data не меняется и charts не создаётся', () => {
    const data = { orders: [], params: {} };
    expect(injectCharts(data, [])).toEqual({ orders: [], params: {} });
  });
  it('d.charts.<key> — описание по строкам запроса', () => {
    const data: Record<string, unknown> = { orders: [{ m: 'Янв', v: '10.5' }], params: {} };
    injectCharts(data, [chart()]);
    expect(data.charts).toMatchObject({
      sales: {
        type: 'echarts@v5',
        option: { xAxis: { data: ['Янв'] }, series: [{ data: [10.5] }] },
      },
    });
  });
  it('нет колонки — 400 CARBONE_TEMPLATE с ключом графика', () => {
    expect(() => injectCharts({ orders: [{ m: 'Янв' }] }, [chart()])).toThrow(
      expect.objectContaining({
        code: 'CARBONE_TEMPLATE',
        status: 400,
        message: 'ошибка шаблона: график sales: нет колонки v',
      }),
    );
  });
  it('больше 20 рядов при splitBy — 400 CARBONE_TEMPLATE с ключом графика', () => {
    const orders = Array.from({ length: 21 }, (_, i) => ({ m: 'Янв', v: 1, r: `r${i}` }));
    expect(() => injectCharts({ orders }, [chart({ splitBy: 'r' })])).toThrow(
      expect.objectContaining({
        code: 'CARBONE_TEMPLATE',
        status: 400,
        message: 'ошибка шаблона: график sales: больше 20 рядов',
      }),
    );
  });
});
