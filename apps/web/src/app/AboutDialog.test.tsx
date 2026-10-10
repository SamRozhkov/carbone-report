import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '../test/utils';
import { AboutDialog } from './AboutDialog';
import type { BuildInfo } from './buildInfo';

const web: BuildInfo = {
  version: '2.1.0',
  commit: 'abc1234',
  builtAt: '2026-10-10T10:00:00+03:00',
};
const WARNING =
  'Версии интерфейса и сервера различаются — обновите страницу или проверьте развёртывание';

function open(b: BuildInfo = web) {
  return renderWithProviders(<AboutDialog open onClose={() => {}} web={b} />);
}

describe('AboutDialog', () => {
  it('сервер той же версии: версия, коммит, дата, лицензия, без предупреждения', async () => {
    mockApi([
      { path: '/api/version', body: { version: '2.1.0', commit: 'abc1234', builtAt: 'x' } },
    ]);
    open();
    await waitFor(() => expect(screen.getAllByText('2.1.0')).toHaveLength(2));
    expect(screen.getAllByText('abc1234')).toHaveLength(2);
    expect(screen.getByText('2026-10-10T10:00:00+03:00')).toBeInTheDocument();
    expect(screen.getByText('Лицензия: PolyForm Strict 1.0.0')).toBeInTheDocument();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('сервер другой версии: предупреждение', async () => {
    mockApi([
      { path: '/api/version', body: { version: '2.0.2', commit: 'abc1234', builtAt: 'x' } },
    ]);
    open();
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
  });

  it('тот же номер, другой коммит: предупреждение', async () => {
    mockApi([
      { path: '/api/version', body: { version: '2.1.0', commit: 'fffffff', builtAt: 'x' } },
    ]);
    open();
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
  });

  it.each([401, 500])('запрос упал (%i): сообщение, остальное видно', async (status) => {
    mockApi([{ path: '/api/version', status, body: { error: { code: 'X', message: 'x' } } }]);
    open();
    expect(await screen.findByText('Версия сервера недоступна')).toBeInTheDocument();
    expect(screen.getByText('2.1.0')).toBeInTheDocument();
    expect(screen.getByText('Лицензия: PolyForm Strict 1.0.0')).toBeInTheDocument();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('dev/unknown у обоих: без предупреждения', async () => {
    mockApi([
      { path: '/api/version', body: { version: 'dev', commit: 'unknown', builtAt: 'unknown' } },
    ]);
    open({ version: 'dev', commit: 'unknown', builtAt: 'unknown' });
    await waitFor(() => expect(screen.getAllByText('dev')).toHaveLength(2));
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('запрос идёт только при открытом окне', async () => {
    const { calls } = mockApi([
      { path: '/api/version', body: { version: 'dev', commit: 'unknown', builtAt: 'unknown' } },
    ]);
    function Wrapper() {
      const [o, setO] = useState(false);
      return (
        <>
          <button onClick={() => setO(true)}>Версия dev</button>
          <AboutDialog open={o} onClose={() => setO(false)} />
        </>
      );
    }
    renderWithProviders(<Wrapper />);
    expect(calls).toHaveLength(0);
    await userEvent.click(screen.getByText('Версия dev'));
    expect(await screen.findByText('О программе')).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual(['/api/version']);
  });
});
