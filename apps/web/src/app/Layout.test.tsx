import type { Role } from '@carbone-reports/shared';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderRoute } from '../test/utils';
import { permissionsOf } from './permissions';

const meAs = (role: Role) => ({
  path: '/api/auth/me',
  body: { id: `${role}-id`, login: role, role },
});

const COMMON = ['Отчёты', 'История', 'Моя подпись'];
const ALL = [
  'Шаблоны',
  'Источники данных',
  'Пользователи',
  'Группы',
  'Категории',
  'Доступ к отчётам',
  'Справка по шаблонам',
];

/** Пункты меню раздела администрирования по ролям. */
const MENU: Record<Role, string[]> = {
  admin: [
    'Шаблоны',
    'Источники данных',
    'Пользователи',
    'Группы',
    'Категории',
    'Доступ к отчётам',
    'Справка по шаблонам',
  ],
  editor: ['Шаблоны', 'Справка по шаблонам'],
  access_manager: ['Группы', 'Категории', 'Доступ к отчётам'],
  user: [],
};

describe('permissionsOf', () => {
  it.each([
    ['admin', { isAdmin: true, canAuthor: true, canManageAccess: true }],
    ['editor', { isAdmin: false, canAuthor: true, canManageAccess: false }],
    ['access_manager', { isAdmin: false, canAuthor: false, canManageAccess: true }],
    ['user', { isAdmin: false, canAuthor: false, canManageAccess: false }],
    [undefined, { isAdmin: false, canAuthor: false, canManageAccess: false }],
  ] as const)('%s', (role, expected) => {
    expect(permissionsOf(role)).toEqual(expected);
  });
});

describe('Layout: меню по ролям (§43.5)', () => {
  it.each(Object.keys(MENU) as Role[])('%s', async (role) => {
    mockApi([meAs(role), { path: '/api/templates', body: [] }]);
    renderRoute('/reports');
    expect(await screen.findByText('Моя подпись')).toBeInTheDocument();
    for (const title of COMMON) expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    for (const title of ALL) {
      if (MENU[role].includes(title)) expect(screen.getByText(title)).toBeInTheDocument();
      else expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
  });
});

describe('Маршруты /admin по ролям', () => {
  it.each([
    ['editor', '/admin', '/admin/templates'],
    ['editor', '/admin/users', '/reports'],
    ['editor', '/admin/datasources', '/reports'],
    ['editor', '/admin/groups', '/reports'],
    ['access_manager', '/admin', '/admin/groups'],
    ['access_manager', '/admin/templates', '/reports'],
    ['access_manager', '/admin/help', '/reports'],
    ['access_manager', '/admin/users', '/reports'],
    ['access_manager', '/admin/categories', '/admin/categories'],
    ['access_manager', '/admin/access', '/admin/access'],
    ['editor', '/admin/access', '/reports'],
    ['user', '/admin/access', '/reports'],
    ['user', '/admin', '/reports'],
    ['user', '/admin/groups', '/reports'],
  ] as const)('%s: %s → %s', async (role, from, to) => {
    mockApi([
      meAs(role),
      { path: '/api/templates', body: [] },
      { path: '/api/groups', body: [] },
      { path: '/api/categories', body: [] },
    ]);
    const { router } = renderRoute(from);
    await waitFor(() => expect(router.state.location.pathname).toBe(to));
  });
});
