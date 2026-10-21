import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CadesUnavailableError, loadCades, type Cades, type CadesCert } from '../lib/cades';
import { mockApi, renderWithProviders } from '../test/utils';
import { SignGostDialog } from './SignGostDialog';

vi.mock('../lib/cades', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cades')>()),
  loadCades: vi.fn(),
}));

const cert = (thumbprint: string, subjectCn: string, keyBits: 256 | 512 = 256): CadesCert => ({
  thumbprint,
  subjectCn,
  issuerCn: 'Тестовый УЦ',
  validTo: new Date('2030-05-20T12:00:00Z'),
  certificateBase64: `CERT${thumbprint}`,
  keyBits,
});
const signature = {
  signerCn: 'Петров Пётр',
  fingerprint: 'AB'.repeat(32),
  signedAt: '2026-10-19T11:32:00.000Z',
  timestamped: true,
  method: 'gost' as const,
};
const prepared = { hash: 'ab'.repeat(32), hashAlg: 'streebog256', tsaUrl: 'http://tsa/tsp' };
const err = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message } },
});

const cades = {
  versions: vi.fn<Cades['versions']>(),
  listCertificates: vi.fn<Cades['listCertificates']>(),
  signHash: vi.fn<Cades['signHash']>(),
};

beforeEach(() => {
  vi.mocked(loadCades).mockReset().mockResolvedValue(cades);
  cades.listCertificates
    .mockReset()
    .mockResolvedValue([cert('A1', 'Иванов Иван'), cert('A2', 'Петров Пётр', 512)]);
  cades.signHash.mockReset().mockResolvedValue('SIGNATURE');
});

function open(onSigned = vi.fn(), onClose = vi.fn()) {
  renderWithProviders(<SignGostDialog runId="r1" open onClose={onClose} onSigned={onSigned} />);
  return { onSigned, onClose };
}
const signBtn = () => screen.getByRole('button', { name: 'Подписать' });

describe('SignGostDialog', () => {
  it('нет плагина — текст, ссылки на установку и пояснение про разрешение', async () => {
    vi.mocked(loadCades).mockRejectedValue(new CadesUnavailableError());
    mockApi([]);
    open();
    expect(
      await screen.findByText('Не найден КриптоПро ЭЦП Browser plug-in или КриптоПро CSP'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'КриптоПро ЭЦП Browser plug-in' })).toHaveAttribute(
      'href',
      'https://www.cryptopro.ru/products/cades/plugin',
    );
    expect(screen.getByRole('link', { name: 'КриптоПро CSP' })).toHaveAttribute(
      'href',
      'https://www.cryptopro.ru/products/csp',
    );
    expect(screen.getByText(/разрешите сайту доступ к плагину/)).toBeInTheDocument();
    expect(signBtn()).toBeDisabled();
  });

  it('нет сертификатов — текст §42.7', async () => {
    cades.listCertificates.mockResolvedValue([]);
    mockApi([]);
    open();
    expect(
      await screen.findByText(
        'Нет действующих сертификатов ГОСТ — установите сертификат в КриптоПро',
      ),
    ).toBeInTheDocument();
    expect(signBtn()).toBeDisabled();
  });

  it('список: владелец, издатель, срок; пояснение о проверке подлинности', async () => {
    mockApi([]);
    open();
    expect(await screen.findByRole('radio', { name: /Иванов Иван/ })).toBeChecked();
    expect(screen.getAllByText('Тестовый УЦ, действителен до 20.05.2030')).toHaveLength(2);
    expect(
      screen.getByText(
        'Подлинность сертификата проверяется сервисом проверки подписи (например, Госуслуги)',
      ),
    ).toBeInTheDocument();
  });

  it('выбор сертификата → подготовка → подпись хеша → завершение → onSigned', async () => {
    const { calls } = mockApi([
      { method: 'POST', path: '/api/runs/r1/sign/gost/prepare', body: prepared },
      { method: 'POST', path: '/api/runs/r1/sign/gost/complete', status: 201, body: signature },
    ]);
    const { onSigned } = open();
    await userEvent.click(await screen.findByRole('radio', { name: /Петров Пётр/ }));
    await userEvent.click(signBtn());
    await waitFor(() => expect(onSigned).toHaveBeenCalledWith(signature));
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/api/runs/r1/sign/gost/prepare', { certificate: 'CERTA2' }],
      ['/api/runs/r1/sign/gost/complete', { signature: 'SIGNATURE' }],
    ]);
    expect(cades.signHash).toHaveBeenCalledWith(
      'A2',
      prepared.hash,
      'streebog256',
      'http://tsa/tsp',
    );
  });

  it('отмена в плагине — текст в диалоге, «Подписать» снова активна, завершения нет', async () => {
    cades.signHash.mockRejectedValue(
      new Error('Действие было отменено пользователем. (0x8010006E)'),
    );
    const { calls } = mockApi([
      { method: 'POST', path: '/api/runs/r1/sign/gost/prepare', body: prepared },
    ]);
    const { onSigned } = open();
    await screen.findByRole('radio', { name: /Иванов Иван/ });
    await userEvent.click(signBtn());
    expect(await screen.findByText('Подписание отменено пользователем')).toBeInTheDocument();
    await waitFor(() => expect(signBtn()).toBeEnabled());
    expect(calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
    expect(onSigned).not.toHaveBeenCalled();
  });

  it('400 сервера — текст ошибки', async () => {
    mockApi([
      { method: 'POST', path: '/api/runs/r1/sign/gost/prepare', body: prepared },
      {
        method: 'POST',
        path: '/api/runs/r1/sign/gost/complete',
        ...err(400, 'VALIDATION', 'подпись не соответствует документу'),
      },
    ]);
    const { onSigned } = open();
    await screen.findByRole('radio', { name: /Иванов Иван/ });
    await userEvent.click(signBtn());
    expect(await screen.findByText('подпись не соответствует документу')).toBeInTheDocument();
    expect(onSigned).not.toHaveBeenCalled();
  });

  it('409 SIGN_BUSY — текст', async () => {
    const message = 'другая подпись уже выполняется — повторите через несколько секунд';
    mockApi([
      {
        method: 'POST',
        path: '/api/runs/r1/sign/gost/prepare',
        ...err(409, 'SIGN_BUSY', message),
      },
    ]);
    open();
    await screen.findByRole('radio', { name: /Иванов Иван/ });
    await userEvent.click(signBtn());
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(cades.signHash).not.toHaveBeenCalled();
  });

  it('«Отмена» закрывает диалог', async () => {
    mockApi([]);
    const { onClose } = open();
    await screen.findByRole('radio', { name: /Иванов Иван/ });
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onClose).toHaveBeenCalled();
  });
});
