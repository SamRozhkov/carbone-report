import type { CertificateInfo } from '@carbone-reports/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '../test/utils';
import { SignRunDialog } from './SignRunDialog';

const cert: CertificateInfo = {
  subjectCn: 'Иванов Иван Иванович',
  issuer: 'Тестовый УЦ',
  serial: '1001',
  notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: '2030-05-20T12:00:00.000Z',
  fingerprint: 'AB'.repeat(32),
  keyAlg: 'RSA-2048',
};
const signature = {
  signerCn: 'Иванов Иван Иванович',
  fingerprint: 'AB'.repeat(32),
  signedAt: '2026-10-19T11:32:00.000Z',
  timestamped: false,
  method: 'p12' as const,
};
const certRoute = { path: '/api/me/certificate', body: { certificate: cert } };

function open(onSigned = vi.fn(), onClose = vi.fn()) {
  renderWithProviders(<SignRunDialog runId="r1" open onClose={onClose} onSigned={onSigned} />);
  return { onSigned, onClose };
}
const err = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  body: { error: { code, message, details } },
});

describe('SignRunDialog', () => {
  it('показывает владельца и срок; «Подписать» неактивна при пустом пароле; пароль скрыт', async () => {
    mockApi([certRoute]);
    open();
    expect(
      await screen.findByText(/Иванов Иван Иванович, действителен до 20\.05\.2030/),
    ).toBeInTheDocument();
    const input = screen.getByLabelText('Пароль к ключу подписи');
    expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Подписать' })).toBeDisabled();
    await userEvent.type(input, 'x');
    expect(screen.getByRole('button', { name: 'Подписать' })).toBeEnabled();
  });

  it('отправляет пароль и вызывает onSigned с ответом', async () => {
    const { calls } = mockApi([
      certRoute,
      { method: 'POST', path: '/api/runs/r1/sign', status: 201, body: signature },
    ]);
    const { onSigned } = open();
    await userEvent.type(await screen.findByLabelText('Пароль к ключу подписи'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Подписать' }));
    await waitFor(() => expect(onSigned).toHaveBeenCalledWith(signature));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ password: 'secret' });
  });

  it('неверный пароль — у поля, поле очищается', async () => {
    mockApi([
      certRoute,
      {
        method: 'POST',
        path: '/api/runs/r1/sign',
        ...err(400, 'VALIDATION', 'ошибка', [
          { path: '/password', message: 'неверный пароль к ключу' },
        ]),
      },
    ]);
    const { onSigned } = open();
    const input = await screen.findByLabelText('Пароль к ключу подписи');
    await userEvent.type(input, 'bad');
    await userEvent.click(screen.getByRole('button', { name: 'Подписать' }));
    expect(await screen.findByTestId('field-error')).toHaveTextContent('неверный пароль к ключу');
    expect(input).toHaveValue('');
    expect(onSigned).not.toHaveBeenCalled();
  });

  it.each([
    [429, 'TOO_MANY_ATTEMPTS', 'слишком много неверных паролей — попробуйте через 15 минут'],
    [502, 'TSA_UNAVAILABLE', 'служба меток времени недоступна'],
  ])('%s — текстом в диалоге, поле очищается', async (status, code, message) => {
    mockApi([
      certRoute,
      { method: 'POST', path: '/api/runs/r1/sign', ...err(status, code, message) },
    ]);
    open();
    const input = await screen.findByLabelText('Пароль к ключу подписи');
    await userEvent.type(input, 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Подписать' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByTestId('field-error')).not.toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('409 SIGN_BUSY — текстом в диалоге, пароль сохраняется', async () => {
    const message = 'другая подпись уже выполняется — повторите через несколько секунд';
    mockApi([
      certRoute,
      { method: 'POST', path: '/api/runs/r1/sign', ...err(409, 'SIGN_BUSY', message) },
    ]);
    open();
    const input = await screen.findByLabelText('Пароль к ключу подписи');
    await userEvent.type(input, 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Подписать' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(input).toHaveValue('pw');
  });

  it('Enter в поле пароля подписывает; при пустом пароле — нет', async () => {
    const { calls } = mockApi([
      certRoute,
      { method: 'POST', path: '/api/runs/r1/sign', status: 201, body: signature },
    ]);
    const { onSigned } = open();
    const input = await screen.findByLabelText('Пароль к ключу подписи');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    await userEvent.type(input, '{Enter}');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await userEvent.type(input, 'secret{Enter}');
    await waitFor(() => expect(onSigned).toHaveBeenCalledWith(signature));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('«Отмена» стирает пароль и прежнюю ошибку', async () => {
    mockApi([
      certRoute,
      {
        method: 'POST',
        path: '/api/runs/r1/sign',
        ...err(502, 'TSA_UNAVAILABLE', 'служба меток времени недоступна'),
      },
    ]);
    const { onClose } = open();
    const input = await screen.findByLabelText('Пароль к ключу подписи');
    await userEvent.type(input, 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Подписать' }));
    expect(await screen.findByText('служба меток времени недоступна')).toBeInTheDocument();
    await userEvent.type(input, 'typed');
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onClose).toHaveBeenCalled();
    expect(input).toHaveValue('');
    expect(screen.queryByText('служба меток времени недоступна')).not.toBeInTheDocument();
  });
});
