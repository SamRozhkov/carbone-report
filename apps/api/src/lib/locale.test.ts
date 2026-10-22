import { describe, expect, it } from 'vitest';
import { createFastify } from '../app';
import { parseAcceptLanguage, registerRequestLocale, requestLocale } from './locale';

const req = (headers: Record<string, string | string[]>, url = '/api/x') => ({ headers, url });

describe('requestLocale', () => {
  it('X-Locale из LOCALES — главнее Accept-Language', () => {
    expect(requestLocale(req({ 'x-locale': 'en', 'accept-language': 'de' }), 'ru')).toBe('en');
    expect(requestLocale(req({ 'x-locale': 'pt-BR' }), 'ru')).toBe('pt-BR');
  });

  it('неизвестный X-Locale — дальше по Accept-Language', () => {
    expect(
      requestLocale(req({ 'x-locale': 'xx', 'accept-language': 'de-CH,de;q=0.9,en;q=0.5' }), 'ru'),
    ).toBe('de');
  });

  it('основной подтег: pt-PT → pt-BR, zh-TW → zh-CN', () => {
    expect(requestLocale(req({ 'accept-language': 'pt-PT' }), 'ru')).toBe('pt-BR');
    expect(requestLocale(req({ 'accept-language': 'zh-TW,zh;q=0.9' }), 'ru')).toBe('zh-CN');
  });

  it('без заголовков — язык по умолчанию', () => {
    expect(requestLocale(req({}), 'ru')).toBe('ru');
    expect(requestLocale(req({}), 'fr')).toBe('fr');
    expect(requestLocale(req({ 'accept-language': 'ja,ko;q=0.5' }), 'en')).toBe('en');
  });

  it('Accept-Language по убыванию q, при равных q — по порядку', () => {
    expect(requestLocale(req({ 'accept-language': 'en;q=0.3, fr;q=0.8, de;q=0.5' }), 'ru')).toBe(
      'fr',
    );
    expect(requestLocale(req({ 'accept-language': 'es, en' }), 'ru')).toBe('es');
  });

  it('* и q=0 не учитываются', () => {
    expect(requestLocale(req({ 'accept-language': '*, en;q=0.1' }), 'ru')).toBe('en');
    expect(requestLocale(req({ 'accept-language': 'en;q=0, *' }), 'de')).toBe('de');
  });

  it('/internal/* — всегда язык по умолчанию', () => {
    expect(
      requestLocale(req({ 'x-locale': 'en', 'accept-language': 'de' }, '/internal/x'), 'ru'),
    ).toBe('ru');
  });
});

describe('parseAcceptLanguage', () => {
  it('теги по убыванию q, без * и q=0', () => {
    expect(parseAcceptLanguage('de-CH,de;q=0.9,en;q=0.5,*;q=0.1,fr;q=0')).toEqual([
      'de-CH',
      'de',
      'en',
    ]);
    expect(parseAcceptLanguage(' en ; q=0.2 , es ')).toEqual(['es', 'en']);
    expect(parseAcceptLanguage('')).toEqual([]);
    expect(parseAcceptLanguage('en;q=abc')).toEqual([]);
  });
});

describe('registerRequestLocale', () => {
  it('ставит req.locale каждому запросу', async () => {
    const app = createFastify();
    registerRequestLocale(app, 'de');
    app.get('/api/l', async (r) => ({ locale: r.locale }));
    await app.ready();
    const noHeader = await app.inject({ method: 'GET', url: '/api/l' });
    expect(noHeader.json()).toEqual({ locale: 'de' });
    const en = await app.inject({ method: 'GET', url: '/api/l', headers: { 'x-locale': 'en' } });
    expect(en.json()).toEqual({ locale: 'en' });
    await app.close();
  });
});
