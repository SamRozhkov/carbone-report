import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const ds = {
  id: 'd1',
  name: 'Склад',
  host: 'db',
  port: 5432,
  database: 'wh',
  username: 'ro',
  ssl: false,
  createdAt: '2026-01-01T00:00:00Z',
};

describe('DatasourcesPage', () => {
  it('создание с проверкой соединения: тест отправляет введённые параметры', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/datasources', body: [] },
      { method: 'POST', path: '/api/datasources/test', body: { ok: true } },
      { method: 'POST', path: '/api/datasources', status: 201, body: ds },
    ]);
    renderRoute('/admin/datasources');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить источник' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Склад');
    await userEvent.type(within(dialog).getByLabelText('Хост'), 'db');
    await userEvent.type(within(dialog).getByLabelText('База данных'), 'wh');
    await userEvent.type(within(dialog).getByLabelText('Пользователь БД'), 'ro');
    await userEvent.type(within(dialog).getByLabelText('Пароль'), 'secret');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Проверить соединение' }));
    expect(await within(dialog).findByText('Соединение установлено')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/datasources/test')?.body).toEqual({
      name: 'Склад',
      host: 'db',
      port: 5432,
      database: 'wh',
      username: 'ro',
      password: 'secret',
      ssl: false,
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/datasources')).toBe(true),
    );
  });

  it('редактирование без пароля: PATCH без поля password, проверка сохранённого источника', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/datasources', body: [ds] },
      {
        method: 'POST',
        path: '/api/datasources/d1/test',
        body: { ok: false, message: 'password authentication failed' },
      },
      { method: 'PATCH', path: '/api/datasources/d1', body: { ...ds, name: 'Склад 2' } },
    ]);
    renderRoute('/admin/datasources');
    await screen.findByText('Склад');
    await userEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Проверить соединение' }));
    expect(await within(dialog).findByText('password authentication failed')).toBeInTheDocument();
    const name = within(dialog).getByLabelText('Название');
    await userEvent.clear(name);
    await userEvent.type(name, 'Склад 2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const body = calls.find((c) => c.method === 'PATCH')?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('password');
    expect(body.name).toBe('Склад 2');
  });

  it('удаление используемого источника → сообщение сервера', async () => {
    mockApi([
      adminMe,
      { path: '/api/datasources', body: [ds] },
      {
        method: 'DELETE',
        path: '/api/datasources/d1',
        status: 409,
        body: { error: { code: 'CONFLICT', message: 'источник используется шаблонами' } },
      },
    ]);
    renderRoute('/admin/datasources');
    await screen.findByText('Склад');
    await userEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Удалить' }),
    );
    expect(await screen.findByText('источник используется шаблонами')).toBeInTheDocument();
  });

  it('результат проверки сбрасывается при изменении поля соединения', async () => {
    mockApi([
      adminMe,
      { path: '/api/datasources', body: [ds] },
      { method: 'POST', path: '/api/datasources/d1/test', body: { ok: true } },
    ]);
    renderRoute('/admin/datasources');
    await screen.findByText('Склад');
    await userEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Проверить соединение' }));
    expect(await within(dialog).findByText('Соединение установлено')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Хост'), 'x');
    expect(within(dialog).queryByText('Соединение установлено')).not.toBeInTheDocument();
  });

  it('ошибка валидации не по полю формы показывается в алерте', async () => {
    mockApi([
      adminMe,
      { path: '/api/datasources', body: [] },
      {
        method: 'POST',
        path: '/api/datasources',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'bad',
            details: [
              { path: '/extra', message: 'лишнее поле' },
              { path: '/host', message: 'обязательно' },
            ],
          },
        },
      },
    ]);
    renderRoute('/admin/datasources');
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить источник' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await within(dialog).findByText('extra: лишнее поле')).toBeInTheDocument();
    expect(within(dialog).getByText('обязательно')).toBeInTheDocument();
  });
});
