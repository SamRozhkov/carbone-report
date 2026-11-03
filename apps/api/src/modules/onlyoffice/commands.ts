import type { OnlyOfficeCommands } from '../../deps';
import { AppError } from '../../lib/errors';
import { signOnlyOffice } from './jwt';

export function createOnlyOfficeCommands(opts: {
  baseUrl: string;
  secret: Uint8Array;
  fetch?: typeof fetch;
}): OnlyOfficeCommands {
  const doFetch = opts.fetch ?? fetch;
  // Подписанная команда Document Server; сеть и таймаут — ONLYOFFICE_ERROR 502.
  async function send(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/command`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await signOnlyOffice({ payload: body }, opts.secret)}`,
        },
        body: JSON.stringify({ ...body, token: await signOnlyOffice(body, opts.secret) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError('ONLYOFFICE_ERROR', 502, { key: 'onlyoffice.unavailable' });
    }
    return (await res.json().catch(() => ({ error: -1 }))) as Record<string, unknown>;
  }
  return {
    async forceSave(key) {
      const { error } = (await send({ c: 'forcesave', key })) as { error: number };
      if (error === 0) return;
      // 4 — Document Server не получил правок с прошлого сохранения: callback не придёт, ждать нечего.
      if (error === 4) throw new AppError('NO_CHANGES', 409, { key: 'onlyoffice.noChanges' });
      if (error === 1) throw new AppError('NOT_OPEN', 409, { key: 'onlyoffice.notOpen' });
      throw new AppError('ONLYOFFICE_ERROR', 502, {
        key: 'onlyoffice.commandError',
        params: { code: error },
      });
    },
    async license() {
      const r = await send({ c: 'license' });
      const server = r.server as { packageType?: unknown; resultType?: unknown } | undefined;
      if (
        r.error === 0 &&
        typeof server?.packageType === 'number' &&
        typeof server.resultType === 'number'
      )
        return { packageType: server.packageType, resultType: server.resultType };
      throw new AppError('ONLYOFFICE_ERROR', 502, {
        key: 'onlyoffice.commandError',
        params: { code: typeof r.error === 'number' ? r.error : -1 },
      });
    },
  };
}
