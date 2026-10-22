import type { Role } from '@carbone-reports/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { mockApi, pickOption, renderRoute } from '../test/utils';
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

describe('Layout: язык интерфейса (§44.1)', () => {
  it('выбор в меню меняет подписи, <html lang> и сохраняется у пользователя', async () => {
    const { calls } = mockApi([
      meAs('admin'),
      { path: '/api/templates', body: [] },
      { method: 'PUT', path: '/api/me/locale', status: 204 },
    ]);
    renderRoute('/reports');
    await pickOption(await screen.findByRole('button', { name: 'Язык' }), 'Deutsch');
    expect(await screen.findByText('Berichte')).toBeInTheDocument();
    expect(screen.getByText('Datenquellen')).toBeInTheDocument();
    expect(screen.queryByText('Моя подпись')).not.toBeInTheDocument();
    expect(document.documentElement.lang).toBe('de');
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/me/locale', body: { locale: 'de' } },
    ]);

    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-CA']);
    await pickOption(screen.getByRole('button', { name: 'Sprache' }), 'Wie im Browser');
    expect(await screen.findByText('Rapports')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'PUT').at(-1)).toEqual({
      method: 'PUT',
      path: '/api/me/locale',
      body: { locale: null },
    });
    // Два выбора в списке на полном маршруте — дольше стандартных 5 с на загруженном раннере.
  }, 15_000);

  it('выбор со страницы входа виден в меню; «Как в браузере» сбрасывает его (I1)', async () => {
    localStorage.setItem('cr.locale', 'es');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-AT']);
    // Как после входа: LocaleSync применил выбор со страницы входа (me.locale = null).
    await changeLocale('es', { persist: 'none' });
    const { calls } = mockApi([
      { path: '/api/auth/me', body: { id: 'u', login: 'u', role: 'user', locale: null } },
      { path: '/api/templates', body: [] },
      { method: 'PUT', path: '/api/me/locale', status: 204 },
    ]);
    renderRoute('/reports');
    const item = await screen.findByRole('button', { name: 'Idioma' });
    await userEvent.click(item);
    const popup = await waitFor(() => {
      const el = document.getElementById(item.getAttribute('aria-controls') ?? '');
      if (!el) throw new Error('список не открыт');
      return el;
    });
    expect(within(popup).getByRole('option', { name: 'Español', hidden: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await pickOption(item, 'Según el navegador');
    expect(await screen.findByText('Berichte')).toBeInTheDocument();
    expect(localStorage.getItem('cr.locale')).toBeNull();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/me/locale', body: { locale: null } },
    ]);
  }, 15_000);

  it('пункт «Язык» работает с клавиатуры (I2)', async () => {
    const { calls } = mockApi([
      meAs('user'),
      { path: '/api/templates', body: [] },
      { method: 'PUT', path: '/api/me/locale', status: 204 },
    ]);
    renderRoute('/reports');
    const item = await screen.findByRole('button', { name: 'Язык' });
    item.focus();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(item).toHaveAttribute('aria-expanded', 'true'));
    // Активен выбранный пункт «Как в браузере»; вниз: Русский, English.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(await screen.findByText('Reports')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/me/locale', body: { locale: 'en' } },
    ]);
  }, 15_000);
});
