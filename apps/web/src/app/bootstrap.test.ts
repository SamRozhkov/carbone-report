import { settings } from '@gravity-ui/date-utils';
import { describe, expect, it, vi } from 'vitest';
import { currentLocale, defaultLocale } from '../i18n';
import { mockApi } from '../test/utils';
import { initLocale } from './bootstrap';

const anon = {
  path: '/api/auth/me',
  status: 401,
  body: { error: { code: 'UNAUTHORIZED', message: 'требуется вход' } },
};
const browser = (langs: string[]) => vi.spyOn(navigator, 'languages', 'get').mockReturnValue(langs);

describe('initLocale: язык при старте (§44.1)', () => {
  it('me.locale = fr → fr', async () => {
    browser(['de-AT', 'en']);
    mockApi([
      { path: '/api/auth/me', body: { id: 'u', login: 'u', role: 'user', locale: 'fr' } },
      { path: '/api/i18n', body: { defaultLocale: 'ru' } },
    ]);
    const me = await initLocale();
    expect(me).toMatchObject({ locale: 'fr' });
    expect(currentLocale()).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');
    expect(settings.getLocale()).toBe('fr');
  });

  it('me.locale = null, браузер de-AT → de', async () => {
    browser(['de-AT', 'en']);
    mockApi([
      { path: '/api/auth/me', body: { id: 'u', login: 'u', role: 'user', locale: null } },
      { path: '/api/i18n', body: { defaultLocale: 'ru' } },
    ]);
    await initLocale();
    expect(currentLocale()).toBe('de');
  });

  it('до входа cr.locale = es выше браузера', async () => {
    browser(['de-AT', 'en']);
    localStorage.setItem('cr.locale', 'es');
    mockApi([anon, { path: '/api/i18n', body: { defaultLocale: 'ru' } }]);
    await expect(initLocale()).resolves.toBeNull();
    expect(currentLocale()).toBe('es');
  });

  it('всё неизвестно → defaultLocale из /api/i18n', async () => {
    browser(['ja', 'xx']);
    mockApi([anon, { path: '/api/i18n', body: { defaultLocale: 'pt-BR' } }]);
    await initLocale();
    expect(defaultLocale()).toBe('pt-BR');
    expect(currentLocale()).toBe('pt-BR');
    expect(settings.getLocale()).toBe('pt-br');
  });

  it('/api/i18n недоступен (503) → браузер, иначе ru; запуск не блокируется', async () => {
    browser(['ja']);
    mockApi([
      anon,
      { path: '/api/i18n', status: 503, body: { error: { code: 'INTERNAL', message: 'x' } } },
    ]);
    await initLocale();
    expect(currentLocale()).toBe('ru');
  });

  it('сбой загрузки локали дат не бросает исключение', async () => {
    browser(['en']);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(settings, 'loadLocale').mockRejectedValue(new Error('chunk 404'));
    mockApi([anon, { path: '/api/i18n', body: { defaultLocale: 'ru' } }]);
    await expect(initLocale()).resolves.toBeNull();
    expect(currentLocale()).toBe('en');
    expect(err).toHaveBeenCalled();
  });
});
