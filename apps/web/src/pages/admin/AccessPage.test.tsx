import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderRoute } from '../../test/utils';

const managerMe = {
  path: '/api/auth/me',
  body: { id: 'am-id', login: 'petrov', role: 'access_manager' },
};
const groups = [
  { id: 'g1', name: 'Бухгалтерия', description: '', memberIds: [], createdAt: '' },
  { id: 'g2', name: 'Логистика', description: '', memberIds: [], createdAt: '' },
];
const categories = [
  { id: 'c1', name: 'Финансы', sortOrder: 10, public: false, groupIds: [], templateCount: 1 },
];
const rows = [
  { id: 't1', name: 'Счёт', categoryId: 'c1', groupIds: ['g1', 'g2'], public: false },
  { id: 't2', name: 'Акт сверки', categoryId: null, groupIds: [], public: true },
];

const base = [
  managerMe,
  { path: '/api/access/templates', body: rows },
  { path: '/api/categories', body: categories },
  { path: '/api/groups', body: groups },
];

function row(text: string): HTMLElement {
  return screen.getByText(text).closest('tr')!;
}

describe('AccessPage', () => {
  it('таблица: название, категория, группы, «доступен всем»; пункт меню', async () => {
    mockApi(base);
    renderRoute('/admin/access');
    expect(await screen.findByRole('heading', { name: 'Доступ к отчётам' })).toBeInTheDocument();
    await screen.findByText('Счёт');
    for (const name of ['Название', 'Категория', 'Группы', 'Доступен всем']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    const invoice = within(row('Счёт'));
    await waitFor(() => expect(invoice.getByText('Финансы')).toBeInTheDocument());
    await waitFor(() => expect(invoice.getByText('Бухгалтерия, Логистика')).toBeInTheDocument());
    expect(invoice.getByText('нет')).toBeInTheDocument();
    expect(within(row('Акт сверки')).getByText('да')).toBeInTheDocument();
    // Перехода в конструктор нет.
    expect(screen.queryByRole('link', { name: 'Счёт' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/admin/templates"]')).toBeNull();
  });

  it('поиск по названию без учёта регистра', async () => {
    mockApi(base);
    renderRoute('/admin/access');
    await screen.findByText('Счёт');
    await userEvent.type(screen.getByLabelText('Поиск по названию'), 'АКТ');
    expect(screen.getByText('Акт сверки')).toBeInTheDocument();
    expect(screen.queryByText('Счёт')).not.toBeInTheDocument();
  });

  it('строка открывает диалог с текущими значениями; «Сохранить» → PUT и строка обновляется', async () => {
    let current = rows;
    const { calls } = mockApi([
      managerMe,
      { path: '/api/access/templates', handler: () => ({ body: current }) },
      { path: '/api/categories', body: categories },
      { path: '/api/groups', body: groups },
      {
        method: 'PUT',
        path: '/api/templates/t1/access',
        handler: ({ body }) => {
          current = current.map((r) => (r.id === 't1' ? { ...r, ...(body as object) } : r));
          return { body };
        },
      },
    ]);
    renderRoute('/admin/access');
    await screen.findByText('Счёт');
    await userEvent.click(row('Счёт'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Доступ к шаблону «Счёт»')).toBeInTheDocument();
    await waitFor(() =>
      expect(dialog.getByRole('combobox', { name: 'Категория' })).toHaveTextContent('Финансы'),
    );
    expect(dialog.getByRole('combobox', { name: 'Группы' })).toHaveTextContent('Бухгалтерия');
    expect(dialog.getByRole('checkbox', { name: 'Доступно всем' })).not.toBeChecked();
    const save = dialog.getByRole('button', { name: 'Сохранить' });
    expect(save).toBeDisabled();
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Доступно всем' }));
    await userEvent.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/api/templates/t1/access',
      body: { public: true, categoryId: 'c1', groupIds: ['g1', 'g2'] },
    });
    await waitFor(() => expect(within(row('Счёт')).getByText('да')).toBeInTheDocument());
  });

  it('ошибка сохранения остаётся в диалоге', async () => {
    mockApi([
      ...base,
      {
        method: 'PUT',
        path: '/api/templates/t2/access',
        status: 400,
        body: { error: { code: 'BAD_REQUEST', message: 'группа не найдена' } },
      },
    ]);
    renderRoute('/admin/access');
    await screen.findByText('Акт сверки');
    await userEvent.click(screen.getByRole('button', { name: 'Доступ: Акт сверки' }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Доступно всем' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Сохранить' }));
    expect(await dialog.findByText('группа не найдена')).toBeInTheDocument();
  });

  it('пользователь без права уходит на /reports', async () => {
    mockApi([
      { path: '/api/auth/me', body: { id: 'e', login: 'e', role: 'editor' } },
      { path: '/api/templates', body: [] },
    ]);
    const { router } = renderRoute('/admin/access');
    await waitFor(() => expect(router.state.location.pathname).toBe('/reports'));
  });
});
