import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { AppDeps } from '../../deps';
import { oidcIdentities, oidcSessions, users } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { hashPassword } from './password';
import type { OidcPerson } from './oidc-client';

export async function resolveOidcUser(
  deps: AppDeps,
  person: OidcPerson,
  log?: Pick<FastifyBaseLogger, 'warn'>,
) {
  // Один и тот же ответ для всех отказов по логину: причина — только в журнале, иначе по коду
  // ошибки можно выяснить, занят ли логин и является ли он логином встроенного администратора.
  const unavailable: (reason: string) => never = (reason) => {
    log?.warn({ login: person.username, sub: person.subject }, `OIDC: вход отклонён — ${reason}`);
    throw new AppError('OIDC_LOGIN_UNAVAILABLE', 403, { key: 'oidc.loginUnavailable' });
  };
  // Never attach a directory identity to the recovery administrator.
  if (person.username.toLowerCase() === (deps.config.adminLogin ?? '').toLowerCase())
    unavailable('логин встроенного администратора');
  return deps.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([person.issuer, person.subject])}, 0))`,
    );
    const [identity] = await tx
      .select()
      .from(oidcIdentities)
      .where(
        and(eq(oidcIdentities.issuer, person.issuer), eq(oidcIdentities.subject, person.subject)),
      );
    let user;
    if (identity) [user] = await tx.select().from(users).where(eq(users.id, identity.userId));
    else {
      const [existing] = await tx
        .select()
        .from(users)
        .where(sql`lower(${users.login}) = lower(${person.username})`);
      if (existing) unavailable('логин занят, нужна привязка администратором');
      [user] = await tx
        .insert(users)
        .values({
          login: person.username,
          role: 'user',
          passwordHash: await hashPassword(randomUUID()),
          authSource: 'oidc',
        })
        .onConflictDoNothing()
        .returning();
      if (!user) unavailable('логин занят, нужна привязка администратором');
      await tx
        .insert(oidcIdentities)
        .values({ issuer: person.issuer, subject: person.subject, userId: user.id });
    }
    if (
      !user ||
      user.blocked ||
      user.login.toLowerCase() === (deps.config.adminLogin ?? '').toLowerCase()
    )
      throw new AppError('INVALID_CREDENTIALS', 401, { key: 'oidc.signInUnavailable' });
    const sessionId = randomUUID();
    await tx.insert(oidcSessions).values({
      id: sessionId,
      issuer: person.issuer,
      subject: person.subject,
      providerSid: person.sid,
      userId: user.id,
      expiresAt: person.expiresAt,
    });
    return { user, sessionId };
  });
}

/**
 * Удаляет истёкшие OIDC-сессии и отозванные больше суток назад (отозванная запись ещё сутки
 * видна для разбора). Возвращает число удалённых строк.
 */
export async function cleanupOidcSessions(deps: Pick<AppDeps, 'db'>, now = new Date()) {
  const rows = await deps.db
    .delete(oidcSessions)
    .where(
      or(
        lt(oidcSessions.expiresAt, now),
        lt(oidcSessions.revokedAt, new Date(now.getTime() - 86_400_000)),
      ),
    )
    .returning({ id: oidcSessions.id });
  return rows.length;
}
