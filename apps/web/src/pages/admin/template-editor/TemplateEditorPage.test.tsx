import { screen, waitFor } from '@testing-library/react';
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
});
