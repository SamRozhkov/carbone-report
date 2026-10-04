import type { TemplateAdminDetails } from '@carbone-reports/shared';
import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '../../../test/utils';
import { SettingsTab } from './SettingsTab';
import { adminTemplate } from '../../../test/fixtures';

const t = adminTemplate as TemplateAdminDetails;

describe('SettingsTab', () => {
  it('сохраняет название и описание', async () => {
    const { calls } = mockApi([
      {
        path: '/api/datasources',
        body: [
          {
            id: 'd1',
            name: 'Склад',
            host: 'h',
            port: 5432,
            database: 'd',
            username: 'u',
            ssl: false,
            createdAt: '',
          },
        ],
      },
      {
        method: 'PATCH',
        path: '/api/templates/t1',
        handler: ({ body }) => ({ body: { ...t, ...(body as object) } }),
      },
    ]);
    renderWithProviders(<SettingsTab template={t} />);
    const name = await screen.findByLabelText('Название шаблона');
    await userEvent.clear(name);
    await userEvent.type(name, 'Счёт-фактура');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({
      name: 'Счёт-фактура',
      description: 'Счёт на оплату',
      datasourceId: 'd1',
      defaultOutput: 'pdf',
    });
  });

  it('замена файла → PUT multipart', async () => {
    const { calls } = mockApi([
      { path: '/api/datasources', body: [] },
      { method: 'PUT', path: '/api/templates/t1/file', body: { ...t, version: 4 } },
    ]);
    renderWithProviders(<SettingsTab template={t} />);
    await userEvent.upload(
      await screen.findByLabelText('Новый файл шаблона'),
      new File(['PK'], 'new.docx'),
    );
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(
      ((calls.find((c) => c.method === 'PUT')!.body as FormData).get('file') as File).name,
    ).toBe('new.docx');
    expect(await screen.findByText(/версия 4/)).toBeInTheDocument();
  });

  it('грязное название сохраняется при обновлении шаблона', async () => {
    mockApi([{ path: '/api/datasources', body: [] }]);
    const next = { ...t, name: 'Новое', updatedAt: '2026-02-01T00:00:00Z' };
    function Harness() {
      const [tpl, setTpl] = useState(t);
      return (
        <>
          <button onClick={() => setTpl(next)}>refresh</button>
          <SettingsTab template={tpl} />
        </>
      );
    }
    renderWithProviders(<Harness />);
    await userEvent.type(await screen.findByLabelText('Название шаблона'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'refresh' }));
    expect(screen.getByLabelText('Название шаблона')).toHaveValue('Счёт!');
    expect(screen.getByText(/Шаблон изменился на сервере/)).toBeInTheDocument();
  });
});
