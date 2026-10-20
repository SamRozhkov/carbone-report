import { and, eq, lt } from 'drizzle-orm';
import { gostSignPending } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { Deadline } from '../../lib/deadline';
import { RUN_FILE_LOCK_CLASS } from '../reports/snapshot';

class SignerBusy extends Error {}

/**
 * Ежечасная очистка (§42.5): истёкшие ожидания подписи ГОСТ и их черновики. Каждое — под блокировкой
 * подписи пользователя без ожидания: идущая подготовка того же пользователя не потеряет только что
 * записанный черновик (путь у запуска один). Занято — ожидание удалится в следующий раз.
 * Возвращает число удалённых ожиданий.
 */
export async function cleanupGostPending(
  deps: Pick<AppDeps, 'db' | 'storage' | 'runFileGate' | 'config'>,
  now = new Date(),
  log?: { warn(o: unknown, msg?: string): void },
): Promise<number> {
  const rows = await deps.db
    .select({ runId: gostSignPending.runId, userId: gostSignPending.userId })
    .from(gostSignPending)
    .where(lt(gostSignPending.expiresAt, now));
  let done = 0;
  for (const r of rows) {
    try {
      const removed = await deps.runFileGate(
        RUN_FILE_LOCK_CLASS,
        `sign:${r.userId}`,
        new Deadline(deps.config.reportTimeoutMs),
        async (tx) => {
          // Пока ждали, ожидание могли заменить новой подготовкой или завершить.
          const [gone] = await tx
            .delete(gostSignPending)
            .where(and(eq(gostSignPending.runId, r.runId), lt(gostSignPending.expiresAt, now)))
            .returning({ draftPath: gostSignPending.draftPath });
          if (!gone) return false;
          // Сбой удаления файла откатывает строку: повтор — при следующей очистке.
          await deps.storage.remove(gone.draftPath);
          return true;
        },
        { ifBusy: () => new SignerBusy() },
      );
      if (removed) done++;
    } catch (err) {
      if (!(err instanceof SignerBusy))
        log?.warn({ err, runId: r.runId }, 'не удалось удалить ожидание подписи ГОСТ');
    }
  }
  return done;
}
