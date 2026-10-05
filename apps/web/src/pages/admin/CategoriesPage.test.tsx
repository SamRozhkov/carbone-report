import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const groups = [
  { id: 'g1', name: 'Бухгалтерия', description: '', memberIds: [], createdAt: '' },
  { id: 'g2', name: 'Логистика', description: '', memberIds: [], createdAt: '' },
];
const categories = [
  { id: 'c1', name: 'Финансы', sortOrder: 10, public: false, groupIds: ['g1'], templateCount: 3 },
  { id: 'c2', name: 'Общие', sortOrder: 20, public: true, groupIds: [], templateCount: 0 },
];

function row(text: string): HTMLElement {
  return screen.getByText(text).closest('tr')!;
}

const base = [
  adminMe,
  { path: '/api/categories', body: categories },
  { path: '/api/groups', body: groups },
];

describe('CategoriesPage', () => {
  it('список: порядок, «доступно всем», группы, число шаблонов', async () => {
    mockApi(base);
    renderRoute('/admin/categories');
    await screen.findByText('Финансы');
    for (const name of ['Порядок', 'Название', 'Доступно всем', 'Группы', 'Шаблонов']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
    const fin = within(row('Финансы'));
    expect(fin.getByText('10')).toBeInTheDocument();
    expect(fin.getByText('Бухгалтерия')).toBeInTheDocument();
    expect(fin.getByText('3')).toBeInTheDocument();
    expect(fin.queryByText('да')).not.toBeInTheDocument();
    expect(within(row('Общие')).getByText('да')).toBeInTheDocument();
  });

  it('пункт меню «Категории» ведёт на страницу', async () => {
    mockApi([...base, { path: '/api/users', body: [] }]);
    const { router } = renderRoute('/admin/users');
    await userEvent.click(await screen.findByText('Категории'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/categories'));
  });

  it('создание: POST и PUT groups', async () => {
    const { calls } = mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/categories',
        handler: ({ body }) => ({
          status: 201,
          body: { id: 'c3', groupIds: [], templateCount: 0, ...(body as object) },
        }),
      },
      {
        method: 'PUT',
        path: '/api/categories/c3/groups',
        handler: ({ body }) => ({ body: { id: 'c3', ...(body as object) } }),
      },
    ]);
    renderRoute('/admin/categories');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить категорию' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Склад');
    const order = within(dialog).getByLabelText('Порядок');
    await userEvent.clear(order);
    await userEvent.type(order, '30');
    expect(within(dialog).getByRole('group', { name: 'Видимость' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Доступно всем' }));
    expect(within(dialog).getByRole('group', { name: 'Группы' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Группы' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Логистика' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Склад',
      sortOrder: 30,
      public: true,
    });
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/api/categories/c3/groups',
      body: { groupIds: ['g2'] },
    });
  });

  it('создание без групп: PUT groups не нужен', async () => {
    const { calls } = mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/categories',
        handler: ({ body }) => ({
          status: 201,
          body: { id: 'c3', groupIds: [], templateCount: 0, ...(body as object) },
        }),
      },
    ]);
    renderRoute('/admin/categories');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить категорию' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Склад');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Склад',
      sortOrder: 0,
      public: false,
    });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('редактирование: PATCH изменённых полей, группы без изменений не отправляются', async () => {
    const { calls } = mockApi([
      ...base,
      { method: 'PATCH', path: '/api/categories/c1', body: categories[0] },
    ]);
    renderRoute('/admin/categories');
    await screen.findByText('Финансы');
    await userEvent.click(within(row('Финансы')).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Название')).toHaveValue('Финансы');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Доступно всем' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ public: true });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('редактирование только групп: PUT groups без PATCH', async () => {
    const { calls } = mockApi([
      ...base,
      {
        method: 'PUT',
        path: '/api/categories/c1/groups',
        handler: ({ body }) => ({ body: { ...categories[0], ...(body as object) } }),
      },
    ]);
    renderRoute('/admin/categories');
    await screen.findByText('Финансы');
    await userEvent.click(within(row('Финансы')).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Группы' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Логистика' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ groupIds: ['g1', 'g2'] });
  });

  it('409 при создании показывается у поля «Название»', async () => {
    mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/categories',
        status: 409,
        body: {
          error: { code: 'CONFLICT', message: 'категория с таким названием уже существует' },
        },
      },
    ]);
    renderRoute('/admin/categories');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить категорию' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Финансы');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(await within(dialog).findByTestId('field-error')).toHaveTextContent(
      'категория с таким названием уже существует',
    );
  });

  it('удаление предупреждает, что шаблоны останутся без категории', async () => {
    const { calls } = mockApi([
      ...base,
      { method: 'DELETE', path: '/api/categories/c1', status: 204 },
    ]);
    renderRoute('/admin/categories');
    await screen.findByText('Финансы');
    await userEvent.click(within(row('Финансы')).getByRole('button', { name: 'Удалить' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Шаблоны категории останутся без категории');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/categories/c1')).toBe(
        true,
      ),
    );
  });
});
