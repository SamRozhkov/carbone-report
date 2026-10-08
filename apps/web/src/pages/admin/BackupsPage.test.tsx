import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const me = { path: '/api/auth/me', body: { ...adminMe.body, features: { backups: true } } };
const NAME = '2026-10-08T03-00-00Z';
const PRE = 'pre-restore-2026-10-07T10-00-00Z';
const PARTIAL = '2026-10-06T03-00-00Z.partial';
const BACKUPS = [
  {
    name: NAME,
    createdAt: '2026-10-08T03:00:00Z',
    dbSize: 2 * 1024 * 1024,
    storageSize: 1536,
    lastMigration: 'abcdef0123456789'.repeat(4),
    kind: 'regular',
    status: 'ok',
  },
  {
    name: PRE,
    createdAt: '2026-10-07T10:00:00Z',
    dbSize: 10,
    storageSize: 20,
    lastMigration: null,
    kind: 'pre-restore',
    status: 'ok',
  },
  {
    name: PARTIAL,
    createdAt: '2026-10-06T03:00:00Z',
    dbSize: 5,
    storageSize: null,
    lastMigration: null,
    kind: 'regular',
    status: 'partial',
  },
];
const list = { path: '/api/admin/backups', body: BACKUPS };
const noOperation = { path: '/api/admin/backups/operation', status: 204 };
const op = (over: object = {}) => ({
  id: 'op1',
  type: 'backup',
  requestedBy: 'admin',
  backup: null,
  phase: 'backup',
  status: 'succeeded',
  startedAt: '2026-10-08T03:00:00Z',
  finishedAt: '2026-10-08T03:00:10Z',
  error: null,
  log: [`бэкап ${NAME}: готово`],
  recovery: null,
  ...over,
});
const row = (text: string) => screen.getByText(text).closest('tr')!;

