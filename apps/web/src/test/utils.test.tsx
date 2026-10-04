import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { apiJson } from '../api/client';
import { mockApi, renderRoute } from './utils';

describe('mockApi', () => {
  it('отвечает по шаблону пути и записывает вызовы', async () => {
    const { calls } = mockApi([
      {
        method: 'POST',
        path: '/api/things/:id',
        handler: ({ body }) => ({ status: 201, body: { got: body } }),
      },
    ]);
    const res = await apiJson<{ got: unknown }>('/api/things/42?x=1', {
      method: 'POST',
      json: { a: 1 },
    });
    expect(res).toEqual({ got: { a: 1 } });
    expect(calls).toEqual([{ method: 'POST', path: '/api/things/42?x=1', body: { a: 1 } }]);
  });

  it('незамоканный запрос → 404 с понятным сообщением', async () => {
    mockApi([]);
    await expect(apiJson('/api/nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('renderRoute', () => {
  it('рисует страницу «не найдено» для неизвестного пути', async () => {
    mockApi([{ path: '/api/auth/me', body: { id: 'u1', login: 'admin', role: 'admin' } }]);
    renderRoute('/no-such-page');
    expect(await screen.findByText('Страница не найдена')).toBeInTheDocument();
  });
});
