import { randomUUID } from 'node:crypto';
import { LoginBody } from '@carbone-reports/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../../app';
import { users, type UserRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { currentUser, type Guards } from './guards';
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from './password';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, type SessionUser } from './session';

export async function setSessionCookie(
  reply: FastifyReply,
  deps: AppDeps,
  user: SessionUser,
  sv: number,
): Promise<void> {
  reply.setCookie(SESSION_COOKIE, await signSession(user, sv, deps.config.appSecret), {
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.config.cookieSecure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/**
 * Первый успешный вход через LDAP заводит локальную запись (роль — LDAP_DEFAULT_ROLE,
 * пароль — случайный и неизвестный никому: локальным паролем такой аккаунт не войти,
 * только через LDAP). Дальше роль, блокировка и группы живут в БД и LDAP не трогает.
 */
async function provisionLdapUser(deps: AppDeps, login: string): Promise<UserRow | undefined> {
  const role = deps.config.ldap?.defaultRole ?? 'user';
  const [inserted] = await deps.db
    .insert(users)
    .values({ login, passwordHash: await hashPassword(randomUUID()), role })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  // Одновременный первый вход того же пользователя в параллельном запросе.
  const [existing] = await deps.db.select().from(users).where(eq(users.login, login));
  return existing;
}

export function registerAuthRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const loginRateLimit = {
    max: 10,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    // Ключ — логин: подбор пароля к одной учётной записи с любых адресов.
    keyGenerator: (req: FastifyRequest) =>
      String((req.body as { login?: unknown } | undefined)?.login ?? '')
        .trim()
        .toLowerCase(),
    errorResponseBuilder: () =>
      new AppError('TOO_MANY_ATTEMPTS', 429, 'слишком много попыток входа, повторите через минуту'),
  };

  // Лимит по IP поверх лимита по логину: перебор многих логинов с одного адреса.
  // Ключ — стандартный генератор плагина: req.ip (его дописывает nginx, TRUSTED_PROXY_HOPS
  // в app.ts), адреса IPv6 группируются по подсети /64.
  // createRateLimit 11.2 берёт хранилище плагина (store.child) с тем же запасом в памяти,
  // а nameSpace из опций читает FallbackStore.child. В типах CreateRateLimitOptions поля
  // nameSpace нет, поэтому опции передаются через переменную, без проверки лишних полей.
  const ipLimitOptions = {
    max: 30,
    timeWindow: '1 minute',
    nameSpace: 'cr:rl-ip:',
  };
  const ipLimit = app.createRateLimit(ipLimitOptions);

  app.post(
    '/api/auth/login',
    {
      schema: { body: LoginBody },
      config: { rateLimit: loginRateLimit },
      // Свой preHandler идёт раньше лимита по логину (плагин дописывает свой хук в конец):
      // оба считают независимо, отвечает тот, что исчерпан первым.
      preHandler: async (req, reply) => {
        const r = await ipLimit(req);
        if (!r.isAllowed && r.isExceeded) {
          reply
            .header('retry-after', r.ttlInSeconds)
            .header('x-ratelimit-limit', r.max)
            .header('x-ratelimit-remaining', 0);
          throw new AppError(
            'TOO_MANY_ATTEMPTS',
            429,
            'слишком много попыток входа с этого адреса, повторите через минуту',
          );
        }
      },
    },
    async (req, reply) => {
      const { login, password } = req.body;
      const [row] = await deps.db.select().from(users).where(eq(users.login, login));

      // LDAP пробуем первым, если включён и локальный аккаунт не заблокирован.
      // Неудача (неверный пароль, сервер недоступен) — не ошибка: откатываемся
      // на локальный пароль, чтобы встроенный admin не терял доступ при сбое LDAP.
      // Встроенный ADMIN_LOGIN входит только по локальному паролю: иначе пользователь
      // каталога с тем же логином получил бы его учётную запись.
      const ldap = !row?.blocked && login !== deps.config.adminLogin ? deps.ldap : null;
      if (ldap && (await ldap.authenticate(login, password))) {
        const ldapUser = row ?? (await provisionLdapUser(deps, login));
        if (!ldapUser || ldapUser.blocked) {
          throw new AppError('INVALID_CREDENTIALS', 401, 'неверный логин или пароль');
        }
        const user = { id: ldapUser.id, login: ldapUser.login, role: ldapUser.role };
        await setSessionCookie(reply, deps, user, ldapUser.sessionVersion);
        return user;
      }

      const ok = await verifyPassword(row?.passwordHash ?? (await DUMMY_HASH_PROMISE), password);
      if (!row || !ok || row.blocked) {
        throw new AppError('INVALID_CREDENTIALS', 401, 'неверный логин или пароль');
      }
      const user = { id: row.id, login: row.login, role: row.role };
      await setSessionCookie(reply, deps, user, row.sessionVersion);
      return user;
    },
  );

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.post('/api/auth/logout-all', { preHandler: guards.requireUser }, async (req, reply) => {
    await deps.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, currentUser(req).id));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: guards.requireUser }, async (req) => currentUser(req));
}
