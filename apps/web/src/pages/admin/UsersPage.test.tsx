import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const users = [
  {
    id: 'admin-id',
    login: 'admin',
    role: 'admin',
    blocked: false,
    createdAt: '2026-01-01T00:00:00Z',
  },
  { id: 'u2', login: 'ivanov', role: 'user', blocked: false, createdAt: '2026-01-02T00:00:00Z' },
];

function row(login: string): HTMLElement {
  return screen.getByText(login).closest('tr')!;
}

describe('UsersPage', () => {
  it('у собственной записи нет удаления и блокировки', async () => {
    mockApi([adminMe, { path: '/api/users', body: users }]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    expect(
      within(row('admin (вы)')).queryByRole('button', { name: 'Удалить' }),
    ).not.toBeInTheDocument();
    expect(
      within(row('admin (вы)')).queryByRole('button', { name: 'Заблокировать' }),
    ).not.toBeInTheDocument();
    expect(within(row('ivanov')).getByRole('button', { name: 'Удалить' })).toBeInTheDocument();
  });

  it('создание: POST и обновление списка; ошибка валидации у поля', async () => {
    let attempt = 0;
    const { calls } = mockApi([
      adminMe,
      { path: '/api/users', body: users },
      {
        method: 'POST',
        path: '/api/users',
        handler: ({ body }) =>
          ++attempt === 1
            ? {
                status: 400,
                body: {
                  error: {
                    code: 'VALIDATION',
                    message: 'неверные данные запроса',
                    details: [{ path: '/login', message: 'слишком короткий логин' }],
                  },
                },
              }
            : {
                status: 201,
                body: {
                  id: 'u3',
                  role: 'user',
                  blocked: false,
                  createdAt: '2026-01-03T00:00:00Z',
                  ...(body as object),
                },
              },
      },
    ]);
    renderRoute('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить пользователя' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Логин'), 'pe');
    await userEvent.type(within(dialog).getByLabelText('Пароль'), 'password123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(await within(dialog).findByText('слишком короткий логин')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Логин'), 'trov');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({
      login: 'petrov',
      password: 'password123',
      role: 'user',
    });
    expect(
      calls.filter((c) => c.method === 'GET' && c.path === '/api/users').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('ошибка валидации с неизвестным полем видна в общем уведомлении', async () => {
    mockApi([
      adminMe,
      { path: '/api/users', body: users },
      {
        method: 'POST',
        path: '/api/users',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'неверные данные запроса',
            details: [{ path: '/role', message: 'недопустимая роль' }],
          },
        },
      },
    ]);
    renderRoute('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить пользователя' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Логин'), 'petrov');
    await userEvent.type(within(dialog).getByLabelText('Пароль'), 'password123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(await within(dialog).findByText(/недопустимая роль/)).toBeInTheDocument();
  });

  it('отмена очищает поля формы создания', async () => {
    mockApi([adminMe, { path: '/api/users', body: users }]);
    renderRoute('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить пользователя' }));
    let dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Логин'), 'abc');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Добавить пользователя' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Логин')).toHaveValue('');
  });

  it('удаление предупреждает о потере истории и предлагает блокировку', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/users', body: users },
      { method: 'DELETE', path: '/api/users/u2', status: 204 },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Удалить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/историей его запусков и файлами отчётов/)).toBeInTheDocument();
    expect(within(dialog).getByText(/заблокируйте/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/users/u2')).toBe(true),
    );
  });

  it('блокировка: PATCH {blocked:true}', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/users', body: users },
      { method: 'PATCH', path: '/api/users/u2', body: { ...users[1], blocked: true } },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Заблокировать' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ blocked: true }),
    );
  });
});
