import type { OnlyOfficeCommands } from '../../deps';

const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;

/**
 * Проба возможности «формирование в документе» (§52.2): лицензия Document Server не нулевая
 * (`packageType !== 0`) и `resultType` — 3 (действует) или 7 (в льготном периоде).
 * Результат кэшируется на 10 минут, ошибка — «нет» на 1 минуту; одновременные вызовы делят запрос.
 */
export function createAutomationProbe(
  commands: OnlyOfficeCommands,
  now: () => number = Date.now,
): () => Promise<boolean> {
  let cached: { value: boolean; until: number } | null = null;
  let inflight: Promise<boolean> | null = null;
  const refresh = async (): Promise<boolean> => {
    let value: boolean;
    // Кэш «да» действует ровно 10 минут включительно; повтор после ошибки — ровно через 60 с.
    let ttl = OK_TTL_MS;
    try {
      const lic = await commands.license();
      value = lic.packageType !== 0 && (lic.resultType === 3 || lic.resultType === 7);
    } catch {
      value = false;
      ttl = FAIL_TTL_MS - 1;
    }
    cached = { value, until: now() + ttl };
    return value;
  };
  return async () => {
    if (cached && now() <= cached.until) return cached.value;
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
