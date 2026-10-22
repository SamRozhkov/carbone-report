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

/** Пространства имён каталогов; разделы интерфейса добавляются по мере перевода. */
export const NAMESPACES = [
  'common',
  'reports',
  'history',
  'signature',
  'admin',
  'templates',
  'editor',
  'errors',
  'validation',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

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
