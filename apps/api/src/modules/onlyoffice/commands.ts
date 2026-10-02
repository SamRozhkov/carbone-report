import type { OnlyOfficeCommands } from '../../deps';
import { AppError } from '../../lib/errors';
import { signOnlyOffice } from './jwt';

export function createOnlyOfficeCommands(opts: {
  baseUrl: string;
  secret: Uint8Array;
  fetch?: typeof fetch;
}): OnlyOfficeCommands {
  const doFetch = opts.fetch ?? fetch;
  return {
    async forceSave(key) {
      const body = { c: 'forcesave', key };
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
        throw new AppError('ONLYOFFICE_ERROR', 502, 'сервер документов недоступен');
      }
      const { error } = (await res.json().catch(() => ({ error: -1 }))) as { error: number };
      if (error === 0 || error === 4) return; // 4 — изменений нет
      if (error === 1) throw new AppError('NOT_OPEN', 409, 'документ не открыт в редакторе');
      throw new AppError('ONLYOFFICE_ERROR', 502, `сервер документов вернул ошибку ${error}`);
    },
  };
}
