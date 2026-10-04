import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute, userMe } from '../test/utils';
import { formatRunParams } from './HistoryPage';

const run = (over: Record<string, unknown>) => ({
  id: 'r1',
  templateId: 't1',
  templateName: 'Счёт',
  templateVersion: 1,
  userId: 'user-id',
  userLogin: 'ivanov',
  params: { company: 'ООО', vat: true },
  outputFormat: 'pdf',
  status: 'ok',
  error: null,
  fileAvailable: true,
  durationMs: 1200,
  createdAt: '2026-01-31T09:05:00',
  ...over,
});

const page = (items: unknown[], total = items.length) => ({ items, total, page: 1, pageSize: 50 });

describe('HistoryPage', () => {
  it('user: свои запуски без колонки пользователя; ссылка на файл; ошибки и удалённые файлы', async () => {
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates', body: [] },
      {
        path: '/api/runs',
        body: page([
          run({}),
          run({ id: 'r2', status: 'error', error: 'запрос "x": ошибка', fileAvailable: false }),
          run({ id: 'r3', fileAvailable: false }),
        ]),
      },
    ]);
    renderRoute('/history');
    expect(await screen.findByText('запрос "x": ошибка')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Скачать' })[0]).toHaveAttribute(
      'href',
      '/api/runs/r1/file',
    );
    expect(screen.getByText('файл удалён')).toBeInTheDocument();
    expect(screen.queryByText('Пользователь')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/users')).toBe(false);
    expect(calls.find((c) => c.path.startsWith('/api/runs'))?.path).toBe('/api/runs?page=1');
  });

  it('admin: колонка пользователя, фильтры из URL уходят в запрос', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      {
        path: '/api/users',
        body: [
          {
            id: 'user-id',
            login: 'ivanov',
            role: 'user',
            blocked: false,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
      { path: '/api/runs', body: page([run({})], 120) },
    ]);
    renderRoute('/history?status=error&userId=user-id&page=2');
    expect(await screen.findByText('Пользователь')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/runs?page=2&status=error&userId=user-id')).toBe(
        true,
      ),
    );
  });
});

describe('formatRunParams', () => {
  it('человекочитаемо, null пропускается', () => {
    expect(formatRunParams({ a: 'x', b: 2, c: true, d: false, e: null })).toBe(
      'a: x, b: 2, c: да, d: нет',
    );
    expect(formatRunParams({})).toBe('—');
  });
});
