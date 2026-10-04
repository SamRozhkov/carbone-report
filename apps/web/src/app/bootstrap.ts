import { settings } from '@gravity-ui/date-utils';
import { configure } from '@gravity-ui/uikit';

/**
 * Русская локаль для uikit/navigation (синхронно) и для date-utils (ленивый чанк).
 * Сбой загрузки чанка не должен оставлять пустую страницу: логируем и продолжаем.
 */
export async function initLocale(loader: () => Promise<void> = () => settings.loadLocale('ru')) {
  configure({ lang: 'ru' });
  try {
    await loader();
    settings.setLocale('ru');
  } catch (e) {
    console.error('Не удалось загрузить локаль дат', e);
  }
}
