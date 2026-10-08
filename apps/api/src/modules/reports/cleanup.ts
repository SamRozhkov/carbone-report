import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { reportRunFiles, reportRuns } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { runStoragePath } from './snapshot';

export async function cleanupOldReports(
  deps: AppDeps,
  now = new Date(),
  log?: { warn(o: unknown, msg?: string): void },
): Promise<number> {
  const threshold = new Date(now.getTime() - deps.config.reportRetentionDays * 86_400_000);
  const rows = await deps.db
    .select({ id: reportRuns.id, filePath: reportRuns.filePath, snapshot: reportRuns.snapshot })
    .from(reportRuns)
    .where(
      and(
        eq(reportRuns.fileDeleted, false),
        isNotNull(reportRuns.filePath),
        lt(reportRuns.createdAt, threshold),
      ),
    );
  let done = 0;
  for (const r of rows) {
    try {
      // Сначала отметка в базе, затем удаление: при сбое удаления остаётся безвредный файл-сирота,
      // а не строка, указывающая на отсутствующий файл. Строки собранных файлов уходят вместе с отметкой;
      // идущая сборка держит строку запуска FOR SHARE, поэтому отметка ждёт её конца.
      await deps.db.transaction(async (tx) => {
        await tx.update(reportRuns).set({ fileDeleted: true }).where(eq(reportRuns.id, r.id));
        await tx.delete(reportRunFiles).where(eq(reportRunFiles.runId, r.id));
      });
      // Снимок — каталог reports/<runId>/ целиком, старый запуск — его единственный файл.
      await deps.storage.remove(runStoragePath(r)!);
      done++;
    } catch (err) {
      log?.warn({ err, runId: r.id }, 'не удалось удалить файл отчёта');
    }
  }
  return done;
}

export function startCleanupTimer(
  deps: AppDeps,
  log: { error(o: unknown, msg?: string): void; warn(o: unknown, msg?: string): void },
): () => void {
  const tick = () =>
    cleanupOldReports(deps, new Date(), log).catch((e) =>
      log.error(e, 'очистка отчётов не удалась'),
    );
  void tick();
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
