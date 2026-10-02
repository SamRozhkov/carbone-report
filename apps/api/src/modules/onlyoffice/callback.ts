import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { templates, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { isZip } from '../../lib/http';
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

async function existingUserId(db: Pick<AppDeps['db'], 'select'>, id: string | undefined): Promise<string | null> {
  if (!id || !z.uuid().safeParse(id).success) return null;
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  return u?.id ?? null;
}

export async function handleCallback(
  deps: AppDeps,
  templateId: string,
  body: unknown,
  authorization: string | undefined,
  log?: { warn(o: unknown, msg?: string): void },
): Promise<void> {
  const parsed = Callback.safeParse(await verifiedPayload(deps, body, authorization));
  if (!parsed.success) throw new AppError('BAD_CALLBACK', 400, 'неверный формат callback OnlyOffice');
  const cb = parsed.data;
  if (![2, 3, 6, 7].includes(cb.status)) return; // остальные статусы не требуют действий и блокировок
  const [exists] = await deps.db.select({ id: templates.id }).from(templates).where(eq(templates.id, templateId));
  if (!exists) return; // шаблон удалён: подтверждаем, чтобы Document Server не повторял callback

  let downloadFailed = false;
  try {
    await deps.db.transaction(async (tx) => {
      // Блокировка строки сериализует параллельные callback-и и ручную замену файла.
      const [row] = await tx.select().from(templates).where(eq(templates.id, templateId)).for('update');
      // Колбэк от закрытой сессии (ключ уже сменился) не должен затирать новую версию.
      if (!row || cb.key !== row.docKey) return;
      const setError = (msg: string) => tx.update(templates).set({ lastSaveError: msg }).where(eq(templates.id, row.id));

      if (cb.status === 3 || cb.status === 7) {
        log?.warn({ templateId, status: cb.status }, SAVE_ERRORS[cb.status]);
        await setError(SAVE_ERRORS[cb.status]!);
        return;
      }
      if (cb.status !== 2 && cb.status !== 6) return;
      if (!cb.url) {
        await setError('OnlyOffice не передал ссылку на файл');
        return;
      }
      let file: Buffer;
      try {
        file = await deps.fetchFile(cb.url);
      } catch (err) {
        downloadFailed = true;
        throw err;
      }
      if (!isZip(file)) {
        await setError('полученный от OnlyOffice файл не является документом');
        return;
      }
      await deps.storage.write(row.filePath, file);
      await tx
        .update(templates)
        .set({
          version: sql`${templates.version} + 1`,
          updatedAt: new Date(),
          updatedBy: await existingUserId(tx, cb.users?.[0]),
          lastSaveError: null,
          ...(cb.status === 2 ? { docKey: randomUUID() } : {}),
        })
        .where(eq(templates.id, row.id));
    });
  } catch (err) {
    if (downloadFailed) {
      await deps.db
        .update(templates)
        .set({ lastSaveError: 'не удалось скачать файл из OnlyOffice' })
        .where(eq(templates.id, templateId));
    }
    throw err;
  }
}
