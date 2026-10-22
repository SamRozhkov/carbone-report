import { describe, expect, it } from 'vitest';
import { resolveReportLocale, runLocale } from './report-locale';

describe('resolveReportLocale (§45.2)', () => {
  it('язык шаблона — как задан', () => {
    expect(resolveReportLocale('de', 'en', 'fr')).toBe('de');
    expect(resolveReportLocale('ru', null, 'zh-CN')).toBe('ru');
  });

  it("'user': язык профиля, иначе язык запроса", () => {
    expect(resolveReportLocale('user', 'en', 'fr')).toBe('en');
    expect(resolveReportLocale('user', 'pt-BR', 'fr')).toBe('pt-BR');
    expect(resolveReportLocale('user', null, 'fr')).toBe('fr');
    expect(resolveReportLocale('user', 'xx', 'fr')).toBe('fr');
  });
});

describe('runLocale (§45.2)', () => {
  it('язык запуска; NULL (до 2.14.0) и неизвестное — ru', () => {
    expect(runLocale({ reportLocale: 'de' })).toBe('de');
    expect(runLocale({ reportLocale: null })).toBe('ru');
    expect(runLocale({ reportLocale: 'xx' })).toBe('ru');
  });
});
