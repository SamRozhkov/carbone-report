import type { Redis } from 'ioredis';

/** Флаг обслуживания; ставит и снимает только агент бэкапа (§26.2). */
export const MAINTENANCE_KEY = 'cr:maintenance';

export interface MaintenanceFlag {
  phase: string;
  startedAt: string;
  backup: string;
}

export interface MaintenanceWatch {
  get(): Promise<MaintenanceFlag | null>;
  stop(): void;
}

function parseFlag(raw: string): MaintenanceFlag {
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof MaintenanceFlag, unknown>> | null;
    if (v && typeof v === 'object')
      return {
        phase: String(v.phase ?? ''),
        startedAt: String(v.startedAt ?? ''),
        backup: String(v.backup ?? ''),
      };
  } catch {
    // ключ есть — обслуживание включено, даже если значение не разобрать
  }
  return { phase: '', startedAt: '', backup: '' };
}

/**
 * Флаг cr:maintenance с кэшем в процессе на ttlMs (§26.3). Ошибка Redis — «флага нет» (fail-open:
 * обслуживание включает только агент, и он всегда пишет флаг в Redis). Таймер раз в ttlMs обновляет
 * значение и без запросов, чтобы экземпляр заметил снятие флага (onEnd).
 */
export function watchMaintenance(
  redis: Redis | null,
  o: { ttlMs?: number; onEnd?: () => void; now?: () => number } = {},
): MaintenanceWatch {
  const ttl = o.ttlMs ?? 1000;
  const now = o.now ?? Date.now;
  let value: MaintenanceFlag | null = null;
  let at = -Infinity;
  let inflight: Promise<MaintenanceFlag | null> | null = null;

  async function refresh(): Promise<MaintenanceFlag | null> {
    let next: MaintenanceFlag | null;
    try {
      const raw = await redis!.get(MAINTENANCE_KEY);
      next = raw === null ? null : parseFlag(raw);
    } catch {
      next = null;
    }
    const ended = value !== null && next === null;
    value = next;
    at = now();
    if (ended) o.onEnd?.();
    return value;
  }

  function get(): Promise<MaintenanceFlag | null> {
    if (!redis) return Promise.resolve(null);
    if (now() - at < ttl) return Promise.resolve(value);
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const timer = redis ? setInterval(() => void get(), ttl) : null;
  timer?.unref();
  return {
    get,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
