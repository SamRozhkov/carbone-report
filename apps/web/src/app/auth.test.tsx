import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiJson } from '../api/client';
import { safeNext } from '../pages/LoginPage';
import { meKey } from '../api/session';
import { adminMe, mockApi, renderRoute, userMe } from '../test/utils';

const anon = {
  path: '/api/auth/me',
  status: 401,
  body: { error: { code: 'UNAUTHORIZED', message: 'требуется вход' } },
};

describe('вход и защита маршрутов', () => {
  it('без сессии → /login?next=…, после входа возвращает на исходную страницу', async () => {
    let loggedIn = false;
    const { calls } = mockApi([
      { path: '/api/auth/me', handler: () => (loggedIn ? userMe : anon) },
      {
        method: 'POST',
        path: '/api/auth/login',
        handler: () => {
          loggedIn = true;
          return { body: userMe.body };
        },
      },
      { path: '/api/runs', body: { items: [], total: 0, page: 1, pageSize: 50 } },
      { path: '/api/templates', body: [] },
    ]);
    const { router } = renderRoute('/history?status=error');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe('?next=%2Fhistory%3Fstatus%3Derror');

    await userEvent.type(await screen.findByLabelText('Логин'), 'ivanov');
    await userEvent.type(screen.getByLabelText('Пароль'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/history'));
    expect(router.state.location.search).toBe('?status=error');
    expect(calls.find((c) => c.path === '/api/auth/login')?.body).toEqual({
      login: 'ivanov',
      password: 'password123',
    });
  });

  it('неверный пароль → сообщение сервера', async () => {
    mockApi([
      anon,
      {
        method: 'POST',
        path: '/api/auth/login',
        status: 401,
        body: { error: { code: 'INVALID_CREDENTIALS', message: 'неверный логин или пароль' } },
      },
    ]);
    renderRoute('/login');
    await userEvent.type(await screen.findByLabelText('Логин'), 'x');
    await userEvent.type(screen.getByLabelText('Пароль'), 'y');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByText('неверный логин или пароль')).toBeInTheDocument();
  });

  it('внешний next игнорируется (open redirect)', async () => {
    let loggedIn = false;
    mockApi([
      { path: '/api/auth/me', handler: () => (loggedIn ? userMe : anon) },
      {
        method: 'POST',
        path: '/api/auth/login',
        handler: () => ((loggedIn = true), { body: userMe.body }),
      },
      { path: '/api/templates', body: [] },
    ]);
    const { router } = renderRoute('/login?next=%2F%2Fevil.com');
    await userEvent.type(await screen.findByLabelText('Логин'), 'ivanov');
    await userEvent.type(screen.getByLabelText('Пароль'), 'password123');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/reports'));
  });

  it('user не видит админских пунктов меню и не попадает в /admin/*', async () => {
    mockApi([userMe, { path: '/api/templates', body: [] }]);
    const { router } = renderRoute('/admin/users');
    await waitFor(() => expect(router.state.location.pathname).toBe('/reports'));
    expect((await screen.findAllByText('Отчёты')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Пользователи')).not.toBeInTheDocument();
    expect(screen.queryByText('Шаблоны')).not.toBeInTheDocument();
  });

  it('admin видит админские пункты меню', async () => {
    mockApi([adminMe, { path: '/api/templates', body: [] }]);
    renderRoute('/reports');
    expect(await screen.findByText('Пользователи')).toBeInTheDocument();
    expect(screen.getByText('Источники данных')).toBeInTheDocument();
    expect(screen.getByText('Шаблоны')).toBeInTheDocument();
  });

  it('401 из любого запроса посреди работы → на /login с текущим путём', async () => {
    let expired = false;
    mockApi([
      { path: '/api/auth/me', handler: () => (expired ? anon : userMe) },
      { path: '/api/anything', handler: () => ((expired = true), anon) },
    ]);
    const { router, queryClient } = renderRoute('/history');
    await screen.findAllByText('История');
    // Любой запрос через QueryClient, получивший 401, сбрасывает сессию (queryClient.ts).
    await queryClient
      .fetchQuery({ queryKey: ['anything'], queryFn: () => apiJson('/api/anything') })
      .catch(() => {});
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe('?next=%2Fhistory');
  });

  it('выход очищает сессию', async () => {
    let loggedIn = true;
    mockApi([
      { path: '/api/auth/me', handler: () => (loggedIn ? userMe : anon) },
      {
        method: 'POST',
        path: '/api/auth/logout',
        handler: () => ((loggedIn = false), { status: 204 }),
      },
      { path: '/api/templates', body: [] },
    ]);
    const { router, queryClient } = renderRoute('/reports');
    await screen.findAllByText('Отчёты');
    queryClient.setQueryData(['templates'], [{ id: 't1' }]);
    await userEvent.click(await screen.findByText('Выйти'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    await new Promise((r) => setTimeout(r, 100));
    expect(router.state.location.pathname).toBe('/login');
    expect(queryClient.getQueryData(['templates'])).toBeUndefined();
    expect(queryClient.getQueryData(meKey)).toBeNull();
  });

  it('сбой выхода на сервере → локально выходим, показываем предупреждение', async () => {
    mockApi([
      userMe,
      {
        method: 'POST',
        path: '/api/auth/logout',
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'сбой' } },
      },
      { path: '/api/templates', body: [] },
    ]);
    const { router } = renderRoute('/reports');
    await userEvent.click(await screen.findByText('Выйти'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText('Не удалось завершить сессию на сервере')).toBeInTheDocument();
  });
});

describe('safeNext', () => {
  it.each([
    [null, '/reports'],
    ['/history', '/history'],
    ['//evil.com', '/reports'],
    ['/\\evil.com', '/reports'],
    ['https://evil.com', '/reports'],
    ['/\t/evil.com', '/reports'],
    ['/\n/evil.com', '/reports'],
    ['/\t\\evil.com', '/reports'],
    ['/./..//evil.com', '/reports'],
    ['/a/../..//evil.com', '/reports'],
    ['/%2F%2Fevil.com', '/%2F%2Fevil.com'],
  ])('%s → %s', (input, expected) => expect(safeNext(input)).toBe(expected));
});
