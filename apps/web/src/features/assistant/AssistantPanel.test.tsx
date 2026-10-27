import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi, renderRoute } from '../../test/utils';

const me = (assistant: boolean) => ({
  path: '/api/auth/me',
  body: {
    id: 'u',
    login: 'ivanov',
    role: 'user',
    features: { backups: false, assistant },
    locale: 'ru',
  },
});
const card = {
  reportId: 't1',
  reportName: 'Счёт',
  params: { company: 2 },
  display: [{ label: 'Компания', value: 'АО Лютик' }],
  outputFormats: ['pdf', 'docx'],
  defaultOutput: 'pdf',
};

beforeEach(() => sessionStorage.clear());

describe('панель ассистента', () => {
  it('выключен — кнопки нет', async () => {
    mockApi([me(false), { path: '/api/templates', body: [] }]);
    renderRoute('/reports');
    await screen.findByText('ivanov');
    expect(screen.queryByText('Ассистент')).toBeNull();
  });

  it('диалог: отправка, история в запросе, ответ текстом, карточка → формирование', async () => {
    const { calls } = mockApi([
      me(true),
      { path: '/api/templates', body: [] },
      {
        method: 'POST',
        path: '/api/assistant/chat',
        body: { reply: 'Вот запуск', cards: [{ type: 'run', ...card }] },
      },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'run1' } },
    ]);
    renderRoute('/reports');
    await userEvent.click(await screen.findByText('Ассистент'));
    const panel = await screen.findByRole('complementary', { name: 'Ассистент' });
    await userEvent.type(
      within(panel).getByLabelText('Сообщение ассистенту'),
      'счёт для Лютика{Enter}',
    );
    expect(await within(panel).findByText('Вот запуск')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/assistant/chat')?.body).toEqual({
      messages: [{ role: 'user', content: 'счёт для Лютика' }],
      page: { path: '/reports' },
    });
    expect(within(panel).getByText('АО Лютик')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Сформировать' }));
    expect(await within(panel).findByText('Отчёт сформирован')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/reports/t1/render')?.body).toEqual({
      params: { company: 2 },
    });
    expect(within(panel).getByRole('button', { name: 'PDF' })).toBeInTheDocument();
  });

  it('карточка уходит в следующий запрос текстом; «Новый диалог» очищает', async () => {
    const { calls } = mockApi([
      me(true),
      { path: '/api/templates', body: [] },
      {
        method: 'POST',
        path: '/api/assistant/chat',
        body: { reply: 'Вот запуск', cards: [{ type: 'run', ...card }] },
      },
    ]);
    renderRoute('/reports');
    await userEvent.click(await screen.findByText('Ассистент'));
    const panel = await screen.findByRole('complementary', { name: 'Ассистент' });
    const input = within(panel).getByLabelText('Сообщение ассистенту');
    await userEvent.type(input, 'счёт{Enter}');
    await within(panel).findByText('Вот запуск');
    await userEvent.type(input, 'ещё{Enter}');
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/assistant/chat')).toHaveLength(2),
    );
    const second = calls.filter((c) => c.path === '/api/assistant/chat')[1]!.body as {
      messages: { content: string }[];
    };
    expect(second.messages[1]!.content).toBe(
      'Вот запуск\nПредложен запуск «Счёт»: Компания: АО Лютик',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Новый диалог' }));
    expect(within(panel).queryByText('Вот запуск')).toBeNull();
  });

  it('ошибка ответа — сообщение об ошибке, ввод снова доступен', async () => {
    mockApi([
      me(true),
      { path: '/api/templates', body: [] },
      {
        method: 'POST',
        path: '/api/assistant/chat',
        status: 502,
        body: {
          error: {
            code: 'ASSISTANT_UNAVAILABLE',
            message: 'Сервис модели не отвечает, попробуйте позже',
          },
        },
      },
    ]);
    renderRoute('/reports');
    await userEvent.click(await screen.findByText('Ассистент'));
    const panel = await screen.findByRole('complementary', { name: 'Ассистент' });
    await userEvent.type(within(panel).getByLabelText('Сообщение ассистенту'), 'x{Enter}');
    expect(
      await within(panel).findByText('Сервис модели не отвечает, попробуйте позже'),
    ).toBeInTheDocument();
    expect(within(panel).getByLabelText('Сообщение ассистенту')).toBeEnabled();
  });

  it('404 (ассистент выключен админом) — панель закрывается', async () => {
    mockApi([
      me(true),
      { path: '/api/templates', body: [] },
      {
        method: 'POST',
        path: '/api/assistant/chat',
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'ассистент выключен' } },
      },
    ]);
    renderRoute('/reports');
    await userEvent.click(await screen.findByText('Ассистент'));
    const panel = await screen.findByRole('complementary', { name: 'Ассистент' });
    await userEvent.type(within(panel).getByLabelText('Сообщение ассистенту'), 'x{Enter}');
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Ассистент' })).toBeNull(),
    );
  });
});
