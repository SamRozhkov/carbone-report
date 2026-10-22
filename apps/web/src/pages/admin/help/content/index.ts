// Содержимое справки по языкам (§46.2): ru — в чанке справки, остальные языки — отдельные чанки.
import type { Locale } from '@carbone-reports/shared/i18n';
import * as ru from './ru';
import type { HelpContent } from './types';

export type { HelpContent, HelpExample, HelpLimit, HelpSection } from './types';

/** Русская справка — исходная и запасная. */
export const HELP_RU: HelpContent = ru;

/**
 * Модули языков, кроме ru: по строке на язык (`en: () => import('./en')`). Языка нет в таблице —
 * справка на ru. Записи изменяемы: тест подменяет загрузку чанка.
 */
export const HELP_MODULES: Partial<Record<Exclude<Locale, 'ru'>, () => Promise<HelpContent>>> = {
  en: () => import('./en'),
  de: () => import('./de'),
  fr: () => import('./fr'),
};

/** Справка на языке `locale`; модуль не загрузился — ru и `failed: true` (страница покажет сообщение). */
export async function loadHelpContent(
  locale: Locale,
): Promise<{ content: HelpContent; failed: boolean }> {
  const load = locale === 'ru' ? undefined : HELP_MODULES[locale];
  if (!load) return { content: HELP_RU, failed: false };
  try {
    return { content: await load(), failed: false };
  } catch (e) {
    console.error(`Failed to load help content for ${locale}`, e);
    return { content: HELP_RU, failed: true };
  }
}
