import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { reportRuns } from '../../db/schema';
import type { AppDeps } from '../../deps';

export async function cleanupOldReports(deps: AppDeps, now = new Date()): Promise<number> {
  const threshold = new Date(now.getTime() - deps.config.reportRetentionDays * 86_400_000);
  const rows = await deps.db
    .select({ id: reportRuns.id, filePath: reportRuns.filePath })
    .from(reportRuns)
    .where(and(eq(reportRuns.fileDeleted, false), isNotNull(reportRuns.filePath), lt(reportRuns.createdAt, threshold)));
  for (const r of rows) {
    await deps.storage.remove(r.filePath!);
    await deps.db.update(reportRuns).set({ fileDeleted: true }).where(eq(reportRuns.id, r.id));
  }
  return rows.length;
}

export function startCleanupTimer(
  deps: AppDeps,
  log: { error(o: unknown, msg?: string): void },
): () => void {
  const tick = () => cleanupOldReports(deps).catch((e) => log.error(e, 'очистка отчётов не удалась'));
  void tick();
  const timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
