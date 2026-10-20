import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { signPasswordFailures } from '../../db/schema';
import type { RunFileTx } from '../../lib/run-file-gate';

export const SIGN_FAILURE_LIMIT = 5;
export const SIGN_FAILURE_WINDOW_MS = 15 * 60_000;

// Окно считает база (now()): часы экземпляров API не участвуют, и ранняя проверка с решающей
// под блокировкой не расходятся.
const windowSecs = SIGN_FAILURE_WINDOW_MS / 1000;

/** Подпись запрещена, пока неверных не меньше пяти и окно (15 минут от первой ошибки) не закончилось. */
export async function signBlocked(db: Db | RunFileTx, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: signPasswordFailures.userId })
    .from(signPasswordFailures)
    .where(
      and(
        eq(signPasswordFailures.userId, userId),
        gte(signPasswordFailures.count, SIGN_FAILURE_LIMIT),
        sql`${signPasswordFailures.windowStart} + make_interval(secs => ${windowSecs}) > now()`,
      ),
    );
  return rows.length > 0;
}

/** Неверный пароль: окно закончилось или его нет — новое окно с count = 1, иначе count + 1. */
export async function recordSignFailure(tx: RunFileTx, userId: string): Promise<void> {
  const expired = sql`${signPasswordFailures.windowStart} + make_interval(secs => ${windowSecs}) <= now()`;
  await tx
    .insert(signPasswordFailures)
    .values({ userId, count: 1, windowStart: sql`now()` })
    .onConflictDoUpdate({
      target: signPasswordFailures.userId,
      set: {
        count: sql`case when ${expired} then 1 else ${signPasswordFailures.count} + 1 end`,
        windowStart: sql`case when ${expired} then now() else ${signPasswordFailures.windowStart} end`,
      },
    });
}
