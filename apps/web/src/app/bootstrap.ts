import { isLocale } from '@carbone-reports/shared/i18n';
import { ApiRequestError } from '../api/client';
import { api } from '../api/endpoints';
import type { SessionUser } from '../api/session';
import { changeLocale, preferredLocale, setDefaultLocale } from '../i18n';

/** Дольше не ждём: запуск не должен зависеть от медленного ответа API. */
const STARTUP_TIMEOUT_MS = 5000;

/**
 * Язык при старте (§44.1): текущий пользователь и язык по умолчанию запрашиваются параллельно.
 * Любой сбой (503 в обслуживании, нет связи, таймаут) не блокирует запуск: язык браузера или ru.
 * Возвращает пользователя (null — не вошёл, undefined — неизвестно), чтобы не запрашивать его повторно.
 */
export async function initLocale(): Promise<SessionUser | null | undefined> {
  const [me, defaults] = await Promise.all([
    api.me
      .get(AbortSignal.timeout(STARTUP_TIMEOUT_MS))
      .catch((e: unknown) => (e instanceof ApiRequestError && e.status === 401 ? null : undefined)),
    api.i18n.get(AbortSignal.timeout(STARTUP_TIMEOUT_MS)).catch(() => undefined),
  ]);
  if (isLocale(defaults?.defaultLocale)) setDefaultLocale(defaults.defaultLocale);
  try {
    await changeLocale(preferredLocale(me), { persist: 'none' });
  } catch (e) {
    // Чанк языка не загрузился — остаёмся на ru из основного бандла.
    console.error('Не удалось загрузить язык интерфейса', e);
  }
  return me;
}
