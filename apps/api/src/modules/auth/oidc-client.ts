import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { OidcConfig } from '../../config';

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
export type LogoutPerson = { issuer: string; subject?: string; sid?: string };
export type Discover = (config: OidcConfig) => Promise<oidc.Configuration>;

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
      const username =
        typeof claims.preferred_username === 'string' ? claims.preferred_username.trim() : '';
      if (
        !username ||
        username.length > 200 ||
        [...username].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        throw new Error('Missing valid preferred_username');
      return {
        issuer: claims.iss,
        subject: claims.sub,
        username,
        ...(typeof claims.sid === 'string' ? { sid: claims.sid } : {}),
        expiresAt: new Date(Math.min(claims.exp * 1000, Date.now() + 12 * 3600_000)),
      };
    },
    async logoutUrl() {
      return oidc.buildEndSessionUrl(await config(), {
        post_logout_redirect_uri: settings.postLogoutRedirectUri,
      }).href;
    },
    async verifyLogout(token: string): Promise<LogoutPerson> {
      const c = await config();
      const uri = c.serverMetadata().jwks_uri;
      if (!uri || new URL(uri).protocol !== 'https:') throw new Error('HTTPS JWKS required');
      keys ??= createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000 });
      const { payload } = await jwtVerify(token, keys, {
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
      return {
        issuer: settings.issuer,
        ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}),
        ...(typeof payload.sub === 'string' ? { subject: payload.sub } : {}),
      };
    },
  };
}

export type OidcClient = ReturnType<typeof createOidcClient>;
