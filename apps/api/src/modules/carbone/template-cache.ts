import type { Redis } from 'ioredis';

export interface TemplateIdEntry {
  version: number;
  carboneId: string;
}

/** Кэш «id шаблона → id загруженного в Carbone файла». Сбой кэша = промах. */
export interface TemplateIdCache {
  get(id: string): Promise<TemplateIdEntry | null>;
  set(id: string, v: TemplateIdEntry): Promise<void>;
}

const KEY_PREFIX = 'cr:carbone:tpl:';
const TTL_SECONDS = 7 * 24 * 3600;

export function memoryTemplateCache(): TemplateIdCache {
  const ids = new Map<string, TemplateIdEntry>();
  return {
    async get(id) {
      return ids.get(id) ?? null;
    },
    async set(id, v) {
      ids.set(id, v);
    },
  };
}

function parseEntry(raw: string | null): TemplateIdEntry | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<TemplateIdEntry> | null;
    if (v && typeof v.version === 'number' && typeof v.carboneId === 'string') {
      return { version: v.version, carboneId: v.carboneId };
    }
  } catch {
    // битое значение — считаем промахом
  }
  return null;
}

/** Общий для всех экземпляров API кэш. Ошибки Redis не пробрасываются. */
export function redisTemplateCache(redis: Redis): TemplateIdCache {
  return {
    async get(id) {
      try {
        return parseEntry(await redis.get(KEY_PREFIX + id));
      } catch {
        return null;
      }
    },
    async set(id, v) {
      try {
        await redis.set(KEY_PREFIX + id, JSON.stringify(v), 'EX', TTL_SECONDS);
      } catch {
        // кэш необязателен
      }
    },
  };
}
