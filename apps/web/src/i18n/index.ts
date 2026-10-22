// Язык интерфейса (§44.1, §44.3): экземпляр i18next, выбор языка при старте и его смена.
import { isLocale, resolveLocale, type Locale } from '@carbone-reports/shared/i18n';
import { settings } from '@gravity-ui/date-utils';
import { configure } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';
import { setRequestLocale } from '../api/client';
import { api } from '../api/endpoints';
import { NAMESPACES, catalogChunks, i18n } from './instance';

export { NAMESPACES, catalogChunks, i18n };

/** Локали @gravity-ui/date-utils (dayjs) по языку интерфейса. */
const DATE_LOCALES: Record<Locale, string> = {
  ru: 'ru',
  en: 'en',
  es: 'es',
  'pt-BR': 'pt-br',
  fr: 'fr',
  de: 'de',
  'zh-CN': 'zh-cn',
};

const STORAGE_KEY = 'cr.locale';
let fallbackLocale: Locale = 'ru';

export function currentLocale(): Locale {
  return isLocale(i18n.language) ? i18n.language : 'ru';
}

/** Текущий язык в компонентах: перерисовка при смене. */
export function useLocale(): Locale {
  const { i18n: inst } = useTranslation();
  return isLocale(inst.language) ? inst.language : 'ru';
}

/** Язык по умолчанию сервера (`GET /api/i18n`, §44.1 п. 3). */
export function defaultLocale(): Locale {
  return fallbackLocale;
}
export function setDefaultLocale(locale: Locale): void {
  fallbackLocale = locale;
}

/** Выбор на странице входа (`localStorage`). */
export function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}
function writeStoredLocale(locale: Locale | null): void {
  try {
    if (locale) localStorage.setItem(STORAGE_KEY, locale);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // приватный режим — выбор живёт до перезагрузки
  }
}

function browserLanguages(): readonly string[] {
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/**
 * Правило §44.1: выбор пользователя → выбор на странице входа → язык браузера → язык по умолчанию.
 * Выбор на странице входа действует, пока пользователь не выбрал язык в меню.
 */
export function pickLocale(input: {
  me?: { locale?: Locale | null } | null;
  stored: Locale | null;
  browser: readonly string[];
  defaultLocale: Locale;
}): Locale {
  if (input.me?.locale) return input.me.locale;
  const candidates = input.stored ? [input.stored, ...input.browser] : input.browser;
  return resolveLocale(candidates, input.defaultLocale);
}

/** Язык для текущего пользователя (или для гостя, если `me` — null). */
export function preferredLocale(me?: { locale?: Locale | null } | null): Locale {
  return pickLocale({
    me,
    stored: storedLocale(),
    browser: browserLanguages(),
    defaultLocale: fallbackLocale,
  });
}

/** Каталоги языка и запасного en; ru уже в бандле. Сбой — исключение, язык не меняется. */
export async function loadLocale(locale: Locale): Promise<void> {
  const chain: Locale[] = locale === 'ru' ? [] : locale === 'en' ? ['en'] : [locale, 'en'];
  await Promise.all(
    chain.flatMap((l) =>
      NAMESPACES.filter((ns) => !i18n.hasResourceBundle(l, ns)).map(async (ns) => {
        i18n.addResourceBundle(l, ns, await catalogChunks.load(l, ns), true, true);
      }),
    ),
  );
}

/** Чанк локали дат; сбой не должен ломать смену языка — тогда остаётся прежняя локаль дат. */
async function loadDateLocale(locale: Locale): Promise<boolean> {
  try {
    await settings.loadLocale(DATE_LOCALES[locale]);
    return true;
  } catch (e) {
    console.error('Failed to load the date locale', e);
    return false;
  }
}

/** Номер последнего вызова changeLocale: побеждает последний выбор, а не последний загруженный чанк. */
let latestChange = 0;

/**
 * Смена языка (§44.3): каталоги, затем i18next, `<html lang>`, uikit, date-utils и X-Locale.
 * `null` — «Как в браузере»: язык браузера (или по умолчанию), выбор сбрасывается.
 * Сохранение: server — `PUT /api/me/locale`, local — `localStorage` (страница входа), none — нет.
 * Если пока грузились чанки, начался более новый вызов, этот ничего не меняет и не сохраняет.
 */
export async function changeLocale(
  choice: Locale | null,
  opts: { persist: 'server' | 'local' | 'none' },
): Promise<void> {
  const call = ++latestChange;
  const locale = choice ?? resolveLocale(browserLanguages(), fallbackLocale);
  await loadLocale(locale);
  const dateLoaded = await loadDateLocale(locale);
  if (call !== latestChange) return;
  if (dateLoaded) settings.setLocale(DATE_LOCALES[locale]);
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  // uikit и navigation знают только ru и en.
  configure({ lang: locale === 'ru' ? 'ru' : 'en' });
  setRequestLocale(locale);
  if (opts.persist === 'local') writeStoredLocale(choice);
  if (opts.persist === 'server') {
    // «Как в браузере» в меню сбрасывает и выбор, сделанный на странице входа.
    if (choice === null) writeStoredLocale(null);
    await api.me.setLocale(choice);
  }
}
