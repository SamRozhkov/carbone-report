import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { AppDeps } from '../../deps';
import { oidcIdentities, oidcSessions, users } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { hashPassword } from './password';
import type { OidcPerson } from './oidc-client';

export async function resolveOidcUser(deps: AppDeps, person: OidcPerson) {
  // Never attach a directory identity to the recovery administrator.
  if (person.username.toLowerCase() === (deps.config.adminLogin ?? '').toLowerCase())
    throw new AppError(
      'OIDC_ACCOUNT_RESERVED',
      403,
      'эта учётная запись доступна только для локального входа',
    );
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
      if (existing)
        throw new AppError(
          'OIDC_ACCOUNT_LINK_REQUIRED',
          409,
          'учётная запись уже существует: администратор должен привязать Keycloak к ней',
        );
      [user] = await tx
        .insert(users)
        .values({
          login: person.username,
          role: 'user',
          passwordHash: await hashPassword(randomUUID()),
        })
        .onConflictDoNothing()
        .returning();
      if (!user)
        throw new AppError(
          'OIDC_ACCOUNT_LINK_REQUIRED',
          409,
          'требуется привязка учётной записи администратором',
        );
      await tx
        .insert(oidcIdentities)
        .values({ issuer: person.issuer, subject: person.subject, userId: user.id });
    }
    if (
      !user ||
      user.blocked ||
      user.login.toLowerCase() === (deps.config.adminLogin ?? '').toLowerCase()
    )
      throw new AppError('INVALID_CREDENTIALS', 401, 'вход недоступен');
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
