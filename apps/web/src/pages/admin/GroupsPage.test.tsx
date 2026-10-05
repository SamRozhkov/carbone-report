import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const groups = [
  {
    id: 'g1',
    name: 'Бухгалтерия',
    description: 'Финансовые отчёты',
    memberIds: ['admin-id', 'u2'],
    createdAt: '2026-01-01T00:00:00Z',
  },
  { id: 'g2', name: 'Склад', description: '', memberIds: [], createdAt: '2026-01-02T00:00:00Z' },
];
const users = [
  {
    id: 'admin-id',
    login: 'admin',
    role: 'admin',
    blocked: false,
    groupIds: ['g1'],
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'u2',
    login: 'ivanov',
    role: 'user',
    blocked: false,
    groupIds: ['g1'],
    createdAt: '2026-01-02T00:00:00Z',
  },
];

function row(text: string): HTMLElement {
  return screen.getByText(text).closest('tr')!;
}

describe('GroupsPage', () => {
  it('список групп с числом участников', async () => {
    mockApi([adminMe, { path: '/api/groups', body: groups }, { path: '/api/users', body: users }]);
    renderRoute('/admin/groups');
    await screen.findByText('Бухгалтерия');
    expect(screen.getByRole('columnheader', { name: 'Участники' })).toBeInTheDocument();
    expect(within(row('Бухгалтерия')).getByText('2')).toBeInTheDocument();
    expect(within(row('Склад')).getByText('0')).toBeInTheDocument();
    expect(within(row('Бухгалтерия')).getByText('Финансовые отчёты')).toBeInTheDocument();
  });

  it('пункт меню «Группы» ведёт на страницу', async () => {
    mockApi([adminMe, { path: '/api/groups', body: groups }, { path: '/api/users', body: users }]);
    const { router } = renderRoute('/admin/users');
    await userEvent.click(await screen.findByText('Группы'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/groups'));
  });

  it('создание: POST; 409 показывается у поля «Название»', async () => {
    let attempt = 0;
    const { calls } = mockApi([
      adminMe,
      { path: '/api/groups', body: groups },
      { path: '/api/users', body: users },
      {
        method: 'POST',
        path: '/api/groups',
        handler: ({ body }) =>
          ++attempt === 1
            ? {
                status: 409,
                body: {
                  error: {
                    code: 'CONFLICT',
                    message: 'группа с таким названием уже существует',
                  },
                },
              }
            : {
                status: 201,
                body: { id: 'g3', memberIds: [], createdAt: '', ...(body as object) },
              },
      },
    ]);
    renderRoute('/admin/groups');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить группу' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Склад');
    await userEvent.type(within(dialog).getByLabelText('Описание'), 'Остатки');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(await within(dialog).findByTestId('field-error')).toHaveTextContent(
      'группа с таким названием уже существует',
    );
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Название'), ' 2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
      name: 'Склад 2',
      description: 'Остатки',
    });
  });

  it('изменение: PATCH только изменённых полей', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/groups', body: groups },
      { path: '/api/users', body: users },
      { method: 'PATCH', path: '/api/groups/g2', body: groups[1] },
    ]);
    renderRoute('/admin/groups');
    await screen.findByText('Склад');
    await userEvent.click(within(row('Склад')).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Название')).toHaveValue('Склад');
    await userEvent.type(within(dialog).getByLabelText('Описание'), 'Остатки');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ description: 'Остатки' });
  });

  it('«Участники»: мультивыбор пользователей и PUT members', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/groups', body: groups },
      { path: '/api/users', body: users },
      {
        method: 'PUT',
        path: '/api/groups/g2/members',
        handler: ({ body }) => ({
          body: { ...groups[1], memberIds: (body as { userIds: string[] }).userIds },
        }),
      },
    ]);
    renderRoute('/admin/groups');
    await screen.findByText('Склад');
    await userEvent.click(within(row('Склад')).getByRole('button', { name: 'Участники' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('group', { name: 'Участники' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Участники' }));
    await userEvent.click(await screen.findByRole('option', { name: 'ivanov' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')).toEqual({
        method: 'PUT',
        path: '/api/groups/g2/members',
        body: { userIds: ['u2'] },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('удаление спрашивает подтверждение и предупреждает о потере доступа', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/groups', body: groups },
      { path: '/api/users', body: users },
      { method: 'DELETE', path: '/api/groups/g1', status: 204 },
    ]);
    renderRoute('/admin/groups');
    await screen.findByText('Бухгалтерия');
    await userEvent.click(within(row('Бухгалтерия')).getByRole('button', { name: 'Удалить' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Участники потеряют доступ, выданный через эту группу');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/groups/g1')).toBe(true),
    );
  });
});
