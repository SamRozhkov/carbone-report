import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute, userMe } from '../test/utils';

const templates = [
  {
    id: 't1',
    name: 'Счёт',
    description: 'Счёт на оплату',
    fileExt: 'docx',
    defaultOutput: 'pdf',
    updatedAt: '2026-01-10T10:00:00Z',
    category: null,
  },
  {
    id: 't2',
    name: 'Акт сверки',
    description: '',
    fileExt: 'xlsx',
    defaultOutput: 'xlsx',
    updatedAt: '2026-01-11T10:00:00Z',
    category: null,
  },
];

const tpl = (
  id: string,
  name: string,
  category: { id: string; name: string; sortOrder: number } | null,
) => ({
  id,
  name,
  description: '',
  fileExt: 'docx',
  defaultOutput: 'pdf',
  updatedAt: '2026-01-10T10:00:00Z',
  category,
});
const finance = { id: 'c1', name: 'Финансы', sortOrder: 1 };
const sales = { id: 'c2', name: 'Продажи', sortOrder: 0 };

describe('ReportsPage', () => {
  it('показывает шаблоны, поиск фильтрует, клик открывает генерацию', async () => {
    mockApi([userMe, { path: '/api/templates', body: templates }]);
    const { router } = renderRoute('/reports');
    expect(await screen.findByText('Счёт')).toBeInTheDocument();
    expect(screen.getByText('Акт сверки')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Поиск отчётов'), 'сверк');
    expect(screen.queryByText('Счёт')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Акт сверки'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/reports/t2'));
  });

  it('пустой список: админу подсказка про раздел «Шаблоны»', async () => {
    mockApi([adminMe, { path: '/api/templates', body: [] }]);
    renderRoute('/reports');
    expect(await screen.findByText(/создайте первый в разделе «Шаблоны»/)).toBeInTheDocument();
  });

  it('без категорий заголовков разделов нет', async () => {
    mockApi([userMe, { path: '/api/templates', body: templates }]);
    renderRoute('/reports');
    await screen.findByText('Счёт');
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });

  it('одна категория: заголовков нет', async () => {
    mockApi([
      userMe,
      { path: '/api/templates', body: [tpl('t1', 'Счёт', finance), tpl('t2', 'Акт', finance)] },
    ]);
    renderRoute('/reports');
    await screen.findByText('Счёт');
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });

  it('шаблоны сгруппированы по категориям: порядок sortOrder, «Прочие» в конце', async () => {
    mockApi([
      userMe,
      {
        path: '/api/templates',
        body: [
          tpl('t1', 'Счёт', finance),
          tpl('t2', 'Сводка', null),
          tpl('t3', 'Акт сверки', finance),
          tpl('t4', 'Продажи за месяц', sales),
        ],
      },
    ]);
    renderRoute('/reports');
    await screen.findByText('Счёт');
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['Продажи', 'Финансы', 'Прочие']);
    const financeSection = screen.getByRole('region', { name: 'Финансы' });
    expect(within(financeSection).getByText('Счёт')).toBeInTheDocument();
    expect(within(financeSection).getByText('Акт сверки')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Прочие' })).getByText('Сводка'),
    ).toBeInTheDocument();
  });

  it('равный sortOrder: разделы по имени; поиск скрывает пустой раздел', async () => {
    mockApi([
      userMe,
      {
        path: '/api/templates',
        body: [
          tpl('t1', 'Счёт', { id: 'c1', name: 'Финансы', sortOrder: 0 }),
          tpl('t2', 'Сводка', null),
          tpl('t3', 'Остатки', { id: 'c3', name: 'Склад', sortOrder: 0 }),
        ],
      },
    ]);
    renderRoute('/reports');
    await screen.findByText('Счёт');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Склад',
      'Финансы',
      'Прочие',
    ]);
    await userEvent.type(screen.getByLabelText('Поиск отчётов'), 'сч');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Финансы',
    ]);
    expect(screen.queryByText('Остатки')).not.toBeInTheDocument();
  });
});
