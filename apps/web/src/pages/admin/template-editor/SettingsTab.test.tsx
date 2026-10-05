import type { TemplateAdminDetails } from '@carbone-reports/shared';
import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MockRoute } from '../../../test/utils';
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
            sslMode: 'disable',
            sslCa: null,
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

  describe('раздел «Доступ»', () => {
    const groups = [
      { id: 'g1', name: 'Бухгалтерия', description: '', memberIds: [], createdAt: '' },
      { id: 'g2', name: 'Логистика', description: '', memberIds: [], createdAt: '' },
    ];
    const categories = [
      {
        id: 'c1',
        name: 'Финансы',
        sortOrder: 1,
        public: false,
        groupIds: ['g1'],
        templateCount: 1,
      },
      { id: 'c2', name: 'Общие', sortOrder: 2, public: true, groupIds: [], templateCount: 0 },
      { id: 'c3', name: 'Черновики', sortOrder: 3, public: false, groupIds: [], templateCount: 0 },
    ];
    const WARNING = 'Шаблон сейчас доступен только администраторам';
    const DIRTY_WARNING = 'После сохранения шаблон будет доступен только администраторам';
    const routes = (access: object): MockRoute[] => [
      { path: '/api/datasources', body: [] },
      { path: '/api/groups', body: groups },
      { path: '/api/categories', body: categories },
      { path: '/api/templates/t1/access', body: access },
      {
        method: 'PUT',
        path: '/api/templates/t1/access',
        handler: ({ body }) => ({ body }),
      },
    ];
    const section = async () => within(await screen.findByRole('region', { name: 'Доступ' }));

    it('закрытый шаблон без групп: предупреждение; выбор группы убирает его и сохраняется', async () => {
      const { calls } = mockApi(routes({ public: false, categoryId: null, groupIds: [] }));
      renderWithProviders(<SettingsTab template={t} />);
      const s = await section();
      expect(await s.findByText(WARNING)).toBeInTheDocument();
      expect(s.getByRole('group', { name: 'Группы' })).toBeInTheDocument();
      await userEvent.click(s.getByRole('combobox', { name: 'Группы' }));
      await userEvent.click(await screen.findByRole('option', { name: 'Логистика' }));
      expect(s.queryByText(WARNING)).not.toBeInTheDocument();
      await userEvent.click(s.getByRole('button', { name: 'Сохранить доступ' }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === 'PUT')).toEqual({
          method: 'PUT',
          path: '/api/templates/t1/access',
          body: { public: false, categoryId: null, groupIds: ['g2'] },
        }),
      );
    });

    it('флажок «Доступно всем» убирает предупреждение', async () => {
      mockApi(routes({ public: false, categoryId: null, groupIds: [] }));
      renderWithProviders(<SettingsTab template={t} />);
      const s = await section();
      await s.findByText(WARNING);
      expect(s.getByRole('group', { name: 'Видимость' })).toBeInTheDocument();
      await userEvent.click(s.getByRole('checkbox', { name: 'Доступно всем' }));
      expect(s.queryByText(WARNING)).not.toBeInTheDocument();
    });

    it('категория с группами или «доступно всем» открывает шаблон, пустая — нет', async () => {
      const { calls } = mockApi(routes({ public: false, categoryId: 'c1', groupIds: [] }));
      renderWithProviders(<SettingsTab template={t} />);
      const s = await section();
      const combo = await s.findByRole('combobox', { name: 'Категория' });
      await waitFor(() => expect(combo).toHaveTextContent('Финансы'));
      expect(s.queryByText(WARNING)).not.toBeInTheDocument();

      await userEvent.click(combo);
      await userEvent.click(await screen.findByRole('option', { name: 'Черновики' }));
      expect(await s.findByText(DIRTY_WARNING)).toBeInTheDocument();
      expect(s.queryByText(WARNING)).not.toBeInTheDocument();

      await userEvent.click(combo);
      await userEvent.click(await screen.findByRole('option', { name: 'Общие' }));
      expect(s.queryByText(WARNING)).not.toBeInTheDocument();

      await userEvent.click(combo);
      await userEvent.click(await screen.findByRole('option', { name: 'Без категории' }));
      expect(await s.findByText(DIRTY_WARNING)).toBeInTheDocument();

      await userEvent.click(s.getByRole('button', { name: 'Сохранить доступ' }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
          public: false,
          categoryId: null,
          groupIds: [],
        }),
      );
      // После сохранения форма чиста: предупреждение снова про текущее состояние.
      expect(await s.findByText(WARNING)).toBeInTheDocument();
      expect(s.queryByText(DIRTY_WARNING)).not.toBeInTheDocument();
    });

    it('доступный шаблон: предупреждения нет, поля заполнены', async () => {
      mockApi(routes({ public: true, categoryId: null, groupIds: ['g1'] }));
      renderWithProviders(<SettingsTab template={t} />);
      const s = await section();
      await waitFor(() => expect(s.getByRole('checkbox', { name: 'Доступно всем' })).toBeChecked());
      expect(s.getByRole('combobox', { name: 'Группы' })).toHaveTextContent('Бухгалтерия');
      expect(s.queryByText(WARNING)).not.toBeInTheDocument();
    });
  });
});
