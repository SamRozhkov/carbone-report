import { randomUUID } from 'node:crypto';
import type { TemplateExt } from '@carbone-reports/shared';
import { jwtVerify, SignJWT } from 'jose';

const AUDIENCE = 'render-file';

export interface RenderHandoff {
  put(file: Buffer, ext: TemplateExt, deadlineAt: number): Promise<{ id: string; token: string }>;
  take(
    id: string,
    token: string,
  ): Promise<{ file: Buffer; ext: TemplateExt } | 'forbidden' | 'gone'>;
  remove(id: string): void;
  close(): void;
}

interface Entry {
  file: Buffer;
  ext: TemplateExt;
  timer: NodeJS.Timeout;
}

/**
 * Файлы для Document Server в памяти этой реплики: ссылка разовая, подписана APP_SECRET,
 * живёт не дольше срока рендера. Ссылка ведёт на API_SELF_URL — адрес именно этой реплики.
 */
export function createRenderHandoff(secret: Uint8Array): RenderHandoff {
  const files = new Map<string, Entry>();
  const remove = (id: string) => {
    const e = files.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    files.delete(id);
  };
  return {
    async put(file, ext, deadlineAt) {
      const id = randomUUID().replaceAll('-', '');
      const timer = setTimeout(() => files.delete(id), Math.max(0, deadlineAt - Date.now()));
      timer.unref();
      files.set(id, { file, ext, timer });
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(id)
        .setAudience(AUDIENCE)
        // Вниз: токен не переживает срок рендера.
        .setExpirationTime(Math.floor(deadlineAt / 1000))
        .sign(secret);
      return { id, token };
    },
    async take(id, token) {
      try {
        await jwtVerify(token, secret, { algorithms: ['HS256'], subject: id, audience: AUDIENCE });
      } catch {
        return 'forbidden';
      }
      const e = files.get(id);
      if (!e) return 'gone';
      remove(id);
      return { file: e.file, ext: e.ext };
    },
    remove,
    close() {
      for (const id of [...files.keys()]) remove(id);
    },
  };
}
