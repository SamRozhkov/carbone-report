import { ApiRequestError } from './client';

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'неизвестная ошибка';
}

/**
 * Ошибки VALIDATION → { поле: сообщение }.
 * Сервер присылает две формы details: { fields } (параметры отчёта) и [{ path, message }] (схема запроса).
 * Путь '/0/name' превращается в ключ '0.name'; пустой путь — в '_'.
 */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiRequestError) || e.code !== 'VALIDATION') return {};
  const d = e.details;
  if (d && typeof d === 'object' && !Array.isArray(d) && 'fields' in d) {
    return { ...(d as { fields: Record<string, string> }).fields };
  }
  const out: Record<string, string> = {};
  if (Array.isArray(d)) {
    for (const item of d as { path?: unknown; message?: unknown }[]) {
      if (typeof item?.path !== 'string') continue;
      const key = item.path.replace(/^\//, '').replaceAll('/', '.') || '_';
      out[key] ??= String(item.message ?? '');
    }
  }
  return out;
}
