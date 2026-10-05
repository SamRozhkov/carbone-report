import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { templates, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { isZip } from '../../lib/http';
import { discardUncommittedFile, templateFilePath } from '../templates/service';
import { toInternalDownloadUrl } from './download-url';
import { verifyOnlyOfficeCallback } from './jwt';

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

async function verifiedPayload(
  deps: AppDeps,
  body: unknown,
  authorization?: string,
): Promise<unknown> {
  const secret = deps.config.onlyofficeJwtSecret;
  const bodyToken = (body as { token?: unknown } | null)?.token;
  try {
    if (typeof bodyToken === 'string') return await verifyOnlyOfficeCallback(bodyToken, secret);
    if (authorization?.startsWith('Bearer ')) {
      const claims = await verifyOnlyOfficeCallback(authorization.slice(7), secret);
      return claims.payload ?? claims;
    }
  } catch {
    // неверная подпись — ниже
  }
  throw new AppError('FORBIDDEN', 403, 'неверная подпись OnlyOffice');
}

async function existingUserId(
  db: Pick<AppDeps['db'], 'select'>,
  id: string | undefined,
): Promise<string | null> {
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
  if (!parsed.success)
    throw new AppError('BAD_CALLBACK', 400, 'неверный формат callback OnlyOffice');
  const cb = parsed.data;
  if (![2, 3, 6, 7].includes(cb.status)) return; // остальные статусы не требуют действий и блокировок
  const [current] = await deps.db.select().from(templates).where(eq(templates.id, templateId));
  if (!current) return; // шаблон удалён: подтверждаем, чтобы Document Server не повторял callback
  // Колбэк от закрытой сессии (ключ уже сменился) не должен затирать новую версию.
  if (cb.key !== current.docKey) return;

  // Ошибка пишется, только если сессия всё ещё текущая.
  const setError = (msg: string) =>
    deps.db
      .update(templates)
      .set({ lastSaveError: msg })
      .where(and(eq(templates.id, templateId), eq(templates.docKey, cb.key)));

  if (cb.status === 3 || cb.status === 7) {
    log?.warn({ templateId, status: cb.status }, SAVE_ERRORS[cb.status]);
    await setError(SAVE_ERRORS[cb.status]!);
    return;
  }
  if (!cb.url) {
    await setError('OnlyOffice не передал ссылку на файл');
    return;
  }
  // Скачиваем только из кэша Document Server по внутреннему адресу, а не по присланной ссылке.
  const downloadUrl = toInternalDownloadUrl(cb.url, deps.config.onlyofficeInternalUrl);
  if (!downloadUrl) {
    log?.warn({ templateId, status: cb.status }, 'недопустимая ссылка на файл от OnlyOffice');
    await setError('OnlyOffice передал недопустимую ссылку на файл');
    return;
  }

  // Скачивание — без блокировки строки (до 60 с); ключ сверяется повторно под блокировкой.
  let file: Buffer;
  try {
    file = await deps.fetchFile(downloadUrl);
  } catch (err) {
    await setError('не удалось скачать файл из OnlyOffice');
    throw err;
  }
  if (!isZip(file)) {
    await setError('полученный от OnlyOffice файл не является документом');
    return;
  }

  let written: string | undefined;
  let previous: string | undefined;
  try {
    await deps.db.transaction(async (tx) => {
      // Блокировка строки сериализует запись версии с другими callback-ами и ручной заменой файла.
      const [row] = await tx
        .select()
        .from(templates)
        .where(eq(templates.id, templateId))
        .for('update');
      // Пока файл скачивался, сессия могла смениться (ручная замена, другой callback).
      if (!row || cb.key !== row.docKey) return;
      // Новая версия — новый файл: при сбое коммита строка продолжает указывать на прежний.
      written = templateFilePath(row.id, row.fileExt, row.version + 1);
      await deps.storage.write(written, file);
      previous = row.filePath;
      await tx
        .update(templates)
        .set({
          version: row.version + 1,
          filePath: written,
          updatedAt: new Date(),
          updatedBy: await existingUserId(tx, cb.users?.[0]),
          lastSaveError: null,
          ...(cb.status === 2 ? { docKey: randomUUID() } : {}),
        })
        .where(eq(templates.id, row.id));
    });
  } catch (err) {
    // Транзакция не прошла: новый файл — сирота, убираем.
    if (written) {
      const orphan = written;
      await discardUncommittedFile(deps, templateId, orphan, log).catch((e) =>
        log?.warn({ err: e, filePath: orphan }, 'несохранённый файл шаблона не удалён'),
      );
    }
    throw err;
  }
  // Сюда доходим только после коммита; previous задан, только если версия записана.
  if (previous && previous !== written) {
    await deps.storage
      .remove(previous)
      .catch((e) => log?.warn({ err: e, templateId }, 'старый файл шаблона не удалён'));
  }
}
