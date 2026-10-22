import { describe, expect, it } from 'vitest';
import { LOCALES, LOCALE_NAMES, Locale, NAMESPACES, isLocale, resolveLocale, zodLocale } from '.';
import { createTranslator, resources } from './server';

describe('LOCALES', () => {
  it('семь языков с самоназваниями', () => {
    expect(LOCALES).toEqual(['ru', 'en', 'es', 'pt-BR', 'fr', 'de', 'zh-CN']);
    expect(LOCALE_NAMES['pt-BR']).toBe('Português (Brasil)');
    expect(LOCALE_NAMES['zh-CN']).toBe('简体中文');
    expect(Locale.safeParse('de').success).toBe(true);
    expect(Locale.safeParse('it').success).toBe(false);
  });

  it('isLocale', () => {
    expect(isLocale('pt-BR')).toBe(true);
    expect(isLocale('pt')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it('каталоги всех языков и пространств имён загружены', () => {
    for (const l of LOCALES)
      expect(Object.keys(resources[l]).sort()).toEqual([...NAMESPACES].sort());
  });
});

describe('resolveLocale (§44.1)', () => {
  it.each([
    [['de-AT', 'en'], 'ru', 'de'],
    [['pt-PT'], 'ru', 'pt-BR'],
    [['zh-TW'], 'ru', 'zh-CN'],
    [['zh-HK'], 'ru', 'zh-CN'],
    [['zh-Hant-HK'], 'ru', 'zh-CN'],
    [['en-GB'], 'ru', 'en'],
    [['it', 'ja'], 'ru', 'ru'],
    [['it', 'ja'], 'en', 'en'],
    [['PT-br'], 'ru', 'pt-BR'],
    [['fr-CA', 'de'], 'ru', 'fr'],
    [['', 'es'], 'ru', 'es'],
    [[], 'de', 'de'],
  ] as const)('%j → %s', (candidates, fallback, expected) => {
    expect(resolveLocale(candidates, fallback)).toBe(expected);
  });
});

describe('createTranslator', () => {
  it('роли', () => {
    expect(createTranslator('en')('common:role.editor')).toBe('Editor');
    expect(createTranslator('ru')('common:role.access_manager')).toBe('Менеджер безопасности');
  });

  it('пространство имён по умолчанию — common', () => {
    expect(createTranslator('de')('action.save')).toBe('Speichern');
  });

  it('несуществующий ключ — сам ключ, а не пустая строка', () => {
    const t = createTranslator('de');
    expect(t('common:no.such_key')).toBe('no.such_key');
  });

  it('множественное число ru', () => {
    const t = createTranslator('ru');
    expect(t('common:items', { count: 1 })).toBe('1 элемент');
    expect(t('common:items', { count: 2 })).toBe('2 элемента');
    expect(t('common:items', { count: 5 })).toBe('5 элементов');
    expect(t('common:items', { count: 21 })).toBe('21 элемент');
  });

  it('параметры подставляются без экранирования', () => {
    expect(createTranslator('en')('common:items', { count: 2 })).toBe('2 items');
  });
});

describe('zodLocale', () => {
  it('немецкий текст для too_small строки', () => {
    const msg = zodLocale('de').localeError({
      code: 'too_small',
      origin: 'string',
      minimum: 3,
      inclusive: true,
      input: 'a',
      path: [],
      message: '',
    } as never);
    const text = typeof msg === 'string' ? msg : msg?.message;
    expect(text).toMatch(/Zu klein/);
  });

  it('у каждого языка свой набор сообщений', () => {
    const issue = { code: 'invalid_type', expected: 'string', input: 1, path: [], message: '' };
    const texts = new Set(
      LOCALES.map((l) => {
        const m = zodLocale(l).localeError(issue as never);
        return typeof m === 'string' ? m : m?.message;
      }),
    );
    expect(texts.size).toBe(LOCALES.length);
  });
});
