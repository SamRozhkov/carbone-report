import type { TemplateAdminDetails, TemplateParam } from '@carbone-reports/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { adminTemplate } from '../../../test/fixtures';
import { mockApi, pickOption, renderWithProviders } from '../../../test/utils';
import { ChartsTab, newChart } from './ChartsTab';

vi.mock('./ChartPreview', () => ({
  ChartPreview: ({ value }: { value: unknown }) => (
    <pre data-testid="chart-option">{JSON.stringify(value)}</pre>
  ),
}));

const sales = { ...newChart('sales', 'orders'), category: 'month', series: [{ column: 'total' }] };
const t = {
  ...adminTemplate,
  params: [] as TemplateParam[],
  queries: [
    { key: 'company', mode: 'single', sql: 'select 1 as name' },
    { key: 'orders', mode: 'list', sql: 'select month, total from orders' },
  ],
  charts: [sales],
} as TemplateAdminDetails;
const props = {
  template: t,
  testParams: {},
  onTestParams: () => {},
  previewData: null,
  onPreviewData: () => {},
};
const RUN = {
  method: 'POST',
  path: '/api/templates/t1/queries/run',
  body: {
    columns: ['month', 'total', 'qty'],
    rows: [
      { month: 'Янв', total: '100.5', qty: 1 },
      { month: 'Фев', total: 25, qty: 2 },
    ],
    truncated: false,
  },
};

describe('ChartsTab', () => {
  it('список, тег с копированием и подсказка', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockApi([]);
    renderWithProviders(<ChartsTab {...props} />);
    expect(await screen.findByRole('button', { name: /sales/ })).toBeInTheDocument();
    expect(screen.getByText('{d.charts.sales:chart}')).toBeInTheDocument();
    expect(screen.getByText(/вставьте в документ картинку-заглушку/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Скопировать тег' }));
    expect(writeText).toHaveBeenCalledWith('{d.charts.sales:chart}');
  });

  it('«Выполнить запрос» — запуск с тестовыми параметрами, колонки в выборе, предпросмотр по строкам', async () => {
    const { calls } = mockApi([RUN]);
    renderWithProviders(<ChartsTab {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнить запрос' }));
    expect(calls[0]!.body).toEqual({ sql: 'select month, total from orders', params: {} });
    const preview = await screen.findByTestId('chart-option');
    expect(preview.textContent).toContain('"data":["Янв","Фев"]');
    expect(preview.textContent).toContain('"data":[100.5,25]');
    await pickOption(screen.getByRole('combobox', { name: 'Колонка ряда 1' }), 'qty');
    await waitFor(() =>
      expect(screen.getByTestId('chart-option').textContent).toContain('"data":[1,2]'),
    );
  });

  it('график сверх лимитов движка — предупреждение вместо предпросмотра', async () => {
    const rows = Array.from({ length: 10001 }, (_, i) => ({ month: `m${i}`, total: i }));
    mockApi([{ ...RUN, body: { ...RUN.body, rows } }]);
    renderWithProviders(<ChartsTab {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнить запрос' }));
    expect(
      await screen.findByText('Отчёт с этим графиком не соберётся: в графике больше 10 000 точек'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('chart-option')).not.toBeInTheDocument();
  });

  it('сохранённой колонки нет в результате — пометка', async () => {
    mockApi([RUN]);
    renderWithProviders(
      <ChartsTab
        {...props}
        template={{ ...t, charts: [{ ...sales, series: [{ column: 'sum' }] }] }}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнить запрос' }));
    expect(await screen.findByText('Колонки «sum» нет в результате запроса')).toBeInTheDocument();
  });

  it('добавление — несохранённые правки; «Сохранить» отправляет весь список', async () => {
    const { calls } = mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/charts',
        handler: ({ body }) => ({
          body: { ...t, updatedAt: '2026-10-14T10:00:00Z', charts: body },
        }),
      },
    ]);
    renderWithProviders(<ChartsTab {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить график' }));
    expect(screen.getByText('Есть несохранённые изменения')).toBeInTheDocument();
    expect(screen.getByText('{d.charts.chart1:chart}')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить графики' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeDefined());
    const body = calls.find((c) => c.method === 'PUT')!.body as { key: string; query: string }[];
    expect(body.map((c) => [c.key, c.query])).toEqual([
      ['sales', 'orders'],
      ['chart1', 'orders'],
    ]);
    await waitFor(() =>
      expect(screen.queryByText('Есть несохранённые изменения')).not.toBeInTheDocument(),
    );
  });

  it('ошибки сервера — у полей', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/charts',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'неверные данные запроса',
            details: [{ path: '/0/query', message: 'нет запроса «orders»' }],
          },
        },
      },
    ]);
    renderWithProviders(<ChartsTab {...props} />);
    await userEvent.clear(await screen.findByRole('textbox', { name: 'Заголовок графика' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Заголовок графика' }), 'Продажи');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить графики' }));
    expect(await screen.findByText('нет запроса «orders»')).toBeInTheDocument();
  });

  it('ошибка поля, которого нет на экране, — в общем блоке', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/charts',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'неверные данные запроса',
            details: [
              { path: '/0/series/0/kind', message: 'вид и ось ряда — только у комбинированного' },
            ],
          },
        },
      },
    ]);
    renderWithProviders(<ChartsTab {...props} />);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Заголовок графика' }), 'П');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить графики' }));
    expect(
      await screen.findByText('0.series.0.kind: вид и ось ряда — только у комбинированного'),
    ).toBeInTheDocument();
  });

  it('без запросов со списком — подсказка, добавить нельзя', async () => {
    mockApi([]);
    renderWithProviders(
      <ChartsTab {...props} template={{ ...t, queries: [t.queries[0]!], charts: [] }} />,
    );
    expect(
      await screen.findByText(/добавьте запрос «Список строк» на вкладке «Данные»/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Добавить график' })).toBeDisabled();
  });
});