describe('BackupsPage', () => {
  it('таблица: колонки, имя под датой, тип, размер, миграция, статус; «Восстановить» только у готовых', async () => {
    mockApi([me, list, noOperation]);
    renderRoute('/admin/backups');
    await screen.findByText(NAME);
    for (const h of ['Дата', 'Тип', 'Размер', 'Миграция', 'Статус'])
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(within(row(NAME)).getByText('база 2,0 МБ · файлы 1,5 КБ')).toBeInTheDocument();
    expect(within(row(NAME)).getByText('abcdef012345')).toBeInTheDocument();
    expect(within(row(PRE)).getByText('перед восстановлением')).toBeInTheDocument();
    expect(within(row(PARTIAL)).getByText('незавершён')).toBeInTheDocument();
    expect(
      within(row(PARTIAL)).queryByRole('button', { name: 'Восстановить' }),
    ).not.toBeInTheDocument();
    expect(within(row(NAME)).getByRole('button', { name: 'Восстановить' })).toBeEnabled();
    expect(within(row(PRE)).getByRole('button', { name: 'Восстановить' })).toBeEnabled();
  });

  it('«Сделать бэкап»: POST, панель опрашивает операцию раз в 2 с, пока она идёт; затем список перечитывается', async () => {
    let created = false;
    let polls = 0;
    let listCalls = 0;
    mockApi([
      me,
      { path: '/api/admin/backups', handler: () => (listCalls++, { body: BACKUPS }) },
      {
        method: 'POST',
        path: '/api/admin/backups',
        handler: () => ((created = true), { status: 202, body: { operationId: 'op2' } }),
      },
      {
        path: '/api/admin/backups/operation',
        handler: () => {
          if (!created) return { status: 204 };
          polls++;
          return { body: op({ id: 'op2', status: polls === 1 ? 'running' : 'succeeded' }) };
        },
      },
    ]);
    renderRoute('/admin/backups');
    await screen.findByText(NAME);
    await userEvent.click(screen.getByRole('button', { name: 'Сделать бэкап' }));
    expect(await screen.findByText('выполняется')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сделать бэкап' })).toBeDisabled();
    expect(within(row(NAME)).getByRole('button', { name: 'Восстановить' })).toBeDisabled();
    expect(await screen.findByText('успешно', undefined, { timeout: 4_000 })).toBeInTheDocument();
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  }, 10_000);

  it('агент занят (409) — текст ошибки в уведомлении', async () => {
    mockApi([
      me,
      list,
      noOperation,
      {
        method: 'POST',
        path: '/api/admin/backups',
        status: 409,
        body: {
          error: { code: 'BUSY', message: 'уже выполняется другая операция с бэкапами' },
          busy: { type: 'restore', startedAt: '2026-10-08T10:00:00Z' },
        },
      },
    ]);
    renderRoute('/admin/backups');
    await screen.findByText(NAME);
    await userEvent.click(screen.getByRole('button', { name: 'Сделать бэкап' }));
    expect(
      await screen.findByText('уже выполняется другая операция с бэкапами'),
    ).toBeInTheDocument();
  });

  it('панель последней операции: тип, кто запустил, этап, статус, ошибка, журнал в свёрнутом блоке', async () => {
    mockApi([
      me,
      list,
      {
        path: '/api/admin/backups/operation',
        body: op({
          type: 'restore',
          backup: NAME,
          requestedBy: 'cron',
          phase: 'verify',
          status: 'failed',
          error: 'бэкап создан более новой версией приложения',
          log: ['этап: verify'],
        }),
      },
    ]);
    renderRoute('/admin/backups');
    expect(await screen.findByText(`Восстановление из ${NAME}`)).toBeInTheDocument();
    expect(screen.getByText(/Запустил: по расписанию/)).toBeInTheDocument();
    expect(screen.getByText('Этап: Проверка бэкапа')).toBeInTheDocument();
    expect(screen.getByTestId('operation-status')).toHaveTextContent('ошибка');
    expect(screen.getByText('бэкап создан более новой версией приложения')).toBeInTheDocument();
    const details = screen.getByText('Журнал').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('этап: verify')).toBeInTheDocument();
  });

  it('диалог: предупреждение; кнопка активна только при точном имени; POST restore', async () => {
    const { calls } = mockApi([
      me,
      list,
      noOperation,
      {
        method: 'POST',
        path: '/api/admin/backups/:name/restore',
        status: 202,
        body: { operationId: 'op3' },
      },
    ]);
    renderRoute('/admin/backups');
    await screen.findByText(NAME);
    await userEvent.click(within(row(NAME)).getByRole('button', { name: 'Восстановить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/будут заменены/)).toBeInTheDocument();
    expect(within(dialog).getByText(/будет сделан бэкап текущего состояния/)).toBeInTheDocument();
    expect(within(dialog).getByText(/может разлогинить/)).toBeInTheDocument();
    const apply = within(dialog).getByRole('button', { name: 'Восстановить' });
    const input = within(dialog).getByLabelText('Введите имя бэкапа для подтверждения');
    expect(apply).toBeDisabled();
    for (const wrong of [` ${NAME}`, NAME.toLowerCase(), NAME.slice(0, -1)]) {
      await userEvent.clear(input);
      await userEvent.type(input, wrong);
      expect(apply).toBeDisabled();
    }
    await userEvent.clear(input);
    await userEvent.type(input, NAME);
    expect(apply).toBeEnabled();
    await userEvent.click(apply);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `/api/admin/backups/${NAME}/restore`,
        body: undefined,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('пункт меню «Бэкапы» — только если функция включена', async () => {
    mockApi([me, { path: '/api/templates', body: [] }]);
    const first = renderRoute('/reports');
    expect(await screen.findByText('Бэкапы')).toBeInTheDocument();
    first.unmount();
    mockApi([adminMe, { path: '/api/templates', body: [] }]);
    renderRoute('/reports');
    expect(await screen.findByText('Пользователи')).toBeInTheDocument();
    expect(screen.queryByText('Бэкапы')).not.toBeInTheDocument();
  });
});
