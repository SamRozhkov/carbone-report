import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CertificateInfo } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { mockApi, renderRoute, userMe } from '../test/utils';
import { certificateState } from './SignaturePage';

const cert = (over: Partial<CertificateInfo> = {}): CertificateInfo => ({
  subjectCn: 'Иванов Иван Иванович',
  issuer: 'Тестовый УЦ',
  serial: '1001',
  notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: '2030-01-01T00:00:00.000Z',
  fingerprint: 'AB'.repeat(32),
  keyAlg: 'RSA-2048',
  ...over,
});

describe('SignaturePage (§39.1)', () => {
  it('без сертификата — пояснение и загрузка с паролем', async () => {
    const { calls } = mockApi([
      userMe,
      { path: '/api/me/certificate', body: { certificate: null } },
      { method: 'POST', path: '/api/me/certificate', status: 201, body: cert() },
    ]);
    renderRoute('/signature');
    expect(
      await screen.findByText(/Нужен файл \.p12 или \.pfx с закрытым ключом/),
    ).toBeInTheDocument();
    const file = new File([new Uint8Array([1, 2, 3])], 'me.p12', {
      type: 'application/x-pkcs12',
    });
    await userEvent.upload(screen.getByLabelText('Файл сертификата'), file);
    expect(screen.getByLabelText('Пароль к файлу')).toHaveAttribute('autocomplete', 'new-password');
    await userEvent.type(screen.getByLabelText('Пароль к файлу'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Загрузить сертификат' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/me/certificate')).toBe(true),
    );
    const form = calls.find((c) => c.method === 'POST')!.body as FormData;
    expect(form.get('password')).toBe('secret');
    expect((form.get('file') as File).name).toBe('me.p12');
    expect(await screen.findByText('Иванов Иван Иванович')).toBeInTheDocument();
  });

  it('карточка сертификата: владелец, издатель, серийный номер, срок, отпечаток', async () => {
    mockApi([userMe, { path: '/api/me/certificate', body: { certificate: cert() } }]);
    renderRoute('/signature');
    expect(await screen.findByText('Иванов Иван Иванович')).toBeInTheDocument();
    expect(screen.getByText('Тестовый УЦ')).toBeInTheDocument();
    expect(screen.getByText('1001')).toBeInTheDocument();
    expect(screen.getByText(/01\.01\.2030/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Заменить' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeInTheDocument();
  });

  it('предупреждения об истекающем и истёкшем сертификате', async () => {
    mockApi([
      userMe,
      {
        path: '/api/me/certificate',
        body: { certificate: cert({ notAfter: '2020-01-01T00:00:00.000Z' }) },
      },
    ]);
    renderRoute('/signature');
    expect(
      await screen.findByText('Срок действия сертификата истёк — загрузите новый'),
    ).toBeInTheDocument();
  });

  it('удаление: подтверждение и DELETE', async () => {
    const { calls } = mockApi([
      userMe,
      { path: '/api/me/certificate', body: { certificate: cert() } },
      { method: 'DELETE', path: '/api/me/certificate', status: 204, body: null },
    ]);
    renderRoute('/signature');
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить' }));
    expect(await screen.findByText('Удалить сертификат подписи?')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Удалить' });
    await userEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/me/certificate')).toBe(
        true,
      ),
    );
    // Окно подтверждения скрывает страницу (aria-hidden), пока не размонтировано.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('ошибка у поля пароля', async () => {
    mockApi([
      userMe,
      { path: '/api/me/certificate', body: { certificate: null } },
      {
        method: 'POST',
        path: '/api/me/certificate',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'неверные данные запроса',
            details: [{ path: '/password', message: 'неверный пароль или повреждённый файл' }],
          },
        },
      },
    ]);
    renderRoute('/signature');
    await userEvent.upload(
      await screen.findByLabelText('Файл сертификата'),
      new File([new Uint8Array([1])], 'x.p12'),
    );
    await userEvent.type(screen.getByLabelText('Пароль к файлу'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Загрузить сертификат' }));
    expect(await screen.findByText('неверный пароль или повреждённый файл')).toBeInTheDocument();
  });

  it('certificateState: предупреждение за 30 дней и истёкший', () => {
    const now = new Date('2026-10-19T00:00:00Z');
    expect(certificateState(cert({ notAfter: '2027-01-01T00:00:00Z' }), now)).toBe('ok');
    expect(certificateState(cert({ notAfter: '2026-11-10T00:00:00Z' }), now)).toBe('expiring');
    expect(certificateState(cert({ notAfter: '2026-10-01T00:00:00Z' }), now)).toBe('expired');
  });
});
