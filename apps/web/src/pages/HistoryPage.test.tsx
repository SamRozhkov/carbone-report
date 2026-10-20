import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunDto } from '@carbone-reports/shared';
import { describe, expect, it, vi } from 'vitest';
import * as download from '../lib/download';
import { adminMe, mockApi, renderRoute, userMe } from '../test/utils';
import { formatRunParams } from './HistoryPage';

const run = (over: Partial<RunDto>): RunDto => ({
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
  formats: ['pdf'],
  readyFormats: ['pdf'],
  signature: null,
  signable: false,
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
          run({
            id: 'r2',
            status: 'error',
            error: 'запрос "x": ошибка',
            fileAvailable: false,
            formats: [],
            readyFormats: [],
          }),
          run({ id: 'r3', fileAvailable: false, formats: [], readyFormats: [] }),
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

  it('запуск со снимком: меню «Скачать» со всеми форматами; выбранный формат скачивается', async () => {
    const spy = vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:run');
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates', body: [] },
      {
        path: '/api/runs',
        body: page([
          run({
            outputFormat: null,
            formats: ['pdf', 'docx', 'odt'],
            readyFormats: ['pdf', 'docx'],
          }),
        ]),
      },
      {
        path: '/api/runs/r1/file',
        raw: 'DOCX',
        headers: {
          'content-disposition': `attachment; filename="x.docx"; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82%202026-01-31.docx`,
        },
      },
    ]);
    renderRoute('/history');
    // Колонка «Формат» — уже собранные форматы.
    expect(await screen.findByText('PDF, DOCX')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Скачать' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Скачать' }));
    for (const f of ['PDF', 'DOCX', 'ODT']) {
      expect(await screen.findByRole('menuitem', { name: f })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('menuitem', { name: 'DOCX' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('blob:run', 'Счёт 2026-01-31.docx'));
    expect(calls.some((c) => c.path === '/api/runs/r1/file?format=docx')).toBe(true);
  });
  it('подписанный запуск: значок с подсказкой и пункт «PDF с подписью»', async () => {
    vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:run');
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates', body: [] },
      {
        path: '/api/runs',
        body: page([
          run({
            outputFormat: null,
            formats: ['pdf'],
            signature: {
              signerCn: 'Иванов Иван Иванович',
              fingerprint: 'AB'.repeat(32),
              signedAt: '2026-10-19T14:32:00',
              timestamped: false,
            },
          }),
        ]),
      },
      {
        path: '/api/runs/r1/file',
        raw: 'PDF',
        headers: { 'content-disposition': 'attachment; filename="x.pdf"' },
      },
    ]);
    renderRoute('/history');
    expect(
      await screen.findByTitle('Подписан: Иванов Иван Иванович, 19.10.2026 14:32'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Скачать' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'PDF с подписью' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/runs/r1/file?format=pdf&signed=1')).toBe(true),
    );
  });

  it('signable: «Подписать…» открывает диалог, после подписи список обновляется', async () => {
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates', body: [] },
      { path: '/api/runs', body: page([run({ outputFormat: null, signable: true })]) },
      {
        path: '/api/me/certificate',
        body: {
          certificate: {
            subjectCn: 'Иванов Иван Иванович',
            issuer: 'УЦ',
            serial: '1',
            notBefore: '2026-01-01T00:00:00.000Z',
            notAfter: '2030-01-01T00:00:00.000Z',
            fingerprint: 'AB'.repeat(32),
            keyAlg: 'RSA-2048',
          },
        },
      },
      {
        method: 'POST',
        path: '/api/runs/r1/sign',
        status: 201,
        body: {
          signerCn: 'x',
          fingerprint: 'AB',
          signedAt: '2026-10-19T14:32:00',
          timestamped: false,
        },
      },
    ]);
    renderRoute('/history');
    await userEvent.click(await screen.findByRole('button', { name: 'Скачать' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Подписать…' }));
    await userEvent.type(await screen.findByLabelText('Пароль к ключу подписи'), 'pw');
    const before = calls.filter((c) => c.path.startsWith('/api/runs?')).length;
    await userEvent.click(screen.getByRole('button', { name: 'Подписать' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path.startsWith('/api/runs?')).length).toBeGreaterThan(before),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText('Пароль к ключу подписи')).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Скачать' })).toBeInTheDocument();
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

  it('массив — через запятую в «ёлочках»', () => {
    expect(formatRunParams({ ids: [1, 2], from: '2026-01-01' })).toBe(
      'ids: «1, 2», from: 2026-01-01',
    );
  });
});
