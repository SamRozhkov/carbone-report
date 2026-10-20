import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { signPasswordFailures } from '../../db/schema';
import type { RunFileTx } from '../../lib/run-file-gate';

export const SIGN_FAILURE_LIMIT = 5;
export const SIGN_FAILURE_WINDOW_MS = 15 * 60_000;

/** Подпись запрещена, пока неверных не меньше пяти и окно (15 минут от первой ошибки) не закончилось. */
export function isSignBlocked(
  row: { count: number; windowStart: Date } | undefined,
  now: Date,
): boolean {
  return (
    !!row &&
    row.count >= SIGN_FAILURE_LIMIT &&
    row.windowStart.getTime() + SIGN_FAILURE_WINDOW_MS > now.getTime()
  );
}

export async function signBlocked(db: Db | RunFileTx, userId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ count: signPasswordFailures.count, windowStart: signPasswordFailures.windowStart })
    .from(signPasswordFailures)
    .where(eq(signPasswordFailures.userId, userId));
  return isSignBlocked(row, now);
}

/** Неверный пароль: окно закончилось или его нет — новое окно с count = 1, иначе count + 1. */
export async function recordSignFailure(tx: RunFileTx, userId: string, now: Date): Promise<void> {
  const expired = sql`${signPasswordFailures.windowStart} + make_interval(secs => ${
    SIGN_FAILURE_WINDOW_MS / 1000
  }) <= ${now}`;
  await tx
    .insert(signPasswordFailures)
    .values({ userId, count: 1, windowStart: now })
    .onConflictDoUpdate({
      target: signPasswordFailures.userId,
      set: {
        count: sql`case when ${expired} then 1 else ${signPasswordFailures.count} + 1 end`,
        windowStart: sql`case when ${expired} then ${now} else ${signPasswordFailures.windowStart} end`,
      },
    });
}
