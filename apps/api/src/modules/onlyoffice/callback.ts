import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { templates, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { isZip } from '../../lib/http';
import { loadTemplate } from '../templates/service';
import { verifyOnlyOffice } from './jwt';

const Callback = z.object({
  key: z.string(),
  status: z.number().int(),
  url: z.string().optional(),
  users: z.array(z.string()).optional(),
});

const SAVE_ERRORS: Record<number, string> = {
  3: 'OnlyOffice не смог сохранить документ',
  7: 'ошибка принудительного сохранения OnlyOffice',
};

async function verifiedPayload(deps: AppDeps, body: unknown, authorization?: string): Promise<unknown> {
  const secret = deps.config.onlyofficeJwtSecret;
  const bodyToken = (body as { token?: unknown } | null)?.token;
  try {
    if (typeof bodyToken === 'string') return await verifyOnlyOffice(bodyToken, secret);
    if (authorization?.startsWith('Bearer ')) {
      const claims = await verifyOnlyOffice(authorization.slice(7), secret);
      return claims.payload ?? claims;
    }
  } catch {
    // неверная подпись — ниже
  }
  throw new AppError('FORBIDDEN', 403, 'неверная подпись OnlyOffice');
}

async function existingUserId(deps: AppDeps, id: string | undefined): Promise<string | null> {
  if (!id || !z.uuid().safeParse(id).success) return null;
  const [u] = await deps.db.select({ id: users.id }).from(users).where(eq(users.id, id));
  return u?.id ?? null;
}

export async function handleCallback(
  deps: AppDeps,
  templateId: string,
  body: unknown,
  authorization: string | undefined,
): Promise<void> {
  const cb = Callback.parse(await verifiedPayload(deps, body, authorization));
  const row = await loadTemplate(deps.db, templateId);
  // Колбэк от закрытой сессии (ключ уже сменился) не должен затирать новую версию.
  if (cb.key !== row.docKey) return;

  if (cb.status === 3 || cb.status === 7) {
    await deps.db.update(templates).set({ lastSaveError: SAVE_ERRORS[cb.status]! }).where(eq(templates.id, row.id));
    return;
  }
  if (cb.status !== 2 && cb.status !== 6) return;

  if (!cb.url) {
    await deps.db.update(templates).set({ lastSaveError: 'OnlyOffice не передал ссылку на файл' }).where(eq(templates.id, row.id));
    return;
  }
  const file = await deps.fetchFile(cb.url);
  if (!isZip(file)) {
    await deps.db
      .update(templates)
      .set({ lastSaveError: 'полученный от OnlyOffice файл не является документом' })
      .where(eq(templates.id, row.id));
    return;
  }
  await deps.storage.write(row.filePath, file);
  await deps.db
    .update(templates)
    .set({
      version: sql`${templates.version} + 1`,
      updatedAt: new Date(),
      updatedBy: await existingUserId(deps, cb.users?.[0]),
      lastSaveError: null,
      ...(cb.status === 2 ? { docKey: randomUUID() } : {}),
    })
    .where(eq(templates.id, row.id));
}
