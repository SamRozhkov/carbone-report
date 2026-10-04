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
  });

  it('возврат на вкладку «Документ» посылает resize, редактор остаётся смонтированным', async () => {
    mockApi([
      adminMe,
      { path: '/api/templates/t1', body: adminTemplate },
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
  });
});
