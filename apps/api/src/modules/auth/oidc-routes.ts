import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { oidcIdentities, oidcSessions, users } from '../../db/schema';
import { AppError, notFound, unauthorized } from '../../lib/errors';
import type { Guards } from './guards';
import { createOidcClient, type OidcClient, type OidcFlow } from './oidc-client';
import { resolveOidcUser } from './oidc-users';
import { SESSION_COOKIE } from './session';
import { setSessionCookie } from './routes';

const FLOW_COOKIE = 'oidc_flow';
const random = () => randomBytes(32).toString('base64url');
const flowKey = (state: string) => `cr:oidc:flow:${state}`;
export function safeOidcNext(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2000 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    [...value].some((c) => c === '\\' || c.charCodeAt(0) <= 32)
  )
    return '/reports';
  return value;
}
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function registerOidcRoutes(app: App, deps: AppDeps, guards: Guards, override?: OidcClient) {
  const settings = deps.config.oidc;
  const client = settings ? (override ?? createOidcClient(settings)) : null;
  const enabled = () => {
    if (!settings || !client) throw notFound('OIDC');
    return client;
  };
  const flowCookie = {
    httpOnly: true,
    secure: deps.config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/api/auth/oidc',
  };
  const noStore = (reply: { header: (name: string, value: string) => unknown }) => {
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
  };
  // No UI button is added. Administrators can test via a direct URL after configuration.
  app.get(
    '/api/auth/oidc/login',
    { logLevel: 'silent', config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      noStore(reply);
      const service = enabled();
      if (!deps.redis) throw new AppError('OIDC_UNAVAILABLE', 503, 'OIDC требует доступного Redis');
      const flow: OidcFlow = {
        state: random(),
        nonce: random(),
        verifier: random(),
        browser: random(),
        next: safeOidcNext((req.query as { next?: unknown }).next),
      };
      try {
        const url = await service.begin(flow);
        await deps.redis.set(flowKey(flow.state), JSON.stringify(flow), 'EX', 600, 'NX');
        reply.setCookie(FLOW_COOKIE, flow.browser, { ...flowCookie, maxAge: 600 });
        return reply.redirect(url);
      } catch {
        throw new AppError(
          'OIDC_UNAVAILABLE',
          503,
          'Keycloak недоступен, используйте обычный вход',
        );
      }
    },
  );
  app.get(
    '/api/auth/oidc/callback',
    { logLevel: 'silent', config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      noStore(reply);
      const service = enabled();
      reply.clearCookie(FLOW_COOKIE, flowCookie);
      const params = new URL(req.url, settings!.redirectUri).searchParams;
      const state = params.get('state');
      const browser = req.cookies[FLOW_COOKIE];
      if (
        !state ||
        !/^[A-Za-z0-9_-]{43}$/.test(state) ||
        !browser ||
        !deps.redis ||
        params.getAll('state').length !== 1
      )
        throw unauthorized();
      let flow: OidcFlow;
      try {
        const raw = await deps.redis.getdel(flowKey(state));
        if (!raw) throw new Error();
        flow = JSON.parse(raw) as OidcFlow;
        if (!same(flow.browser, browser) || !same(flow.state, state)) throw new Error();
      } catch {
        throw unauthorized();
      }
      let person;
      try {
        const callback = new URL(settings!.redirectUri);
        callback.search = params.toString();
        person = await service.complete(callback, flow);
        if (person.expiresAt.getTime() <= Date.now()) throw new Error();
      } catch {
        throw new AppError(
          'OIDC_INVALID_RESPONSE',
          401,
          'не удалось подтвердить вход через Keycloak',
        );
      }
      const { user, sessionId } = await resolveOidcUser(deps, person);
      await setSessionCookie(
        reply,
        deps,
        { id: user.id, login: user.login, role: user.role },
        user.sessionVersion,
        sessionId,
      );
      return reply.redirect(safeOidcNext(flow.next));
    },
  );
  app.post(
    '/api/auth/oidc/logout',
    { preHandler: guards.requireUser, logLevel: 'silent' },
    async (req, reply) => {
      noStore(reply);
      const service = enabled();
      if (req.oidcSessionId)
        await deps.db
          .update(oidcSessions)
          .set({ revokedAt: new Date() })
          .where(eq(oidcSessions.id, req.oidcSessionId));
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      try {
        return { url: await service.logoutUrl() };
      } catch {
        return { url: '/login' };
      }
    },
  );
  // Back-channel uses the signed logout token, not browser cookies.
  app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        const p = new URLSearchParams(String(body));
        done(null, {
          logout_token: p.getAll('logout_token').length === 1 ? p.get('logout_token') : '',
        });
      },
    );
    scoped.post(
      '/api/auth/oidc/backchannel-logout',
      {
        logLevel: 'silent',
        bodyLimit: 32768,
        config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
        schema: { body: z.object({ logout_token: z.string().min(1).max(16384) }) },
      },
      async (req, reply) => {
        noStore(reply);
        const service = enabled();
        let identity;
        try {
          identity = await service.verifyLogout(
            (req.body as { logout_token: string }).logout_token,
          );
        } catch {
          throw new AppError('OIDC_INVALID_LOGOUT', 400, 'неверный logout token');
        }
        const criteria = [eq(oidcSessions.issuer, identity.issuer)];
        if (identity.sid) criteria.push(eq(oidcSessions.providerSid, identity.sid));
        if (identity.subject) criteria.push(eq(oidcSessions.subject, identity.subject));
        await deps.db
          .update(oidcSessions)
          .set({ revokedAt: new Date() })
          .where(and(...criteria));
        return reply.status(200).send();
      },
    );
  });
  // Explicit account linking is an administrator action, never based solely on email.
  app.post(
    '/api/admin/auth/oidc/identities',
    {
      preHandler: guards.requireAdmin,
      logLevel: 'silent',
      schema: { body: z.object({ subject: z.string().min(1).max(255), userId: z.uuid() }) },
    },
    async (req, reply) => {
      noStore(reply);
      enabled();
      const [user] = await deps.db.select().from(users).where(eq(users.id, req.body.userId));
      if (!user || user.login.toLowerCase() === (deps.config.adminLogin ?? '').toLowerCase())
        throw new AppError('OIDC_ACCOUNT_RESERVED', 403, 'нельзя привязать эту учётную запись');
      const [existing] = await deps.db
        .select()
        .from(oidcIdentities)
        .where(
          and(
            eq(oidcIdentities.issuer, settings!.issuer),
            eq(oidcIdentities.subject, req.body.subject),
          ),
        );
      if (existing && existing.userId !== user.id)
        throw new AppError('CONFLICT', 409, 'внешняя учётная запись уже привязана');
      await deps.db
        .insert(oidcIdentities)
        .values({ issuer: settings!.issuer, subject: req.body.subject, userId: user.id })
        .onConflictDoNothing();
      // Re-check after a concurrent insert, do not claim a conflicting link succeeded.
      const [linked] = await deps.db
        .select()
        .from(oidcIdentities)
        .where(
          and(
            eq(oidcIdentities.issuer, settings!.issuer),
            eq(oidcIdentities.subject, req.body.subject),
          ),
        );
      if (linked?.userId !== user.id)
        throw new AppError('CONFLICT', 409, 'внешняя учётная запись уже привязана');
      return reply.status(201).send({ userId: user.id });
    },
  );
  app.delete(
    '/api/admin/auth/oidc/identities/:userId',
    {
      preHandler: guards.requireAdmin,
      logLevel: 'silent',
      schema: { params: z.object({ userId: z.uuid() }) },
    },
    async (req, reply) => {
      noStore(reply);
      enabled();
      await deps.db.transaction(async (tx) => {
        await tx
          .delete(oidcIdentities)
          .where(
            and(
              eq(oidcIdentities.issuer, settings!.issuer),
              eq(oidcIdentities.userId, req.params.userId),
            ),
          );
        await tx
          .update(oidcSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(oidcSessions.issuer, settings!.issuer),
              eq(oidcSessions.userId, req.params.userId),
            ),
          );
        await tx
          .update(users)
          .set({ sessionVersion: sql`${users.sessionVersion}+1` })
          .where(eq(users.id, req.params.userId));
      });
      return reply.status(204).send();
    },
  );
}
