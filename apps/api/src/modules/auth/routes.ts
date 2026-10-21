import { randomUUID } from 'node:crypto';
import { LoginBody, type Features } from '@carbone-reports/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../../app';
import { oidcSessions, users, type UserRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { currentUser, type Guards } from './guards';
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from './password';
import {
  LEGACY_SESSION_COOKIE,
  sessionCookieName,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
  type SessionUser,
} from './session';

/** Атрибуты cookie сессии; удаление обязано передавать те же (в т.ч. Secure — иначе браузер игнорирует `__Host-`). */
const sessionCookieOptions = (deps: AppDeps) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: deps.config.cookieSecure,
  path: '/',
});

export async function setSessionCookie(
  reply: FastifyReply,
  deps: AppDeps,
  user: SessionUser,
  sv: number,
  oidcSessionId?: string,
): Promise<void> {
  reply.setCookie(
    sessionCookieName(deps.config.cookieSecure),
    await signSession(user, sv, deps.config.appSecret, oidcSessionId),
    { ...sessionCookieOptions(deps), maxAge: SESSION_TTL_SECONDS },
  );
}

/** Выход: очищает cookie текущего имени и, если оно другое, прежнюю `session` (иначе она останется в браузере). */
export function clearSessionCookies(reply: FastifyReply, deps: AppDeps): void {
  const name = sessionCookieName(deps.config.cookieSecure);
  const options = sessionCookieOptions(deps);
  reply.clearCookie(name, options);
  if (name !== LEGACY_SESSION_COOKIE) reply.clearCookie(LEGACY_SESSION_COOKIE, options);
}

/**
 * Первый успешный вход через LDAP заводит локальную запись (роль — LDAP_DEFAULT_ROLE,
 * пароль — случайный и неизвестный никому: локальным паролем такой аккаунт не войти,
 * только через LDAP). Дальше роль, блокировка и группы живут в БД и LDAP не трогает.
 */
/**
 * LDAP (особенно sAMAccountName в AD) регистр не различает: найти существующий локальный
 * аккаунт нужно и по логину в другом регистре, иначе при расхождении регистра (например,
 * аккаунт когда-то завёлся как «ivanov», а каталог сейчас отдаёт «Ivanov») завёлся бы
 * второй локальный аккаунт того же человека.
 */
function findByLoginCI(deps: AppDeps, login: string) {
  return deps.db
    .select()
    .from(users)
    .where(sql`lower(${users.login}) = lower(${login})`);
}

async function provisionLdapUser(deps: AppDeps, login: string): Promise<UserRow | undefined> {
  const role = deps.config.ldap?.defaultRole ?? 'user';
  const [inserted] = await deps.db
    .insert(users)
    .values({ login, passwordHash: await hashPassword(randomUUID()), role, authSource: 'ldap' })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  // Одновременный первый вход того же пользователя в параллельном запросе.
  const [existing] = await findByLoginCI(deps, login);
  return existing;
}

export function registerAuthRoutes(app: App, deps: AppDeps, guards: Guards): void {
  // Признак включённых функций для меню web (§26.3): в ответах входа и /api/auth/me.
  const withFeatures = (user: SessionUser): SessionUser & { features: Features } => ({
    ...user,
    features: { backups: deps.backupAgent !== null, feedback: Boolean(deps.config.feedback) },
  });

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

      // Встроенный ADMIN_LOGIN входит только по локальному паролю: иначе пользователь
      // каталога с тем же логином (в любом регистре — LDAP регистр обычно не различает)
      // получил бы его учётную запись.
      const adminLogin = deps.config.adminLogin?.toLowerCase();
      const isAdminLogin = (value: string) =>
        adminLogin !== undefined && value.toLowerCase() === adminLogin;

      // LDAP пробуем первым, если включён и локальный аккаунт не заблокирован.
      // Неудача (неверный пароль, сервер недоступен) — не ошибка: откатываемся
      // на локальный пароль, чтобы встроенный admin не терял доступ при сбое LDAP.
      const ldap = !row?.blocked && !isAdminLogin(login) ? deps.ldap : null;
      const canonicalLogin = ldap ? await ldap.authenticate(login, password) : null;
      if (canonicalLogin) {
        const rejectLdap = (reason: string, accountLogin: string): never => {
          req.log.warn({ login: accountLogin }, `вход через LDAP отклонён: ${reason}`);
          throw new AppError('INVALID_CREDENTIALS', 401, 'неверный логин или пароль');
        };
        // Канонический логин из каталога (например, uid записи, найденной по почте) совпал
        // с ADMIN_LOGIN — отказ без отката на локальный пароль с этим вводом.
        if (isAdminLogin(canonicalLogin))
          rejectLdap('логин встроенного администратора', canonicalLogin);
        let existing: UserRow | undefined;
        if (deps.config.ldap?.loginAttribute) {
          // LDAP_USER_FILTER может искать запись не только по тому, что ввёл пользователь
          // (например, и по логину, и по почте): local-аккаунт при этом один на человека,
          // поэтому ищем/заводим его по каноническому логину без учёта регистра.
          existing =
            row && row.login.toLowerCase() === canonicalLogin.toLowerCase()
              ? row
              : (await findByLoginCI(deps, canonicalLogin))[0];
        } else {
          // Без LDAP_LOGIN_ATTRIBUTE — как в прежних версиях: аккаунт по введённому логину.
          existing = row;
        }
        const ldapUser = existing ?? (await provisionLdapUser(deps, canonicalLogin));
        if (!ldapUser || ldapUser.blocked) {
          throw new AppError('INVALID_CREDENTIALS', 401, 'неверный логин или пароль');
        }
        // Найденный (или найденный при гонке заведения) аккаунт — встроенный администратор.
        if (isAdminLogin(ldapUser.login))
          rejectLdap('логин встроенного администратора', ldapUser.login);
        // Аккаунт заведён входом через Keycloak: запись каталога с тем же логином — не повод
        // открывать его. LDAP-пользователю Keycloak привязывает администратор, а не наоборот.
        if (ldapUser.authSource === 'oidc')
          rejectLdap('аккаунт заведён через Keycloak', ldapUser.login);
        const user = { id: ldapUser.id, login: ldapUser.login, role: ldapUser.role };
        await setSessionCookie(reply, deps, user, ldapUser.sessionVersion);
        return withFeatures(user);
      }

      const ok = await verifyPassword(row?.passwordHash ?? (await DUMMY_HASH_PROMISE), password);
      if (!row || !ok || row.blocked) {
        throw new AppError('INVALID_CREDENTIALS', 401, 'неверный логин или пароль');
      }
      const user = { id: row.id, login: row.login, role: row.role };
      await setSessionCookie(reply, deps, user, row.sessionVersion);
      return withFeatures(user);
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[sessionCookieName(deps.config.cookieSecure)];
    const session = token ? await verifySession(token, deps.config.appSecret) : null;
    if (session?.oidcSessionId)
      await deps.db
        .update(oidcSessions)
        .set({ revokedAt: new Date() })
        .where(eq(oidcSessions.id, session.oidcSessionId));
    clearSessionCookies(reply, deps);
    return reply.status(204).send();
  });

  app.post('/api/auth/logout-all', { preHandler: guards.requireUser }, async (req, reply) => {
    await deps.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, currentUser(req).id));
    clearSessionCookies(reply, deps);
    return reply.status(204).send();
  });

  app.get('/api/auth/me', { preHandler: guards.requireUser }, async (req) =>
    withFeatures(currentUser(req)),
  );
}
