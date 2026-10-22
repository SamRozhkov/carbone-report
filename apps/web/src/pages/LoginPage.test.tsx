import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { initLocale } from '../app/bootstrap';
import { currentLocale } from '../i18n';
import { mockApi, pickOption, renderRoute } from '../test/utils';

const anon = {
  path: '/api/auth/me',
  status: 401,
  body: { error: { code: 'UNAUTHORIZED', message: 'требуется вход' } },
};

describe('LoginPage: язык (§44.1)', () => {
  it('язык браузера de-AT даёт de', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-AT', 'en']);
    mockApi([anon, { path: '/api/i18n', body: { defaultLocale: 'ru' } }]);
    await initLocale();
    renderRoute('/login');
    expect(await screen.findByRole('combobox', { name: 'Sprache' })).toHaveTextContent(
      'Wie im Browser',
    );
    expect(currentLocale()).toBe('de');
  });

  it('выбор пишется в localStorage, PUT не вызывается', async () => {
    const { calls } = mockApi([anon, { method: 'PUT', path: '/api/me/locale', status: 204 }]);
    renderRoute('/login');
    await pickOption(await screen.findByRole('combobox', { name: 'Язык' }), 'Español');
    expect(await screen.findByRole('combobox', { name: 'Idioma' })).toHaveTextContent('Español');
    expect(localStorage.getItem('cr.locale')).toBe('es');
    expect(document.documentElement.lang).toBe('es');
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);

    await pickOption(screen.getByRole('combobox', { name: 'Idioma' }), 'Según el navegador');
    expect(localStorage.getItem('cr.locale')).toBeNull();
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });
});
