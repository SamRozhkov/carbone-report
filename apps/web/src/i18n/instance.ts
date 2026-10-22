// Экземпляр i18next и каталоги (§44.3) — без зависимостей от API-клиента,
// чтобы модули, которые импортирует сам i18n (api/client), могли переводить тексты.
import type { Locale } from '@carbone-reports/shared/i18n';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

type Catalog = Record<string, unknown>;

// Каталоги shared: ru — в основном бандле, остальные языки — отдельные чанки (§44.3).
// Шаблоны — литералы (требование Vite), по строке на пространство имён веба; errors, validation
// и report переводит API, вебу они не нужны. Языки второго списка перечислены явно: исключения «!…» Vitest
// не применяет к путям вне пакета, а ru в обоих списках даёт предупреждение сборки.
const RU = import.meta.glob<Catalog>(
  [
    '../../../../packages/shared/src/i18n/ru/common.json',
    '../../../../packages/shared/src/i18n/ru/reports.json',
    '../../../../packages/shared/src/i18n/ru/history.json',
    '../../../../packages/shared/src/i18n/ru/signature.json',
    '../../../../packages/shared/src/i18n/ru/admin.json',
    '../../../../packages/shared/src/i18n/ru/templates.json',
    '../../../../packages/shared/src/i18n/ru/editor.json',
  ],
  { eager: true, import: 'default' },
);
const LAZY = import.meta.glob<Catalog>(
  [
    '../../../../packages/shared/src/i18n/{en,es,pt-BR,fr,de,zh-CN}/common.json',
    '../../../../packages/shared/src/i18n/{en,es,pt-BR,fr,de,zh-CN}/reports.json',
    '../../../../packages/shared/src/i18n/{en,es,pt-BR,fr,de,zh-CN}/history.json',
    '../../../../packages/shared/src/i18n/{en,es,pt-BR,fr,de,zh-CN}/signature.json',
    '../../../../packages/shared/src/i18n/{en,es,pt-BR,fr,de,zh-CN}/admin.json',
    '../../../../packages/shared/src/i18n/{en,es,pt-BR,fr,de,zh-CN}/templates.json',
    '../../../../packages/shared/src/i18n/{en,es,pt-BR,fr,de,zh-CN}/editor.json',
  ],
  { import: 'default' },
);

/** «…/i18n/<locale>/<ns>.json» → [locale, ns]. */
function parsePath(path: string): [string, string] {
  const m = /\/([^/]+)\/([^/]+)\.json$/.exec(path)!;
  return [m[1]!, m[2]!];
}

const ruResources = Object.fromEntries(
  Object.entries(RU).map(([path, catalog]) => [parsePath(path)[1], catalog]),
);
/** Пространства имён веба — каталоги из списков выше (Task 5–7 добавляют свои). */
export const NAMESPACES: readonly string[] = Object.keys(ruResources);

/** Загрузка одного каталога; отдельный объект, чтобы тест мог подменить сбой чанка. */
export const catalogChunks = {
  load(locale: Locale, ns: string): Promise<Catalog> {
    const entry = Object.entries(LAZY).find(([path]) => {
      const [l, n] = parsePath(path);
      return l === locale && n === ns;
    });
    if (!entry) return Promise.reject(new Error(`no catalog ${locale}/${ns}`));
    return entry[1]();
  },
};

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  resources: { ru: ruResources },
  lng: 'ru',
  // Запасная цепочка §44.2: <locale> → en → ru.
  fallbackLng: { ru: ['ru'], en: ['ru'], default: ['en', 'ru'] },
  ns: [...NAMESPACES],
  defaultNS: 'common',
  // pt-BR и zh-CN не превращаются в pt/zh: каталоги лежат под полным тегом.
  load: 'currentOnly',
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
  react: { useSuspense: false },
});
