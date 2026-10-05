import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const users = [
  {
    id: 'admin-id',
    login: 'admin',
    role: 'admin',
    blocked: false,
    groupIds: [],
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'u2',
    login: 'ivanov',
    role: 'user',
    blocked: false,
    groupIds: ['g1', 'g2'],
    createdAt: '2026-01-02T00:00:00Z',
  },
];
const groups = [
  { id: 'g1', name: 'Бухгалтерия', description: '', memberIds: ['u2'], createdAt: '' },
  { id: 'g2', name: 'Склад', description: '', memberIds: ['u2'], createdAt: '' },
  { id: 'g3', name: 'Юристы', description: '', memberIds: [], createdAt: '' },
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

  it('пароль: нейтральная подсказка, затем ошибка валидации', async () => {
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
            message: 'x',
            details: [{ path: '/password', message: 'слишком короткий пароль' }],
          },
        },
      },
    ]);
    renderRoute('/admin/users');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить пользователя' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('не короче 8 символов')).toHaveAttribute(
      'data-testid',
      'field-hint',
    );
    expect(within(dialog).queryByTestId('field-error')).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Логин'), 'petrov');
    await userEvent.type(within(dialog).getByLabelText('Пароль'), 'short');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(await within(dialog).findByTestId('field-error')).toHaveTextContent(
      'слишком короткий пароль',
    );
  });

  it('редактирование себя: роль и блокировка недоступны', async () => {
    mockApi([adminMe, { path: '/api/users', body: users }]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    await userEvent.click(within(row('admin (вы)')).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Заблокирован')).toBeDisabled();
    expect(within(dialog).getByRole('combobox', { name: 'Роль' })).toBeDisabled();
  });

  it('сохранение без изменений: нет PATCH, диалог закрывается', async () => {
    const { calls } = mockApi([adminMe, { path: '/api/users', body: users }]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('смена только пароля: PATCH {password}', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/users', body: users },
      { method: 'PATCH', path: '/api/users/u2', body: users[1] },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Новый пароль'), 'newpass123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ password: 'newpass123' }),
    );
  });

  it('ошибка блокировки показывается тостом', async () => {
    mockApi([
      adminMe,
      { path: '/api/users', body: users },
      {
        method: 'PATCH',
        path: '/api/users/u2',
        status: 400,
        body: {
          error: { code: 'BAD_REQUEST', message: 'нельзя заблокировать последнего администратора' },
        },
      },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Заблокировать' }));
    expect(
      await screen.findByText('нельзя заблокировать последнего администратора'),
    ).toBeInTheDocument();
  });

  it('«Завершить сессии»: подтверждение, вызов API, уведомление; у себя кнопки нет', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/users', body: users },
      { method: 'POST', path: '/api/users/u2/sessions/revoke', status: 204 },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    expect(
      within(row('admin (вы)')).queryByRole('button', { name: 'Завершить сессии' }),
    ).not.toBeInTheDocument();
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Завершить сессии' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'Пользователю ivanov придётся войти заново на всех устройствах.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Завершить' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.path === '/api/users/u2/sessions/revoke'),
      ).toBe(true),
    );
    expect(await screen.findByText('Сессии пользователя ivanov завершены')).toBeInTheDocument();
  });

  it('колонка «Группы» показывает названия групп', async () => {
    mockApi([adminMe, { path: '/api/users', body: users }, { path: '/api/groups', body: groups }]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    expect(screen.getByRole('columnheader', { name: 'Группы' })).toBeInTheDocument();
    await waitFor(() => expect(row('ivanov')).toHaveTextContent('Бухгалтерия, Склад'));
  });

  it('редактирование групп: PUT /api/users/:id/groups без PATCH', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/users', body: users },
      { path: '/api/groups', body: groups },
      {
        method: 'PUT',
        path: '/api/users/u2/groups',
        handler: ({ body }) => ({ body: (body as { groupIds: string[] }).groupIds }),
      },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('group', { name: 'Группы' })).toBeInTheDocument();
    const combo = within(dialog).getByRole('combobox', { name: 'Группы' });
    await waitFor(() => expect(combo).toHaveTextContent('Бухгалтерия'));
    await userEvent.click(combo);
    await userEvent.click(await screen.findByRole('option', { name: 'Юристы' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/api/users/u2/groups',
      body: { groupIds: ['g1', 'g2', 'g3'] },
    });
  });

  it('пароль и группы: PATCH, затем PUT groups', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/users', body: users },
      { path: '/api/groups', body: groups },
      { method: 'PATCH', path: '/api/users/u2', body: users[1] },
      { method: 'PUT', path: '/api/users/u2/groups', body: ['g2'] },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Новый пароль'), 'newpass123');
    const combo = within(dialog).getByRole('combobox', { name: 'Группы' });
    await waitFor(() => expect(combo).toHaveTextContent('Бухгалтерия'));
    await userEvent.click(combo);
    await userEvent.click(await screen.findByRole('option', { name: 'Бухгалтерия' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const writes = calls.filter((c) => c.method === 'PATCH' || c.method === 'PUT');
    expect(writes.map((c) => c.method)).toEqual(['PATCH', 'PUT']);
    expect(writes[1]?.body).toEqual({ groupIds: ['g2'] });
  });
  it('группы не загрузились: ошибка «Не удалось загрузить группы»', async () => {
    mockApi([
      adminMe,
      { path: '/api/users', body: users },
      {
        path: '/api/groups',
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'сбой сервера' } },
      },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    expect(await screen.findByText('Не удалось загрузить группы')).toBeInTheDocument();
  });

  it('группы ещё загружаются: в колонке «…», а не «—»', async () => {
    mockApi([adminMe, { path: '/api/users', body: users }]);
    const mocked = vi.mocked(globalThis.fetch);
    const base = mocked.getMockImplementation()!;
    mocked.mockImplementation((input, init) =>
      new URL(String(input), 'http://localhost').pathname === '/api/groups'
        ? new Promise<Response>(() => {})
        : base(input, init),
    );
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    expect(row('ivanov')).toHaveTextContent('…');
    expect(row('ivanov')).not.toHaveTextContent('—');
  });

  it('PATCH прошёл, PUT groups упал: список пользователей всё равно обновляется', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/users', body: users },
      { path: '/api/groups', body: groups },
      { method: 'PATCH', path: '/api/users/u2', body: users[1] },
      {
        method: 'PUT',
        path: '/api/users/u2/groups',
        status: 400,
        body: { error: { code: 'BAD_REQUEST', message: 'неизвестная группа' } },
      },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    const usersGets = () =>
      calls.filter((c) => c.method === 'GET' && c.path === '/api/users').length;
    const before = usersGets();
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Новый пароль'), 'newpass123');
    const combo = within(dialog).getByRole('combobox', { name: 'Группы' });
    await waitFor(() => expect(combo).toHaveTextContent('Бухгалтерия'));
    await userEvent.click(combo);
    await userEvent.click(await screen.findByRole('option', { name: 'Бухгалтерия' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await within(dialog).findByText(/неизвестная группа/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(usersGets()).toBeGreaterThan(before));
  });
});
