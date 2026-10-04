import { screen, waitFor } from '@testing-library/react';
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
  },
  {
    id: 't2',
    name: 'Акт сверки',
    description: '',
    fileExt: 'xlsx',
    defaultOutput: 'xlsx',
    updatedAt: '2026-01-11T10:00:00Z',
  },
];

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
});
