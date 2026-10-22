import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { templateEditors, templates, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError, ruText } from '../../lib/errors';
import { isZip } from '../../lib/http';
import { editRight } from '../access/permissions';
import { discardUncommittedFile, templateFilePath } from '../templates/service';
import { toInternalDownloadUrl } from './download-url';
import { verifyOnlyOfficeCallback } from './jwt';

const Callback = z.object({
  key: z.string(),
  status: z.number().int(),
  url: z.string().optional(),
  users: z.array(z.string()).optional(),
});

// Ошибки сохранения хранятся в шаблоне (lastSaveError) по-русски: callback приходит от
// Document Server, языка пользователя у него нет.
const SAVE_ERRORS: Record<number, string> = {
  3: 'onlyoffice.saveFailed',
  7: 'onlyoffice.forceSaveFailed',
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
  throw new AppError('FORBIDDEN', 403, { key: 'onlyoffice.invalidSignature' });
}

const NO_RIGHT_TO_SAVE = ruText('onlyoffice.noRightToSave');

/**
 * Первый из сохраняющих пользователей (id из editor-config), у кого право правки ещё есть.
 * Роль и блокировка — из БД: понижение или отзыв права закрывает и уже открытую сессию (§43.1).
 */
async function authorisedSaver(
  db: Pick<AppDeps['db'], 'select'>,
  templateId: string,
  ids: string[] | undefined,
): Promise<string | null> {
  const valid = [...new Set(ids ?? [])].filter((id) => z.uuid().safeParse(id).success);
  if (valid.length === 0) return null;
  const [t] = await db
    .select({ ownerId: templates.ownerId })
    .from(templates)
    .where(eq(templates.id, templateId));
  if (!t) return null;
  const found = await db
    .select({ id: users.id, login: users.login, role: users.role })
    .from(users)
    .where(and(inArray(users.id, valid), eq(users.blocked, false)));
  const granted = new Set(
    (
      await db
        .select({ id: templateEditors.userId })
        .from(templateEditors)
        .where(
          and(eq(templateEditors.templateId, templateId), inArray(templateEditors.userId, valid)),
        )
    ).map((r) => r.id),
  );
  // Порядок cb.users сохраняется: версию подписывает первый из имеющих право.
  for (const id of valid) {
    const u = found.find((f) => f.id === id);
    if (u && editRight(u, t, granted.has(id))) return id;
  }
  return null;
}

export async function handleCallback(
  deps: AppDeps,
  templateId: string,
  body: unknown,
  authorization: string | undefined,
  log?: { info(o: unknown, msg?: string): void; warn(o: unknown, msg?: string): void },
): Promise<void> {
  const parsed = Callback.safeParse(await verifiedPayload(deps, body, authorization));
  if (!parsed.success) throw new AppError('BAD_CALLBACK', 400, { key: 'onlyoffice.badCallback' });
  const cb = parsed.data;
  // Каждый callback — в журнал: без статуса не понять, почему сохранение не дошло до версии.
  log?.info({ templateId, status: cb.status }, 'callback OnlyOffice');
  if (![2, 3, 6, 7].includes(cb.status)) return; // остальные статусы не требуют действий и блокировок
  const [current] = await deps.db.select().from(templates).where(eq(templates.id, templateId));
  if (!current) return; // шаблон удалён: подтверждаем, чтобы Document Server не повторял callback
  // Колбэк от закрытой сессии (ключ уже сменился) не должен затирать новую версию.
  if (cb.key !== current.docKey) {
    log?.warn({ templateId, status: cb.status }, 'callback OnlyOffice от прежней сессии пропущен');
    return;
  }

  // Ошибка пишется, только если сессия всё ещё текущая. Метка строго растёт: повтор той же ошибки
  // в ту же миллисекунду (ISO хранит мс) всё равно отличим от прежней (§22.7).
  const errorFields = (msg: string) => ({
    lastSaveError: msg,
    lastSaveErrorAt: sql`greatest(now(), ${templates.lastSaveErrorAt} + interval '1 millisecond')`,
  });
  const setError = (msg: string) =>
    deps.db
      .update(templates)
      .set(errorFields(msg))
      .where(and(eq(templates.id, templateId), eq(templates.docKey, cb.key)));

  // Отказ в сохранении: файл не трогаем. При закрытии сессии (status 2) ключ меняется, чтобы
  // следующее открытие взяло файл из хранилища, а не отвергнутые правки из кэша Document Server.
  const rejectFields = () => ({
    ...errorFields(NO_RIGHT_TO_SAVE),
    ...(cb.status === 2 ? { docKey: randomUUID() } : {}),
  });

  if (cb.status === 3 || cb.status === 7) {
    log?.warn({ templateId, status: cb.status }, SAVE_ERRORS[cb.status]);
    await setError(ruText(SAVE_ERRORS[cb.status]!));
    return;
  }
  if (!cb.url) {
    await setError(ruText('onlyoffice.noFileUrl'));
    return;
  }
  // Скачиваем только из кэша Document Server по внутреннему адресу, а не по присланной ссылке.
  const downloadUrl = toInternalDownloadUrl(cb.url, deps.config.onlyofficeInternalUrl);
  if (!downloadUrl) {
    log?.warn({ templateId, status: cb.status }, 'недопустимая ссылка на файл от OnlyOffice');
    await setError(ruText('onlyoffice.badFileUrl'));
    return;
  }

  // Право правки отозвано (понижение роли, удаление из редакторов, блокировка): файл не трогаем,
  // а Document Server получает {error:0}, чтобы не повторял callback.
  if (!(await authorisedSaver(deps.db, templateId, cb.users))) {
    log?.warn({ templateId, status: cb.status, users: cb.users }, NO_RIGHT_TO_SAVE);
    await deps.db
      .update(templates)
      .set(rejectFields())
      .where(and(eq(templates.id, templateId), eq(templates.docKey, cb.key)));
    return;
  }

  // Скачивание — без блокировки строки (до 60 с); ключ и право сверяются повторно под блокировкой.
  let file: Buffer;
  try {
    file = await deps.fetchFile(downloadUrl);
  } catch (err) {
    await setError(ruText('onlyoffice.downloadFailed'));
    throw err;
  }
  if (!isZip(file)) {
    await setError(ruText('onlyoffice.notDocument'));
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
      // Право могли отозвать, пока файл скачивался.
      const saver = await authorisedSaver(tx, templateId, cb.users);
      if (!saver) {
        log?.warn({ templateId, status: cb.status, users: cb.users }, NO_RIGHT_TO_SAVE);
        await tx.update(templates).set(rejectFields()).where(eq(templates.id, row.id));
        return;
      }
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
          updatedBy: saver,
          lastSaveError: null,
          lastSaveErrorAt: null,
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
  // Удаление — в фоне: во время бэкапа оно ждёт блокировку, а сохранение ждать не должно (§17.1).
  if (previous && previous !== written) {
    void deps.storage
      .remove(previous)
      .catch((e) => log?.warn({ err: e, templateId }, 'старый файл шаблона не удалён'));
  }
}
