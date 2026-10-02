import type { FileFetcher } from '../deps';

export const MAX_FETCH_BYTES = 20 * 1024 * 1024;

export function createFileFetcher(
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): FileFetcher {
  const maxBytes = opts.maxBytes ?? MAX_FETCH_BYTES;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`не удалось скачать файл: HTTP ${res.status}`);
    }
    const tooBig = () => new Error(`файл слишком большой: максимум ${maxBytes} байт`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel();
      throw tooBig();
    }
    if (!res.body) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooBig();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  };
}

export const fetchFile = createFileFetcher();
