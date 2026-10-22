import { describe, expect, it } from 'vitest';
import { PdfPageNumbers } from '../pdf-options';
import {
  CARBONE_LANGS,
  LOCALES,
  LOCALE_NAMES,
  Locale,
  NAMESPACES,
  OFFICE_REGIONS,
  PAGE_FORMATS,
  REPORT_LOCALES,
  isLocale,
  localeTag,
  resolveLocale,
  zodLocale,
  zodReportLocale,
} from '.';
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

describe('язык отчёта (§45)', () => {
  it('таблицы покрывают все языки', () => {
    expect(CARBONE_LANGS).toEqual({
      ru: 'ru',
      en: 'en-us',
      es: 'es-es',
      'pt-BR': 'pt-br',
      fr: 'fr-fr',
      de: 'de-de',
      'zh-CN': 'zh-cn',
    });
    expect(OFFICE_REGIONS).toEqual({
      ru: 'ru-RU',
      en: 'en-US',
      es: 'es-ES',
      'pt-BR': 'pt-BR',
      fr: 'fr-FR',
      de: 'de-DE',
      'zh-CN': 'zh-CN',
    });
    expect(LOCALES.map(localeTag)).toEqual([
      'ru-RU',
      'en-US',
      'es-ES',
      'pt-BR',
      'fr-FR',
      'de-DE',
      'zh-CN',
    ]);
    for (const l of LOCALES) expect(() => new Intl.DateTimeFormat(localeTag(l))).not.toThrow();
  });

  it('zodReportLocale: семь языков и user', () => {
    expect(REPORT_LOCALES).toEqual([...LOCALES, 'user']);
    for (const l of REPORT_LOCALES) expect(zodReportLocale.safeParse(l).success).toBe(true);
    expect(zodReportLocale.safeParse('pt-PT').success).toBe(false);
    expect(zodReportLocale.safeParse('').success).toBe(false);
  });

  it('PAGE_FORMATS: ru — прежний формат, все проходят PdfPageNumbers', () => {
    expect(PAGE_FORMATS.ru).toBe('Стр. {page} из {pages}');
    expect(PAGE_FORMATS.en).toBe('Page {page} of {pages}');
    expect(Object.keys(PAGE_FORMATS).sort()).toEqual([...LOCALES].sort());
    for (const l of LOCALES) {
      expect(PAGE_FORMATS[l]).toContain('{page}');
      expect(PAGE_FORMATS[l]).toContain('{pages}');
      expect(PdfPageNumbers.safeParse({ format: PAGE_FORMATS[l] }).success).toBe(true);
    }
  });

  it('штамп ru — дословно прежние строки', () => {
    const t = createTranslator('ru');
    expect(t('report:stamp.title')).toBe('ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ');
    expect(t('report:stamp.certificate', { serial: '01AB' })).toBe('Сертификат: 01AB');
    expect(t('report:stamp.owner', { owner: 'Иванов' })).toBe('Владелец: Иванов');
    expect(t('report:stamp.valid', { from: '01.01.2026', to: '31.12.2026' })).toBe(
      'Действителен: с 01.01.2026 по 31.12.2026',
    );
    expect(t('report:stamp.signed', { date: '22.10.2026', time: '10:05' })).toBe(
      'Подписан: 22.10.2026 10:05',
    );
  });

  it('штамп на всех языках: свой текст, параметры подставлены', () => {
    const titles = new Set(LOCALES.map((l) => createTranslator(l)('report:stamp.title')));
    expect(titles.size).toBe(LOCALES.length);
    for (const l of LOCALES) {
      const t = createTranslator(l);
      expect(t('report:stamp.certificate', { serial: 'S1' })).toContain('S1');
      expect(t('report:stamp.owner', { owner: 'O1' })).toContain('O1');
      const valid = t('report:stamp.valid', { from: 'F1', to: 'T1' });
      expect(valid).toContain('F1');
      expect(valid).toContain('T1');
      expect(t('report:stamp.signed', { date: 'D1', time: 'H1' })).toMatch(/D1.*H1/);
    }
    expect(createTranslator('en')('report:stamp.title')).toBe(
      createTranslator('en')('report:stamp.title').toUpperCase(),
    );
  });
});
