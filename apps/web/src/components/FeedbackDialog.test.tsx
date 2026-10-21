import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '../test/utils';
import { FeedbackDialog } from './FeedbackDialog';

function open(page = '/reports', onClose = vi.fn()) {
  renderWithProviders(<FeedbackDialog open onClose={onClose} page={page} />);
  return { onClose };
}

async function fill() {
  await userEvent.type(screen.getByLabelText('Тема'), '  Ошибка в отчёте  ');
  await userEvent.type(screen.getByLabelText('Сообщение'), '  Не открывается предпросмотр  ');
}

describe('FeedbackDialog', () => {
  it('отправляет письмо один раз и сообщает о передаче серверу, без обещания доставки', async () => {
    const { calls } = mockApi([
      { method: 'POST', path: '/api/feedback', body: { status: 'sent', id: 'feedback-1' } },
    ]);
    const { onClose } = open('/reports?private=value#selection');
    await fill();
    await userEvent.type(
      screen.getByLabelText('Электронная почта для ответа'),
      'person@example.ru',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByText('Спасибо за обратную связь')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Сообщение для внутренней технической поддержки передано почтовому серверу.',
      ),
    ).toBeInTheDocument();
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/feedback',
        body: {
          subject: 'Ошибка в отчёте',
          message: 'Не открывается предпросмотр',
          replyTo: 'person@example.ru',
          page: '/reports',
        },
      },
    ]);
    expect(screen.queryByRole('button', { name: 'Отправить' })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Закрыть' }).at(-1)!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['FEEDBACK_UNAVAILABLE', 'FEEDBACK_SEND_FAILED'])(
    '%s сохраняет черновик и не показывает успешную отправку',
    async (code) => {
      const message = 'Почтовый сервер недоступен. Попробуйте позже.';
      mockApi([
        {
          method: 'POST',
          path: '/api/feedback',
          status: 503,
          body: { error: { code, message } },
        },
      ]);
      open();
      await fill();
      await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.getByLabelText('Тема')).toHaveValue('  Ошибка в отчёте  ');
      expect(screen.getByLabelText('Сообщение')).toHaveValue('  Не открывается предпросмотр  ');
      expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled();
      expect(screen.queryByText('Спасибо за обратную связь')).not.toBeInTheDocument();
    },
  );

  it('не отправляет пустые поля и неверный адрес, показывает ограничения длины', async () => {
    const { calls } = mockApi([]);
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(screen.getByText('Укажите тему сообщения')).toBeInTheDocument();
    expect(screen.getByText('Напишите сообщение')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await fill();
    await userEvent.type(screen.getByLabelText('Электронная почта для ответа'), 'bad-address');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(screen.getByText('Укажите корректный адрес электронной почты')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(screen.getByLabelText('Тема')).toHaveAttribute('maxlength', '160');
    expect(screen.getByLabelText('Сообщение')).toHaveAttribute('maxlength', '5000');
    expect(screen.getByLabelText('Электронная почта для ответа')).toHaveAttribute(
      'maxlength',
      '254',
    );
  });

  it('пока идёт запрос, блокирует повторную отправку, отмену и закрытие по Esc', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const { onClose } = open('https://outside.example/path');
    await fill();
    const form = screen.getByLabelText('Тема').closest('form')!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled();
    expect(screen.getByLabelText('Тема')).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: /close|закрыть/i }));
    expect(onClose).not.toHaveBeenCalled();
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.page).toBe('/reports');
    expect(body).not.toHaveProperty('replyTo');
    await act(async () => {
      finish(
        new Response(JSON.stringify({ status: 'sent', id: 'feedback-2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    expect(await screen.findByText('Спасибо за обратную связь')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
