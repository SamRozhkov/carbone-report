import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminTemplate } from '../../../test/fixtures';
import { adminMe, mockApi, renderRoute } from '../../../test/utils';

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
});
