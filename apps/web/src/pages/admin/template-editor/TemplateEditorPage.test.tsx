import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { adminTemplate } from '../../../test/fixtures';
import { adminMe, mockApi, renderRoute } from '../../../test/utils';

vi.mock('@onlyoffice/document-editor-react', () => ({
  DocumentEditor: () => <div data-testid="oo" />,
}));

describe('TemplateEditorPage', () => {
  it('шапка с версией, ошибка последнего сохранения, вкладки в URL', async () => {
    mockApi([
      adminMe,
      {
        path: '/api/templates/t1',
        body: { ...adminTemplate, lastSaveError: 'OnlyOffice не смог сохранить документ' },
      },
      { path: '/api/datasources', body: [] },
    ]);
    const { router } = renderRoute('/admin/templates/t1?tab=settings');
    expect(await screen.findByText('Счёт')).toBeInTheDocument();
    expect(screen.getByText('версия 3')).toBeInTheDocument();
    expect(screen.getByText('OnlyOffice не смог сохранить документ')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Параметры' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=params'));
    await userEvent.click(screen.getByRole('tab', { name: 'Графики' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=charts'));
    expect(await screen.findByRole('button', { name: 'Добавить график' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'PDF' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=pdf'));
    expect(await screen.findByRole('button', { name: 'Загрузить PDF' })).toBeInTheDocument();
  });

  it('возврат на вкладку «Документ» посылает resize, редактор остаётся смонтированным', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/templates/t1', body: adminTemplate },
      { method: 'POST', path: '/api/templates/t1/edit-lock', body: { state: 'mine' } },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
      {
        path: '/api/templates/t1/editor-config',
        body: {
          document: { fileType: 'docx', key: 'k1', title: 'x.docx', url: 'http://x' },
          documentType: 'word',
          editorConfig: {},
        },
      },
      { path: '/api/datasources', body: [] },
    ]);
    renderRoute('/admin/templates/t1?tab=document');
    const editor = await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('tab', { name: 'Параметры' }));
    expect(editor).toBeInTheDocument();
    const onResize = vi.fn();
    window.addEventListener('resize', onResize);
    await userEvent.click(screen.getByRole('tab', { name: 'Документ' }));
    try {
      await waitFor(() => expect(onResize).toHaveBeenCalled());
    } finally {
      window.removeEventListener('resize', onResize);
    }
    expect(screen.getByTestId('oo')).toBe(editor);
    // Переключение вкладок блокировку не снимает: DocumentTab остаётся смонтированным.
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('?full=1 открывает развёрнутый режим; смена вкладки убирает full из адреса', async () => {
    mockApi([
      adminMe,
      { path: '/api/templates/t1', body: adminTemplate },
      { method: 'POST', path: '/api/templates/t1/edit-lock', body: { state: 'mine' } },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
      {
        path: '/api/templates/t1/editor-config',
        body: {
          document: { fileType: 'docx', key: 'k1', title: 'x.docx', url: 'http://x' },
          documentType: 'word',
          editorConfig: {},
        },
      },
      { path: '/api/datasources', body: [] },
    ]);
    const { router, container } = renderRoute('/admin/templates/t1?tab=document&full=1');
    await screen.findByTestId('oo');
    expect(container.querySelector('.cr-doc-full')).not.toBeNull();
    const doc = () => container.querySelector('.cr-doc-bar') as HTMLElement;
    await userEvent.click(within(doc()).getByRole('button', { name: 'Свернуть' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=document'));
    await waitFor(() => expect(container.querySelector('.cr-doc-full')).toBeNull());
    await userEvent.click(within(doc()).getByRole('button', { name: 'Развернуть' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=document&full=1'));
    await waitFor(() => expect(container.querySelector('.cr-doc-full')).not.toBeNull());
    await userEvent.click(screen.getByRole('tab', { name: 'Данные' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=data'));
    await waitFor(() => expect(container.querySelector('.cr-doc-full')).toBeNull());
  });

  it('«Документ» → «Настройки» → замена файла: запрос несёт holder вкладки «Документ», редактор перечитывает конфиг', async () => {
    let key = 'k1';
    const { calls } = mockApi([
      adminMe,
      { path: '/api/templates/t1', body: adminTemplate },
      { method: 'POST', path: '/api/templates/t1/edit-lock', body: { state: 'mine' } },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
      {
        method: 'PUT',
        path: '/api/templates/t1/file',
        handler: () => {
          key = 'k2';
          return { body: { ...adminTemplate, version: adminTemplate.version + 1 } };
        },
      },
      {
        path: '/api/templates/t1/editor-config',
        handler: () => ({
          body: {
            document: { fileType: 'docx', key, title: 'x.docx', url: 'http://x' },
            documentType: 'word',
            editorConfig: {},
          },
        }),
      },
      { path: '/api/datasources', body: [] },
    ]);
    renderRoute('/admin/templates/t1?tab=document');
    await screen.findByTestId('oo');
    await userEvent.click(screen.getByRole('tab', { name: 'Настройки' }));
    await userEvent.upload(
      await screen.findByLabelText('Новый файл шаблона'),
      new File(['PK'], 'new.docx'),
    );
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const lockCall = calls.find((c) => c.path === '/api/templates/t1/edit-lock')!;
    const holder = (lockCall.body as { holder: string }).holder;
    expect(calls.find((c) => c.method === 'PUT')!.path).toBe(
      `/api/templates/t1/file?holder=${holder}`,
    );
    // Версия выросла: DocumentTab перечитывает конфиг, блокировка не снималась.
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path.startsWith('/api/templates/t1/editor-config')),
      ).toHaveLength(2),
    );
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('страница открыта на «Настройках»: блокировка не берётся, замена файла без holder', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/templates/t1', body: adminTemplate },
      { method: 'PUT', path: '/api/templates/t1/file', body: adminTemplate },
      { path: '/api/datasources', body: [] },
    ]);
    renderRoute('/admin/templates/t1?tab=settings');
    await userEvent.upload(
      await screen.findByLabelText('Новый файл шаблона'),
      new File(['PK'], 'new.docx'),
    );
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.path).toBe('/api/templates/t1/file');
    expect(calls.some((c) => c.path.includes('/edit-lock'))).toBe(false);
  });
});
