import type { Role, TemplateAdminDetails } from '@carbone-reports/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MockRoute } from '../../../test/utils';
import { mockApi, pickOption, popupOptions, renderWithProviders } from '../../../test/utils';
import { adminTemplate } from '../../../test/fixtures';
import { EditorsBlock } from './EditorsBlock';
import { templateKey } from './editorState';

const t = {
  ...adminTemplate,
  ownerId: 'u-owner',
  canDelete: true,
  canManageEditors: true,
} as TemplateAdminDetails;

const people = [
  { id: 'u-admin', login: 'admin', role: 'admin' },
  { id: 'u-owner', login: 'sidorov', role: 'editor' },
  { id: 'u-ed1', login: 'kuznetsov', role: 'editor' },
  { id: 'u-ed2', login: 'popov', role: 'editor' },
  { id: 'u-ed3', login: 'volkov', role: 'editor' },
  { id: 'u-user', login: 'ivanov', role: 'user' },
];

const routes = (
  role: Role,
  editors: { ownerId: string | null; userIds: string[] },
  extra: MockRoute[] = [],
): MockRoute[] => [
  { path: '/api/auth/me', body: { id: `${role}-id`, login: role, role } },
  {
    path: '/api/users/directory',
    handler: ({ url }) => {
      const r = url.searchParams.get('role');
      return { body: r ? people.filter((p) => p.role === r) : people };
    },
  },
  { path: '/api/templates/t1/editors', body: editors },
  ...extra,
];

const block = async () => within(await screen.findByRole('region', { name: 'Редакторы' }));

describe('EditorsBlock', () => {
  it('владелец и выданные редакторы; добавление без владельца и уже выданных; «Сохранить» → PUT', async () => {
    const { calls } = mockApi(
      routes('editor', { ownerId: 'u-owner', userIds: ['u-ed1'] }, [
        {
          method: 'PUT',
          path: '/api/templates/t1/editors',
          handler: ({ body }) => ({ body: { ownerId: 'u-owner', ...(body as object) } }),
        },
      ]),
    );
    renderWithProviders(<EditorsBlock template={t} />);
    const b = await block();
    expect(await b.findByText('sidorov')).toBeInTheDocument();
    expect(await b.findByText('kuznetsov')).toBeInTheDocument();
    expect(b.queryByRole('button', { name: 'Сменить владельца' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/users/directory?role=editor')).toBe(true);

    const combo = b.getByRole('combobox', { name: 'Добавить редактора' });
    const options = (await popupOptions(combo)).map((o) => o.textContent);
    expect(options).toEqual(['popov', 'volkov']);
    await pickOption(combo, 'volkov');
    expect(b.getByText('volkov')).toBeInTheDocument();
    await userEvent.click(b.getByRole('button', { name: 'Убрать kuznetsov' }));
    expect(b.queryByText('kuznetsov')).not.toBeInTheDocument();

    await userEvent.click(b.getByRole('button', { name: 'Сохранить редакторов' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')).toEqual({
        method: 'PUT',
        path: '/api/templates/t1/editors',
        body: { userIds: ['u-ed3'] },
      }),
    );
    expect(await screen.findByText('Редакторы сохранены')).toBeInTheDocument();
  });

  it('без владельца — «не назначен»; без изменений сохранить нельзя', async () => {
    mockApi(routes('editor', { ownerId: null, userIds: [] }));
    renderWithProviders(<EditorsBlock template={{ ...t, ownerId: null }} />);
    const b = await block();
    expect(await b.findByText('не назначен')).toBeInTheDocument();
    expect(b.getByText('редакторов нет')).toBeInTheDocument();
    expect(b.getByRole('button', { name: 'Сохранить редакторов' })).toBeDisabled();
  });

  it('владелец-администратор показан по логину из справочника', async () => {
    mockApi(routes('admin', { ownerId: 'u-admin', userIds: [] }));
    renderWithProviders(<EditorsBlock template={{ ...t, ownerId: 'u-admin' }} />);
    const b = await block();
    expect(await b.findByText('admin')).toBeInTheDocument();
  });

  it('ошибка API показывается', async () => {
    mockApi(
      routes('editor', { ownerId: 'u-owner', userIds: [] }, [
        {
          method: 'PUT',
          path: '/api/templates/t1/editors',
          status: 400,
          body: {
            error: {
              code: 'BAD_REQUEST',
              message: 'можно выдать только пользователю с ролью «Редактор»',
            },
          },
        },
      ]),
    );
    renderWithProviders(<EditorsBlock template={t} />);
    const b = await block();
    await b.findByText('sidorov');
    await pickOption(b.getByRole('combobox', { name: 'Добавить редактора' }), 'popov');
    await userEvent.click(b.getByRole('button', { name: 'Сохранить редакторов' }));
    expect(
      await b.findByText('можно выдать только пользователю с ролью «Редактор»'),
    ).toBeInTheDocument();
  });

  it('admin: «Сменить владельца» → PUT owner и обновление шаблона', async () => {
    const { calls } = mockApi(
      routes('admin', { ownerId: 'u-owner', userIds: ['u-ed1'] }, [
        {
          method: 'PUT',
          path: '/api/templates/t1/owner',
          handler: ({ body }) => ({
            body: { ownerId: (body as { userId: string }).userId, userIds: [] },
          }),
        },
        { path: '/api/templates/t1', body: { ...t, ownerId: 'u-ed1' } },
      ]),
    );
    const { queryClient } = renderWithProviders(<EditorsBlock template={t} />);
    queryClient.setQueryData(templateKey('t1'), t);
    const b = await block();
    await b.findByText('kuznetsov');
    const change = b.getByRole('button', { name: 'Сменить владельца' });
    expect(change).toBeDisabled();
    const combo = b.getByRole('combobox', { name: 'Новый владелец' });
    const options = (await popupOptions(combo)).map((o) => o.textContent);
    expect(options).toEqual(['kuznetsov', 'popov', 'volkov']);
    await pickOption(combo, 'kuznetsov');
    await userEvent.click(change);
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')).toEqual({
        method: 'PUT',
        path: '/api/templates/t1/owner',
        body: { userId: 'u-ed1' },
      }),
    );
    expect(await screen.findByText('Владелец изменён')).toBeInTheDocument();
    await waitFor(() =>
      expect(queryClient.getQueryState(templateKey('t1'))?.isInvalidated).toBe(true),
    );
    // Новый владелец ушёл из списка редакторов.
    expect(b.getByText('редакторов нет')).toBeInTheDocument();
  });
});
