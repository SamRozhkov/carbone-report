import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const U1 = '11111111-1111-4111-8111-111111111111';

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
    renderRoute(`/history?status=error&userId=${U1}&page=2`);
    expect(await screen.findByText('Пользователь')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/api/runs?page=2&status=error&userId=${U1}`)).toBe(true),
    );
  });
});

describe('HistoryPage URL', () => {
  const base = [{ path: '/api/templates', body: [] }];

  it('user: userId из URL не отправляется', async () => {
    const { calls } = mockApi([userMe, ...base, { path: '/api/runs', body: page([run({})]) }]);
    renderRoute(`/history?userId=${U1}`);
    await screen.findByText('ivanov'.slice(0, 0) || 'Счёт');
    expect(calls.some((c) => c.path.startsWith('/api/runs') && c.path.includes('userId'))).toBe(
      false,
    );
  });

  it('page=5 при total 3 -> сброс на страницу 1', async () => {
    const { calls } = mockApi([
      userMe,
      ...base,
      {
        path: '/api/runs',
        handler: (req) => ({
          body: req.url.searchParams.get('page') === '1' ? page([run({})], 3) : page([], 3),
        }),
      },
    ]);
    const { router } = renderRoute('/history?page=5');
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/runs?page=1')).toBe(true));
  });

  it('page=1.5 и templateId=bad нормализуются', async () => {
    const { calls } = mockApi([userMe, ...base, { path: '/api/runs', body: page([run({})]) }]);
    renderRoute('/history?page=1.5&templateId=bad');
    await screen.findByText('Счёт');
    expect(calls.filter((c) => c.path.startsWith('/api/runs')).map((c) => c.path)).toEqual([
      '/api/runs?page=1',
    ]);
  });

  it('templateName null -> прочерк', async () => {
    mockApi([userMe, ...base, { path: '/api/runs', body: page([run({ templateName: null })]) }]);
    renderRoute('/history');
    expect(await screen.findByText('—', { selector: 'td, td *' })).toBeInTheDocument();
  });

  it('ошибка запроса: алерт, без пустой таблицы', async () => {
    mockApi([
      userMe,
      ...base,
      {
        path: '/api/runs',
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'сбой сервера' } },
      },
    ]);
    renderRoute('/history');
    expect(await screen.findByText('сбой сервера')).toBeInTheDocument();
    expect(screen.queryByText('Запусков пока нет')).not.toBeInTheDocument();
  });

  it('смена фильтра меняет URL и сбрасывает page', async () => {
    mockApi([userMe, ...base, { path: '/api/runs', body: page([run({})], 120) }]);
    const { router } = renderRoute('/history?page=2');
    await screen.findByText('Счёт');
    await userEvent.click(screen.getByText('Любой результат'));
    await userEvent.click(await screen.findByText('Ошибка'));
    await waitFor(() => expect(router.state.location.search).toBe('?status=error'));
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
