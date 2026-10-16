import type { TemplateAdminDetails } from '@carbone-reports/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminTemplate } from '../../../test/fixtures';
import { mockApi, renderWithProviders } from '../../../test/utils';
import { DocumentTab } from './DocumentTab';

const mounts = vi.hoisted(() => ({ count: 0 }));
vi.mock('@onlyoffice/document-editor-react', () => ({
  DocumentEditor: (p: { documentServerUrl: string; config: { document: { key: string } } }) => {
    useEffect(() => {
      mounts.count++;
    }, []);
    return <div data-testid="oo" data-url={p.documentServerUrl} data-key={p.config.document.key} />;
  },
}));

const t = adminTemplate as unknown as TemplateAdminDetails;
const config = {
  document: { fileType: 'docx', key: 'k1', title: 'Счёт.docx', url: 'http://api:3000/internal/x' },
  documentType: 'word',
  editorConfig: {},
  token: 'jwt',
};
const base = {
  template: t,
  testParams: {},
  onTestParams: () => {},
  previewData: null,
  onPreviewData: () => {},
};
const lock = [
  { method: 'POST', path: '/api/templates/t1/edit-lock', body: { state: 'mine' } },
  { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DocumentTab', () => {
  it('редактор с конфигом сервера; переключение панели тегов не пересоздаёт редактор', async () => {
    mounts.count = 0;
    mockApi([...lock, { path: '/api/templates/t1/editor-config', body: config }]);
    renderWithProviders(<DocumentTab {...base} />);
    const editor = await screen.findByTestId('oo');
    expect(editor).toHaveAttribute('data-url', '/onlyoffice/');
    expect(editor).toHaveAttribute('data-key', 'k1');
    await userEvent.click(screen.getByRole('button', { name: 'Теги' }));
    await userEvent.click(screen.getByRole('button', { name: 'Теги' }));
    expect(mounts.count).toBe(1);
  });

  it('ссылка «Справка по синтаксису» открывает /admin/help в новой вкладке', async () => {
    mockApi([...lock, { path: '/api/templates/t1/editor-config', body: config }]);
    renderWithProviders(<DocumentTab {...base} />);
    const link = await screen.findByRole('link', { name: 'Справка по синтаксису' });
    expect(link).toHaveAttribute('href', '/admin/help');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
  });

  it('сохранение: forcesave и ожидание новой версии', async () => {
    let gets = 0;
    const { calls } = mockApi([
      ...lock,
      ...lock,
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      {
        path: '/api/templates/t1',
        handler: () => ({ body: { ...t, version: ++gets >= 2 ? 4 : 3 } }),
      },
    ]);
    renderWithProviders(<DocumentTab {...base} pollMs={5} pollTimeoutMs={2000} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранено, версия 4')).toBeInTheDocument();
    const saveCall = calls.find((c) => c.method === 'POST' && c.path === '/api/templates/t1/save');
    expect(saveCall!.body).toEqual({ holder: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('документ не открыт → понятное сообщение', async () => {
    mockApi([
      ...lock,
      { path: '/api/templates/t1/editor-config', body: config },
      { path: '/api/templates/t1', body: t },
      {
        method: 'POST',
        path: '/api/templates/t1/save',
        status: 409,
        body: { error: { code: 'NOT_OPEN', message: 'документ не открыт в редакторе' } },
      },
    ]);
    renderWithProviders(<DocumentTab {...base} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('документ не открыт в редакторе')).toBeInTheDocument();
  });

  it('нет изменений → сообщение без ожидания версии', async () => {
    mockApi([
      ...lock,
      { path: '/api/templates/t1/editor-config', body: config },
      { path: '/api/templates/t1', body: t },
      {
        method: 'POST',
        path: '/api/templates/t1/save',
        status: 409,
        body: { error: { code: 'NO_CHANGES', message: 'нет несохранённых изменений' } },
      },
    ]);
    renderWithProviders(<DocumentTab {...base} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Нет несохранённых изменений')).toBeInTheDocument();
    expect(screen.queryByText('Не удалось сохранить')).not.toBeInTheDocument();
  });

  it('нет подтверждения за отведённое время → предупреждение', async () => {
    mockApi([
      ...lock,
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      { path: '/api/templates/t1', body: t },
    ]);
    renderWithProviders(<DocumentTab {...base} pollMs={5} pollTimeoutMs={40} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText(/не подтвердил сохранение/)).toBeInTheDocument();
  });

  it('размонтирование во время опроса останавливает его: ни запросов, ни тостов, ни предупреждений React', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let gets = 0;
    mockApi([
      ...lock,
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      {
        path: '/api/templates/t1',
        handler: () => ({ body: { ...t, version: ++gets >= 3 ? 4 : 3 } }),
      },
    ]);
    const { unmount } = renderWithProviders(
      <DocumentTab {...base} pollMs={20} pollTimeoutMs={5000} />,
    );
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(gets).toBeGreaterThanOrEqual(1));
    unmount();
    const after = gets;
    const errorsAtUnmount = errSpy.mock.calls.length; // act-предупреждения до размонтирования не в счёт
    await sleep(200);
    expect(gets).toBe(after);
    expect(screen.queryByText(/Сохранено, версия/)).not.toBeInTheDocument();
    expect(errSpy.mock.calls).toHaveLength(errorsAtUnmount);
  });

  it('повторный клик «Сохранить» во время ожидания не запускает второй опрос', async () => {
    const { calls } = mockApi([
      ...lock,
      ...lock,
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      { path: '/api/templates/t1', body: t },
    ]);
    renderWithProviders(<DocumentTab {...base} pollMs={20} pollTimeoutMs={300} />);
    await screen.findByTestId('oo');
    const btn = screen.getByRole('button', { name: 'Сохранить' });
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(await screen.findByText(/не подтвердил сохранение/)).toBeInTheDocument();
    expect(
      calls.filter((c) => c.method === 'POST' && c.path === '/api/templates/t1/save'),
    ).toHaveLength(1);
  });

  it('устаревшая lastSaveError не считается провалом нового сохранения', async () => {
    let gets = 0;
    mockApi([
      ...lock,
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      {
        path: '/api/templates/t1',
        handler: () => ({
          body: {
            ...t,
            lastSaveError: 'old',
            lastSaveErrorAt: '2026-01-10T10:00:00.000Z',
            version: ++gets >= 3 ? 4 : 3,
          },
        }),
      },
    ]);
    renderWithProviders(<DocumentTab {...base} pollMs={5} pollTimeoutMs={2000} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранено, версия 4')).toBeInTheDocument();
    expect(screen.queryByText('Сохранение не удалось')).not.toBeInTheDocument();
  });

  it('повтор той же ошибки с новой меткой времени → «Сохранение не удалось», а не таймаут', async () => {
    let gets = 0;
    mockApi([
      ...lock,
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      {
        path: '/api/templates/t1',
        handler: () => ({
          body: {
            ...t,
            lastSaveError: 'OnlyOffice не смог сохранить документ',
            lastSaveErrorAt: ++gets >= 2 ? '2026-01-10T10:05:00.000Z' : '2026-01-10T10:00:00.000Z',
          },
        }),
      },
    ]);
    renderWithProviders(<DocumentTab {...base} pollMs={5} pollTimeoutMs={2000} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Сохранение не удалось')).toBeInTheDocument();
    expect(screen.getByText('OnlyOffice не смог сохранить документ')).toBeInTheDocument();
    expect(screen.queryByText(/не подтвердил сохранение/)).not.toBeInTheDocument();
  });

  it('другой текст ошибки при прежней метке — не новая ошибка', async () => {
    let gets = 0;
    mockApi([
      ...lock,
      { path: '/api/templates/t1/editor-config', body: config },
      { method: 'POST', path: '/api/templates/t1/save', status: 204 },
      {
        path: '/api/templates/t1',
        handler: () => ({
          body: {
            ...t,
            lastSaveError: ++gets >= 2 ? 'new' : 'old',
            lastSaveErrorAt: '2026-01-10T10:00:00.000Z',
          },
        }),
      },
    ]);
    renderWithProviders(<DocumentTab {...base} pollMs={5} pollTimeoutMs={200} />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText(/не подтвердил сохранение/)).toBeInTheDocument();
    expect(screen.queryByText('Сохранение не удалось')).not.toBeInTheDocument();
  });

  function bumpHarness() {
    return function H() {
      const [v, setV] = useState(3);
      return (
        <>
          <button onClick={() => setV(4)}>bump</button>
          <DocumentTab {...base} template={{ ...t, version: v }} />
        </>
      );
    };
  }

  it('версия выросла и ключ документа сменился → редактор получает новый ключ', async () => {
    let key = 'k1';
    mockApi([
      ...lock,
      {
        path: '/api/templates/t1/editor-config',
        handler: () => ({ body: { ...config, document: { ...config.document, key } } }),
      },
    ]);
    const H = bumpHarness();
    renderWithProviders(<H />);
    expect(await screen.findByTestId('oo')).toHaveAttribute('data-key', 'k1');
    key = 'k2';
    await userEvent.click(screen.getByRole('button', { name: 'bump' }));
    await waitFor(() => expect(screen.getByTestId('oo')).toHaveAttribute('data-key', 'k2'));
  });

  it('версия выросла, ключ тот же → редактор не пересоздаётся', async () => {
    mounts.count = 0;
    const { calls } = mockApi([...lock, { path: '/api/templates/t1/editor-config', body: config }]);
    const H = bumpHarness();
    renderWithProviders(<H />);
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('button', { name: 'bump' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path.includes('/editor-config'))).toHaveLength(2),
    );
    expect(mounts.count).toBe(1);
  });

  it('ошибка editor-config → кнопка «Повторить»', async () => {
    mockApi([
      ...lock,
      {
        path: '/api/templates/t1/editor-config',
        status: 500,
        body: { error: { code: 'X', message: 'сбой' } },
      },
    ]);
    renderWithProviders(<DocumentTab {...base} />);
    expect(await screen.findByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  const other = (sameUser = false) => ({
    state: 'other',
    user: { id: 'u2', login: 'petrov' },
    since: '2026-10-15T10:05:00.000Z',
    sameUser,
  });

  it('чужая блокировка: просмотр, «Забрать редактирование» с подтверждением, затем правка', async () => {
    mounts.count = 0;
    const { calls } = mockApi([
      { method: 'POST', path: '/api/templates/t1/edit-lock', body: other() },
      { method: 'POST', path: '/api/templates/t1/edit-lock/takeover', body: { state: 'mine' } },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
      { path: '/api/templates/t1/editor-config', body: config },
    ]);
    renderWithProviders(<DocumentTab {...base} />);
    expect(
      await screen.findByText(/Только просмотр — редактирует petrov с \d\d:\d\d/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Забрать редактирование' }));
    expect(
      screen.getByText(
        'Шаблон сейчас редактирует petrov. Забрать редактирование? Сделанные правки будут сохранены, а у petrov редактор переключится в просмотр',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Забрать' }));
    expect(await screen.findByText('Вы редактируете')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeInTheDocument();
    const configs = calls.filter((c) => c.path.startsWith('/api/templates/t1/editor-config'));
    expect(configs.at(-1)!.path).toMatch(/holder=[0-9a-f-]{36}/);
    await waitFor(() => expect(mounts.count).toBe(2)); // редактор пересоздан: просмотр → правка
  });

  it('своя другая вкладка: «Редактировать здесь» без подтверждения', async () => {
    mockApi([
      { method: 'POST', path: '/api/templates/t1/edit-lock', body: other(true) },
      { method: 'POST', path: '/api/templates/t1/edit-lock/takeover', body: { state: 'mine' } },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
      { path: '/api/templates/t1/editor-config', body: config },
    ]);
    renderWithProviders(<DocumentTab {...base} />);
    expect(await screen.findByText('Шаблон открыт у вас в другой вкладке')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Редактировать здесь' }));
    expect(await screen.findByText('Вы редактируете')).toBeInTheDocument();
  });

  it('«Редактировать здесь»: ошибка перехвата показывается тостом', async () => {
    mockApi([
      { method: 'POST', path: '/api/templates/t1/edit-lock', body: other(true) },
      {
        method: 'POST',
        path: '/api/templates/t1/edit-lock/takeover',
        status: 500,
        body: { error: { code: 'X', message: 'сбой сервера' } },
      },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
      { path: '/api/templates/t1/editor-config', body: config },
    ]);
    renderWithProviders(<DocumentTab {...base} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Редактировать здесь' }));
    expect(await screen.findByText('Не удалось забрать редактирование')).toBeInTheDocument();
    expect(screen.getByText('сбой сервера')).toBeInTheDocument();
  });

  /** Ответы POST …/edit-lock по очереди; последний повторяется. */
  const queue = (...states: unknown[]) => ({
    method: 'POST',
    path: '/api/templates/t1/edit-lock',
    handler: () => ({ body: states.length > 1 ? states.shift() : states[0] }),
  });

  describe('с таймерами', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it('документ свободен: «Начать редактирование»', async () => {
      mockApi([
        queue(other(), { state: 'free' }, { state: 'mine' }),
        { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
        { path: '/api/templates/t1/editor-config', body: config },
      ]);
      renderWithProviders(<DocumentTab {...base} />);
      await screen.findByText(/Только просмотр/);
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(await screen.findByText('Документ свободен')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Начать редактирование' }));
      expect(await screen.findByText('Вы редактируете')).toBeInTheDocument();
    });

    it('правку забрали: «Редактирование забрал», нет «Сохранить»', async () => {
      mockApi([
        queue({ state: 'mine' }, other()),
        { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
        { path: '/api/templates/t1/editor-config', body: config },
      ]);
      renderWithProviders(<DocumentTab {...base} />);
      await screen.findByText('Вы редактируете');
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(await screen.findByText('Редактирование забрал petrov')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
    });

    it('три ошибки продления — предупреждение о связи', async () => {
      let n = 0;
      mockApi([
        {
          method: 'POST',
          path: '/api/templates/t1/edit-lock',
          handler: () =>
            n++ === 0
              ? { body: { state: 'mine' } }
              : { status: 500, body: { error: { code: 'X', message: 'x' } } },
        },
        { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
        { path: '/api/templates/t1/editor-config', body: config },
      ]);
      renderWithProviders(<DocumentTab {...base} />);
      await screen.findByText('Вы редактируете');
      for (let i = 0; i < 3; i++) await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(
        await screen.findByText('Связь с сервером потеряна, изменения могут не сохраниться'),
      ).toBeInTheDocument();
    });
  });
});
