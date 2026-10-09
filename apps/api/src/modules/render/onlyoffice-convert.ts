import { randomUUID } from 'node:crypto';
import type { OutputFormat, TemplateExt } from '@carbone-reports/shared';
import { AppError } from '../../lib/errors';
import { toInternalDownloadUrl } from '../onlyoffice/download-url';
import { signOnlyOffice } from '../onlyoffice/jwt';

export interface ConvertRequest {
  filetype: TemplateExt;
  outputtype: OutputFormat;
  title: string;
  url: string;
  signal: AbortSignal;
}

export type Converter = (req: ConvertRequest) => Promise<Buffer>;

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

const unavailable = (cause?: unknown) =>
  new AppError('CONVERT_ERROR', 502, 'сервис конвертации недоступен', undefined, cause);
const failed = (code: number) =>
  new AppError('CONVERT_ERROR', 502, `ошибка конвертации (код ${code})`);
const timeout = () => new AppError('TIMEOUT', 504, 'превышено время ожидания');

/** Перевод отчёта в другой формат через Conversion API Document Server (POST /converter). */
export function createOnlyOfficeConverter(opts: {
  baseUrl: string;
  secret: Uint8Array;
  fetch?: typeof fetch;
  maxBytes?: number;
}): Converter {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return async (req) => {
    const body = {
      async: false,
      filetype: req.filetype,
      outputtype: req.outputtype,
      // Document Server кэширует результат по ключу: новый ключ на каждый вызов.
      key: randomUUID().replaceAll('-', ''),
      title: req.title,
      url: req.url,
      region: 'ru-RU',
    };
    let reply: { endConvert?: boolean; fileUrl?: string; error?: number };
    try {
      const res = await doFetch(`${base}/converter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...body, token: await signOnlyOffice(body, opts.secret) }),
        signal: req.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      reply = (await res.json()) as typeof reply;
    } catch (e) {
      if (req.signal.aborted) throw timeout();
      throw unavailable(e);
    }
    if (typeof reply.error === 'number' && reply.error < 0) throw failed(reply.error);
    if (reply.endConvert !== true || !reply.fileUrl) throw failed(-1);
    const internal = toInternalDownloadUrl(reply.fileUrl, base);
    if (!internal) throw failed(-1);
    return download(doFetch, internal, req.signal, maxBytes);
  };
}

async function download(
  doFetch: typeof fetch,
  url: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer> {
  try {
    const res = await doFetch(url, { redirect: 'error', signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error('результат конвертации больше лимита');
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  } catch (e) {
    if (signal.aborted) throw timeout();
    throw unavailable(e);
  }
}
