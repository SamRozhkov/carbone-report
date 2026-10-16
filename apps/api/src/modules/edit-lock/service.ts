import { EDIT_LOCK_TTL_SECONDS, type EditLockState } from '@carbone-reports/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { templateEditLocks, templates, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError, notFound } from '../../lib/errors';

export type LockDb = Pick<AppDeps['db'], 'select' | 'insert' | 'update' | 'delete'>;

export interface ActiveLock {
  holder: string;
  userId: string;
  login: string;
  since: Date;
}

/** Блокировка действует 60 с с последнего продления — по часам базы (§38.1). */
export const lockAlive: SQL = sql`${templateEditLocks.heartbeatAt} > now() - make_interval(secs => ${EDIT_LOCK_TTL_SECONDS})`;

export const lockedError = (login: string) =>
  new AppError('TEMPLATE_LOCKED', 409, `шаблон редактирует ${login}`);

export async function activeLock(db: LockDb, templateId: string): Promise<ActiveLock | null> {
  const [r] = await db
    .select({
      holder: templateEditLocks.holder,
      userId: templateEditLocks.userId,
      login: users.login,
      since: templateEditLocks.acquiredAt,
    })
    .from(templateEditLocks)
    .innerJoin(users, eq(users.id, templateEditLocks.userId))
    .where(and(eq(templateEditLocks.templateId, templateId), lockAlive));
  return r ?? null;
}

export function lockState(lock: ActiveLock | null, holder: string, userId: string): EditLockState {
  if (!lock) return { state: 'free' };
  if (lock.holder === holder) return { state: 'mine' };
  return {
    state: 'other',
    user: { id: lock.userId, login: lock.login },
    since: lock.since.toISOString(),
    sameUser: lock.userId === userId,
  };
}

/**
 * Строка шаблона `for share`: шаблон существует (иначе 404), и захват не пересекается с заменой файла,
 * удалением и импортом, которые проверяют блокировку под `for update` (§38.2).
 */
async function shareTemplate(tx: LockDb, templateId: string): Promise<void> {
  const [row] = await tx
    .select({ id: templates.id })
    .from(templates)
    .where(eq(templates.id, templateId))
    .for('share');
  if (!row) throw notFound('шаблон');
}

/** Захват или продление (§38.1): одна строка — `insert … on conflict … where`. */
export async function acquireLock(
  db: AppDeps['db'],
  templateId: string,
  holder: string,
  userId: string,
): Promise<EditLockState> {
  return db.transaction(async (tx) => {
    await shareTemplate(tx, templateId);
    const got = await tx
      .insert(templateEditLocks)
      .values({ templateId, holder, userId, acquiredAt: sql`now()`, heartbeatAt: sql`now()` })
      .onConflictDoUpdate({
        target: templateEditLocks.templateId,
        set: {
          holder,
          userId,
          // Своё продление не сдвигает начало блокировки.
          acquiredAt: sql`case when ${templateEditLocks.holder} = ${holder} then ${templateEditLocks.acquiredAt} else now() end`,
          heartbeatAt: sql`now()`,
        },
        setWhere: sql`${templateEditLocks.holder} = ${holder} or not (${lockAlive})`,
      })
      .returning({ templateId: templateEditLocks.templateId });
    if (got.length > 0) return { state: 'mine' } as const;
    return lockState(await activeLock(tx, templateId), holder, userId);
  });
}

/** Только чтение (вкладка в просмотре); свою блокировку продлевает. */
export async function peekLock(
  db: AppDeps['db'],
  templateId: string,
  holder: string,
  userId: string,
): Promise<EditLockState> {
  return db.transaction(async (tx) => {
    await shareTemplate(tx, templateId);
    const renewed = await tx
      .update(templateEditLocks)
      .set({ heartbeatAt: sql`now()` })
      .where(
        and(
          eq(templateEditLocks.templateId, templateId),
          eq(templateEditLocks.holder, holder),
          lockAlive,
        ),
      )
      .returning({ templateId: templateEditLocks.templateId });
    if (renewed.length > 0) return { state: 'mine' } as const;
    return lockState(await activeLock(tx, templateId), holder, userId);
  });
}

/**
 * Перехват (§38.1): блокировка переходит безусловно. Возвращает прежнюю действовавшую блокировку
 * другой вкладки (для forcesave) или null.
 */
export async function takeOverLock(
  db: AppDeps['db'],
  templateId: string,
  holder: string,
  userId: string,
): Promise<{ previous: ActiveLock | null; docKey: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: templates.id, docKey: templates.docKey })
      .from(templates)
      .where(eq(templates.id, templateId))
      .for('share');
    if (!row) throw notFound('шаблон');
    const before = await activeLock(tx, templateId);
    await tx
      .insert(templateEditLocks)
      .values({ templateId, holder, userId, acquiredAt: sql`now()`, heartbeatAt: sql`now()` })
      .onConflictDoUpdate({
        target: templateEditLocks.templateId,
        set: { holder, userId, acquiredAt: sql`now()`, heartbeatAt: sql`now()` },
      });
    return { previous: before && before.holder !== holder ? before : null, docKey: row.docKey };
  });
}

export async function releaseLock(db: LockDb, templateId: string, holder: string): Promise<void> {
  await db
    .delete(templateEditLocks)
    .where(and(eq(templateEditLocks.templateId, templateId), eq(templateEditLocks.holder, holder)));
}

export async function assertNotLockedByOther(
  db: LockDb,
  templateId: string,
  holder: string | null,
): Promise<void> {
  const lock = await activeLock(db, templateId);
  if (lock && lock.holder !== holder) throw lockedError(lock.login);
}

export async function assertLockedBy(
  db: LockDb,
  templateId: string,
  holder: string,
): Promise<void> {
  const lock = await activeLock(db, templateId);
  if (!lock) throw new AppError('TEMPLATE_LOCKED', 409, 'начните редактирование');
  if (lock.holder !== holder) throw lockedError(lock.login);
}
