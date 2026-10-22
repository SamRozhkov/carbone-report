// Синхронный переводчик для API и тестов: все языки и пространства имён загружены сразу.
import i18next, { type TFunction } from 'i18next';
import { NAMESPACES, type Locale } from '.';
import { resources } from './resources';

export { resources };

export type Translate = (key: string, params?: Record<string, unknown>) => string;

const cache = new Map<Locale, Translate>();

/** Ключ вида 'ns:key' или 'key' (пространство имён по умолчанию — common). */
export function createTranslator(locale: Locale): Translate {
  let t = cache.get(locale);
  if (!t) {
    const inst = i18next.createInstance();
    void inst.init({
      resources,
      lng: locale,
      // Запасная цепочка §44.2: <locale> → en → ru.
      fallbackLng: { default: ['en', 'ru'] },
      ns: [...NAMESPACES],
      defaultNS: 'common',
      interpolation: { escapeValue: false },
      returnNull: false,
      initAsync: false,
    });
    const fixed: TFunction = inst.getFixedT(locale);
    t = (key, params) => String(fixed(key, params ?? {}));
    cache.set(locale, t);
  }
  return t;
}
