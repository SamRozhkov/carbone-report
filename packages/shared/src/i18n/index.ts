// Языки интерфейса и общие правила локализации (§44). Модуль без каталогов:
// веб подгружает каталоги по языкам сам, API берёт их из ./server.
import { z } from 'zod';

export const LOCALES = ['ru', 'en', 'es', 'pt-BR', 'fr', 'de', 'zh-CN'] as const;
export const Locale = z.enum(LOCALES);
export type Locale = (typeof LOCALES)[number];

/** Самоназвания языков для переключателя. */
export const LOCALE_NAMES: Record<Locale, string> = {
  ru: 'Русский',
  en: 'English',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  fr: 'Français',
  de: 'Deutsch',
  'zh-CN': '简体中文',
};

/**
 * Пространства имён каталогов; разделы интерфейса добавляются по мере перевода.
 * errors, validation и report — только API: веб их не загружает (apps/web/src/i18n/instance.ts).
 */
export const NAMESPACES = [
  'common',
  'reports',
  'history',
  'signature',
  'admin',
  'templates',
  'editor',
  'help',
  'errors',
  'validation',
  'report',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

// ---- Язык отчёта (§45) ----

/** Язык отчёта в шаблоне: один из языков или 'user' — язык строящего (§45.2). */
export const REPORT_LOCALES = [...LOCALES, 'user'] as const;
export type ReportLocale = (typeof REPORT_LOCALES)[number];
export const zodReportLocale = z.enum(REPORT_LOCALES);

/** options.lang Carbone (§45.3): `ru`, а не `ru-ru`, — русские разделители и рубли в formatC (§23.4). */
export const CARBONE_LANGS: Record<Locale, string> = {
  ru: 'ru',
  en: 'en-us',
  es: 'es-es',
  'pt-BR': 'pt-br',
  fr: 'fr-fr',
  de: 'de-de',
  'zh-CN': 'zh-cn',
};

/** Регион OnlyOffice (форматы чисел и дат): редактор (§44.4) и конвертация отчёта (§45.3). */
export const OFFICE_REGIONS: Record<Locale, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
  'pt-BR': 'pt-BR',
  fr: 'fr-FR',
  de: 'de-DE',
  'zh-CN': 'zh-CN',
};

/**
 * Формат нумерации страниц PDF по умолчанию (§45.4). {page} и {pages} подставляет постобработка PDF,
 * не i18next; таблица в данных, а не в каталоге, — её читают и API, и конструктор.
 */
export const PAGE_FORMATS: Record<Locale, string> = {
  ru: 'Стр. {page} из {pages}',
  en: 'Page {page} of {pages}',
  es: 'Pág. {page} de {pages}',
  'pt-BR': 'Pág. {page} de {pages}',
  fr: 'Page {page} sur {pages}',
  de: 'Seite {page} von {pages}',
  'zh-CN': '第 {page} 页，共 {pages} 页',
};

/** Тег BCP 47 для Intl (даты и время штампа подписи, §45.4); совпадает с регионом OnlyOffice. */
export function localeTag(locale: Locale): string {
  return OFFICE_REGIONS[locale];
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

const BY_LOWER = new Map<string, Locale>(LOCALES.map((l) => [l.toLowerCase(), l]));
/** Основной подтег → язык каталога: pt-* → pt-BR, zh-* → zh-CN, en-* → en … */
const BY_PRIMARY = new Map<string, Locale>(LOCALES.map((l) => [l.split('-')[0]!.toLowerCase(), l]));

/**
 * Правило §44.1: первый кандидат, у которого есть каталог, — по точному тегу
 * (без учёта регистра), затем по основному подтегу; иначе fallback.
 */
export function resolveLocale(candidates: readonly string[], fallback: Locale): Locale {
  for (const raw of candidates) {
    const tag = raw.trim().replace(/_/g, '-').toLowerCase();
    if (!tag) continue;
    const found = BY_LOWER.get(tag) ?? BY_PRIMARY.get(tag.split('-')[0]!);
    if (found) return found;
  }
  return fallback;
}

const ZOD_LOCALES: Record<Locale, () => { localeError: z.core.$ZodErrorMap }> = {
  ru: z.locales.ru,
  en: z.locales.en,
  es: z.locales.es,
  'pt-BR': z.locales.pt,
  fr: z.locales.fr,
  de: z.locales.de,
  'zh-CN': z.locales.zhCN,
};
const zodCache = new Map<Locale, { localeError: z.core.$ZodErrorMap }>();

/** Встроенные сообщения zod на языке (без смены глобальной настройки z.config). */
export function zodLocale(locale: Locale): { localeError: z.core.$ZodErrorMap } {
  let v = zodCache.get(locale);
  if (!v) zodCache.set(locale, (v = ZOD_LOCALES[locale]()));
  return v;
}
