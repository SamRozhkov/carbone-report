import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '../api/client';
import { resetMaintenance } from '../api/maintenance';
import { MaintenanceGate } from '../app/MaintenanceGate';
import { mockApi, renderWithProviders } from '../test/utils';
import { MaintenanceScreen } from './MaintenanceScreen';

const NAME = '2026-10-08T03-00-00Z';
const PRE = 'pre-restore-2026-10-08T10-00-00Z';
const active = (recovery: object | null = null) => ({
  active: true,
  phase: 'db',
  startedAt: '2026-10-08T10:00:05.000Z',
  backup: NAME,
  recovery,
});
const MAINTENANCE_503 = {
  status: 503,
  body: {
    error: {
      code: 'maintenance',
      message: 'идёт восстановление из бэкапа, повторите позже',
      details: { phase: 'db' },
    },
  },
};

afterEach(() => resetMaintenance());

describe('MaintenanceGate', () => {
  it('ответ 503 maintenance на любой запрос — экран на всю страницу вместо приложения', async () => {
    mockApi([
      { path: '/api/x', ...MAINTENANCE_503 },
      { path: '/api/maintenance', body: active() },
    ]);
    renderWithProviders(
      <MaintenanceGate>
        <div>приложение</div>
      </MaintenanceGate>,
    );
    expect(screen.getByText('приложение')).toBeInTheDocument();
    await apiJson('/api/x').catch(() => {});
    expect(await screen.findByText('Идёт восстановление из бэкапа…')).toBeInTheDocument();
    expect(screen.queryByText('приложение')).not.toBeInTheDocument();
    expect(await screen.findByText(`Этап: Замена базы данных · бэкап ${NAME}`)).toBeInTheDocument();
  });

  it('другие 503 экран не включают', async () => {
    mockApi([{ path: '/api/x', status: 503, body: { error: { code: 'INTERNAL', message: 'x' } } }]);
    renderWithProviders(
      <MaintenanceGate>
        <div>приложение</div>
      </MaintenanceGate>,
    );
    await apiJson('/api/x').catch(() => {});
    expect(screen.getByText('приложение')).toBeInTheDocument();
  });
});

describe('MaintenanceScreen', () => {
  it('опрашивает /api/maintenance раз в 3 с и перезагружает страницу, когда обслуживание закончилось', async () => {
    let n = 0;
    const reload = vi.fn();
    mockApi([
      {
        path: '/api/maintenance',
        handler: () => ({ body: ++n === 1 ? active() : { active: false } }),
      },
    ]);
    renderWithProviders(<MaintenanceScreen reload={reload} />);
    expect(await screen.findByText(/Этап: Замена базы данных/)).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 4_500 });
    expect(n).toBe(2);
  }, 8_000);

  it('«требуется восстановление»: форма кода, две кнопки; повтор отправляет код и цель', async () => {
    const { calls } = mockApi([
      { path: '/api/maintenance', body: active({ backup: NAME, preRestore: PRE }) },
      { method: 'POST', path: '/api/maintenance/retry', status: 202, body: { operationId: 'op9' } },
    ]);
    renderWithProviders(<MaintenanceScreen reload={vi.fn()} />);
    expect(
      await screen.findByText('Восстановление не завершено: база частично заменена'),
    ).toBeInTheDocument();
    const same = screen.getByRole('button', { name: `Повторить восстановление из ${NAME}` });
    const back = screen.getByRole('button', {
      name: `Вернуть состояние до восстановления (${PRE})`,
    });
    expect(same).toBeDisabled();
    expect(back).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Код восстановления'), 'abcd-efgh-ijkl');
    expect(same).toBeEnabled();
    await userEvent.click(back);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/api/maintenance/retry',
        body: { code: 'abcd-efgh-ijkl', target: 'pre-restore' },
      }),
    );
    expect(await screen.findByText('Повтор запущен, ждём завершения…')).toBeInTheDocument();
  });

  it('неверный код и лимит — текст ошибки сервера', async () => {
    mockApi([
      { path: '/api/maintenance', body: active({ backup: NAME, preRestore: null }) },
      {
        method: 'POST',
        path: '/api/maintenance/retry',
        status: 403,
        body: { error: { code: 'BAD_CODE', message: 'неверный код восстановления' } },
      },
    ]);
    renderWithProviders(<MaintenanceScreen reload={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Код восстановления'), 'AAAA-AAAA-AAAA');
    expect(
      screen.queryByRole('button', { name: /Вернуть состояние до восстановления/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: `Повторить восстановление из ${NAME}` }),
    );
    expect(await screen.findByText('неверный код восстановления')).toBeInTheDocument();
  });
});
