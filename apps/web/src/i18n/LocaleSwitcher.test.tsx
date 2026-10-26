import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { adminMe, mockApi, pickOption, popupOptions, renderWithProviders } from '../test/utils';
import { LocaleSwitcher } from './LocaleSwitcher';
import { catalogChunks, currentLocale, i18n } from '.';

describe('LocaleSwitcher', () => {
  it('список: «Как в браузере» и самоназвания языков', async () => {
    renderWithProviders(<LocaleSwitcher persist="local" />);
    const combo = screen.getByRole('combobox', { name: 'Язык' });
    expect(combo).toHaveTextContent('Как в браузере');
    const options = await popupOptions(combo);
    expect(options.map((o) => o.textContent)).toEqual([
      'Как в браузере',
      'Русский',
      'English',
      'Español',
      'Português (Brasil)',
      'Français',
      'Deutsch',
      '简体中文',
    ]);
  });

  it('сбой загрузки чанка: язык прежний, тост с ошибкой, ключей на экране нет', async () => {
    i18n.removeResourceBundle('fr', 'common');
    vi.spyOn(catalogChunks, 'load').mockRejectedValue(new Error('chunk 404'));
    const { calls } = mockApi([adminMe, { method: 'PUT', path: '/api/me/locale', status: 204 }]);
    renderWithProviders(<LocaleSwitcher persist="server" />);
    await pickOption(screen.getByRole('combobox', { name: 'Язык' }), 'Français');
    const toast = await screen.findByText('Не удалось загрузить язык');
    expect(within(toast.closest('.g-toast') ?? document.body).getByText('chunk 404')).toBeTruthy();
    expect(currentLocale()).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
    expect(document.body.textContent).not.toMatch(/common:|locale\./);
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('сбой сохранения: язык сменился, тост с ошибкой сервера', async () => {
    mockApi([
      adminMe,
      {
        method: 'PUT',
        path: '/api/me/locale',
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'internal error' } },
      },
    ]);
    renderWithProviders(<LocaleSwitcher persist="server" />);
    await pickOption(screen.getByRole('combobox', { name: 'Язык' }), 'English');
    expect(await screen.findByText('Could not save the language choice')).toBeInTheDocument();
    expect(screen.getByText('internal error')).toBeInTheDocument();
    expect(currentLocale()).toBe('en');
  });
});
