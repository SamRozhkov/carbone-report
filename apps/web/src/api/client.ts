export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface RequestOptions {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  signal?: AbortSignal;
}

async function toError(res: Response): Promise<ApiRequestError> {
  const text = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (parsed.error?.message) {
      return new ApiRequestError(
        res.status,
        parsed.error.code ?? 'ERROR',
        parsed.error.message,
        parsed.error.details,
      );
    }
  } catch {
    // не JSON — общий текст ниже
  }
  return new ApiRequestError(
    res.status,
    `HTTP_${res.status}`,
    `ошибка сервера (HTTP ${res.status})`,
  );
}

async function send(path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'NETWORK', 'нет связи с сервером');
  }
  if (!res.ok) throw await toError(res);
  return res;
}

export async function apiJson<T>(path: string, opts?: RequestOptions): Promise<T> {
  const res = await send(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function apiBlob(path: string, opts?: RequestOptions): Promise<Blob> {
  const res = await send(path, opts);
  return res.blob();
}
