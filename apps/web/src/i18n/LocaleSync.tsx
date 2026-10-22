import { useEffect } from 'react';
import { useMe } from '../api/session';
import { changeLocale, currentLocale, preferredLocale } from '.';

/**
 * Язык вслед за пользователем (§44.1): после входа — его выбор, после выхода — выбор гостя.
 * Сбой загрузки языка оставляет прежний язык.
 */
export function LocaleSync() {
  const me = useMe();
  const data = me.data;
  const known = me.isSuccess;
  useEffect(() => {
    if (!known) return;
    const target = preferredLocale(data);
    if (target === currentLocale()) return;
    changeLocale(target, { persist: 'none' }).catch((e: unknown) =>
      console.error('Не удалось загрузить язык интерфейса', e),
    );
  }, [known, data]);
  return null;
}
