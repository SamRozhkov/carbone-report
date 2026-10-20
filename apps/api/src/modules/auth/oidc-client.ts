import { CreateUserBody } from '@carbone-reports/shared';
import * as oidc from 'openid-client';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { OidcConfig } from '../../config';
import { SESSION_TTL_SECONDS } from './session';

export type OidcFlow = {
  state: string;
  verifier: string;
  nonce: string;
  browser: string;
  next: string;
};
export type OidcPerson = {
  issuer: string;
  subject: string;
  username: string;
  sid?: string;
  expiresAt: Date;
};
export type LogoutPerson = { issuer: string; jti: string; subject?: string; sid?: string };
export type Discover = (config: OidcConfig) => Promise<oidc.Configuration>;

/**
 * Провайдер недоступен (discovery, JWKS: сеть, тайм-аут, 5xx, неверный ответ) — в отличие
 * от неверного токена это сбой, который должен видеть Keycloak и администратор (503).
 */
export class OidcUnavailableError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'OidcUnavailableError';
  }
}

/** preferred_username не годится в локальный логин — отказ входа с понятной ошибкой. */
export class OidcUsernameError extends Error {
  constructor() {
    super('preferred_username не подходит как логин');
    this.name = 'OidcUsernameError';
  }
}

// Невидимые символы и управление направлением текста (bidi, zero-width, BOM): с ними два
// логина, одинаковые на вид, были бы разными строками.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

/**
 * Логин из preferred_username: те же ограничения, что у логина, заведённого администратором
 * (CreateUserBody: trim, длина), плюс запрет управляющих и невидимых символов. null — не годится.
 */
export function oidcUsername(value: unknown): string | null {
  // До trim: он молча срезал бы BOM по краям, а такой логин из Keycloak всё равно подозрителен.
  if (typeof value === 'string' && INVISIBLE.test(value)) return null;
  const parsed = CreateUserBody.shape.login.safeParse(value);
  if (!parsed.success) return null;
  const username = parsed.data;
  if ([...username].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  return username;
}

/** Lazy discovery: disabled OIDC never contacts Keycloak, failures can be retried. */
export function createOidcClient(
  settings: OidcConfig,
  discover: Discover = async (s) =>
    oidc.discovery(
      new URL(s.issuer),
      s.clientId,
      { client_secret: s.clientSecret, id_token_signed_response_alg: 'RS256' },
      oidc.ClientSecretPost(s.clientSecret),
      { timeout: 10 },
    ),
) {
  let cached: Promise<oidc.Configuration> | undefined;
  let keys: ReturnType<typeof createRemoteJWKSet> | undefined;
  const config = () =>
    (cached ??= discover(settings)
      .then((c) => {
        oidc.enableNonRepudiationChecks(c);
        return c;
      })
      .catch((error) => {
        cached = undefined;
        throw error;
      }));
  return {
    async begin(flow: OidcFlow) {
      return oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: settings.redirectUri,
        scope: 'openid profile',
        response_type: 'code',
        state: flow.state,
        nonce: flow.nonce,
        code_challenge_method: 'S256',
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
      }).href;
    },
    async complete(url: URL, flow: OidcFlow): Promise<OidcPerson> {
      const tokens = await oidc.authorizationCodeGrant(await config(), url, {
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        pkceCodeVerifier: flow.verifier,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || claims.iss !== settings.issuer || !claims.sub || !Number.isFinite(claims.exp))
        throw new Error('Invalid OIDC identity');
      const username = oidcUsername(claims.preferred_username);
      if (!username) throw new OidcUsernameError();
      return {
        issuer: claims.iss,
        subject: claims.sub,
        username,
        ...(typeof claims.sid === 'string' ? { sid: claims.sid } : {}),
        // Срок локальной сессии — собственный, как у обычного входа, а не exp ID token
        // (в Keycloak он обычно несколько минут). Досрочно сессию завершают back-channel
        // logout и выход через Keycloak.
        expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
      };
    },
    async logoutUrl() {
      return oidc.buildEndSessionUrl(await config(), {
        post_logout_redirect_uri: settings.postLogoutRedirectUri,
      }).href;
    },
    /**
     * Проверка logout token. OidcUnavailableError — не удалось получить discovery или JWKS
     * (сбой провайдера); прочие ошибки — токен неверен.
     */
    async verifyLogout(token: string): Promise<LogoutPerson> {
      let c: oidc.Configuration;
      try {
        c = await config();
      } catch (error) {
        throw new OidcUnavailableError('discovery недоступен', { cause: error });
      }
      const uri = c.serverMetadata().jwks_uri;
      if (!uri || new URL(uri).protocol !== 'https:')
        throw new OidcUnavailableError('провайдер не указал HTTPS jwks_uri');
      keys ??= createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000 });
      const remote = keys;
      // Ключа с нужным kid нет — дело в токене; остальные ошибки получения набора ключей
      // (сеть, тайм-аут, HTTP не 200, неверный JSON) — сбой провайдера.
      const getKey: JWTVerifyGetKey = async (header, jws) => {
        try {
          return await remote(header, jws);
        } catch (error) {
          if (
            error instanceof errors.JWKSNoMatchingKey ||
            error instanceof errors.JWKSMultipleMatchingKeys
          )
            throw error;
          throw new OidcUnavailableError('JWKS недоступен', { cause: error });
        }
      };
      const { payload } = await jwtVerify(token, getKey, {
        issuer: settings.issuer,
        audience: settings.clientId,
        algorithms: ['RS256'],
        maxTokenAge: '5m',
        requiredClaims: ['iat', 'jti'],
      });
      const events = payload.events as Record<string, unknown> | undefined;
      if (
        !events ||
        !Object.hasOwn(events, 'http://schemas.openid.net/event/backchannel-logout') ||
        payload.nonce !== undefined ||
        (typeof payload.sid !== 'string' && typeof payload.sub !== 'string')
      )
        throw new Error('Invalid logout token');
      // jti обязателен (requiredClaims), но тип проверяем: он ключ защиты от повтора токена.
      if (typeof payload.jti !== 'string') throw new Error('Invalid logout token');
      return {
        issuer: settings.issuer,
        jti: payload.jti,
        ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}),
        ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}),
      };
    },
  };
}

export type OidcClient = ReturnType<typeof createOidcClient>;
