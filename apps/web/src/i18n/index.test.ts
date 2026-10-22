import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../test/utils';
import { catalogChunks, changeLocale, currentLocale, i18n, pickLocale, setDefaultLocale } from '.';

const browser = (langs: string[]) => vi.spyOn(navigator, 'languages', 'get').mockReturnValue(langs);

afterEach(() => setDefaultLocale('ru'));

describe('pickLocale (§44.1)', () => {
  const base = { stored: null, browser: [] as string[], defaultLocale: 'ru' as const };
  it('выбор пользователя выше всего', () => {
    expect(pickLocale({ ...base, me: { locale: 'fr' }, stored: 'es', browser: ['de'] })).toBe('fr');
  });
  it('без выбора — первый язык браузера с каталогом', () => {
    expect(pickLocale({ ...base, me: { locale: null }, browser: ['de-AT', 'en'] })).toBe('de');
  });
  it('выбор на странице входа выше браузера', () => {
    expect(pickLocale({ ...base, me: null, stored: 'es', browser: ['de-AT', 'en'] })).toBe('es');
  });
  it('ничего не известно — язык по умолчанию', () => {
    expect(pickLocale({ me: null, stored: null, browser: ['xx', 'ja'], defaultLocale: 'fr' })).toBe(
      'fr',
    );
  });
});

describe('changeLocale', () => {
  it('грузит каталог языка, меняет подписи и <html lang>', async () => {
    await changeLocale('de', { persist: 'none' });
    expect(i18n.t('common:nav.reports')).toBe('Berichte');
    expect(document.documentElement.lang).toBe('de');
    await changeLocale('zh-CN', { persist: 'none' });
    expect(i18n.t('common:role.editor')).toBe('编辑者');
  });

  it('persist local пишет cr.locale; null — удаляет', async () => {
    await changeLocale('fr', { persist: 'local' });
    expect(localStorage.getItem('cr.locale')).toBe('fr');
    browser(['en-GB']);
    await changeLocale(null, { persist: 'local' });
    expect(localStorage.getItem('cr.locale')).toBeNull();
    expect(currentLocale()).toBe('en');
  });

  it('persist server → PUT /api/me/locale', async () => {
    const { calls } = mockApi([{ method: 'PUT', path: '/api/me/locale', status: 204 }]);
    await changeLocale('es', { persist: 'server' });
    expect(calls).toEqual([{ method: 'PUT', path: '/api/me/locale', body: { locale: 'es' } }]);
  });

  it('сбой загрузки чанка: язык прежний, ошибка наружу, PUT не уходит', async () => {
    // fr мог загрузиться в предыдущих тестах — сбрасываем, чтобы загрузка пошла через чанк.
    i18n.removeResourceBundle('fr', 'common');
    vi.spyOn(catalogChunks, 'load').mockRejectedValue(new Error('chunk 404'));
    const { calls } = mockApi([{ method: 'PUT', path: '/api/me/locale', status: 204 }]);
    await expect(changeLocale('fr', { persist: 'server' })).rejects.toThrow('chunk 404');
    expect(currentLocale()).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
    expect(i18n.t('common:nav.reports')).toBe('Отчёты');
    expect(calls).toEqual([]);
  });
});
