import { createServer, type Server } from 'node:https';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOidcClient, type OidcFlow } from './oidc-client';
import type { OidcConfig } from '../../config';

// Local fake IdP: use NODE_EXTRA_CA_CERTS=test/fixtures/oidc/localhost-test-cert.pem.
let server: Server;
let settings: OidcConfig;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: object;
let flow: OidcFlow;
let mutation: 'none' | 'nonce' | 'audience' | 'issuer' | 'expired' | 'signature' = 'none';
let calls = 0;
async function signed(payload: Record<string, unknown>) {
  const key =
    mutation === 'signature' ? (await generateKeyPair('RS256')).privateKey : signing.privateKey;
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key);
}
beforeAll(async () => {
  signing = await generateKeyPair('RS256');
  jwk = { ...(await exportJWK(signing.publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  server = createServer(
    {
      key: readFileSync(
        new URL('../../../test/fixtures/oidc/localhost-test-key.pem', import.meta.url),
      ),
      cert: readFileSync(
        new URL('../../../test/fixtures/oidc/localhost-test-cert.pem', import.meta.url),
      ),
    },
    async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/.well-known/openid-configuration'))
        return res.end(
          JSON.stringify({
            issuer: settings.issuer,
            authorization_endpoint: settings.issuer + '/auth',
            token_endpoint: settings.issuer + '/token',
            jwks_uri: settings.issuer + '/certs',
            end_session_endpoint: settings.issuer + '/logout',
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
          }),
        );
      if (req.url?.endsWith('/certs')) return res.end(JSON.stringify({ keys: [jwk] }));
      if (req.url?.endsWith('/token')) {
        calls++;
        let body = '';
        for await (const chunk of req) body += chunk;
        const p = new URLSearchParams(body);
        const verifier = p.get('code_verifier');
        if (
          p.get('client_secret') !== settings.clientSecret ||
          !verifier ||
          createHash('sha256').update(verifier).digest('base64url') !==
            createHash('sha256').update(flow.verifier).digest('base64url')
        ) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
        const now = Math.floor(Date.now() / 1000);
        const id = await signed({
          iss: mutation === 'issuer' ? 'https://other.invalid' : settings.issuer,
          sub: 'person-1',
          aud: mutation === 'audience' ? 'other-client' : settings.clientId,
          iat: now,
          exp: mutation === 'expired' ? now - 60 : now + 300,
          nonce: mutation === 'nonce' ? 'wrong-nonce' : flow.nonce,
          preferred_username: 'tester',
          sid: 'provider-session-1',
        });
        return res.end(
          JSON.stringify({
            access_token: 'test-access-token',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: id,
          }),
        );
      }
      res.statusCode = 404;
      res.end('{}');
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  settings = {
    issuer: `https://127.0.0.1:${port}/realms/test`,
    clientId: 'carbone-test',
    clientSecret: 'test-only-client-secret',
    redirectUri: 'https://reports.test/api/auth/oidc/callback',
    postLogoutRedirectUri: 'https://reports.test/login',
  };
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  mutation = 'none';
  calls = 0;
  flow = {
    state: randomUUID(),
    nonce: randomUUID(),
    verifier: randomUUID() + randomUUID(),
    browser: randomUUID(),
    next: '/reports',
  };
});
const callback = () => new URL(settings.redirectUri + '?code=test-code&state=' + flow.state);
describe('OIDC protocol against a local HTTPS IdP', () => {
  it('authorization code, PKCE S256, state, nonce, signature and claims', async () => {
    const c = createOidcClient(settings);
    const u = new URL(await c.begin(flow));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(flow.state);
    expect(u.searchParams.get('nonce')).toBe(flow.nonce);
    const person = await c.complete(callback(), flow);
    expect(person).toMatchObject({
      issuer: settings.issuer,
      subject: 'person-1',
      username: 'tester',
      sid: 'provider-session-1',
    });
    expect(calls).toBe(1);
  });
  it.each(['nonce', 'audience', 'issuer', 'expired', 'signature'] as const)(
    'rejects invalid %s',
    async (kind) => {
      mutation = kind;
      const c = createOidcClient(settings);
      await expect(c.complete(callback(), flow)).rejects.toThrow();
    },
  );
  it('rejects mismatched state before exchanging code', async () => {
    const c = createOidcClient(settings);
    const u = callback();
    u.searchParams.set('state', 'attacker');
    await expect(c.complete(u, flow)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it('rejects wrong PKCE verifier', async () => {
    const c = createOidcClient(settings);
    await expect(
      c.complete(callback(), {
        ...flow,
        verifier: 'wrong-verifier-that-is-long-enough-to-be-valid',
      }),
    ).rejects.toThrow();
  });
  it('builds RP logout only to configured endpoints', async () => {
    const u = new URL(await createOidcClient(settings).logoutUrl());
    expect(u.pathname).toBe('/realms/test/logout');
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe(settings.postLogoutRedirectUri);
  });
  it('validates a signed back-channel logout token', async () => {
    const token = await signed({
      iss: settings.issuer,
      aud: settings.clientId,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
      sid: 'provider-session-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });
    await expect(createOidcClient(settings).verifyLogout(token)).resolves.toMatchObject({
      issuer: settings.issuer,
      sid: 'provider-session-1',
    });
  });
  it('rejects ID token presented as logout token', async () => {
    const token = await signed({
      iss: settings.issuer,
      aud: settings.clientId,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
      sub: 'person-1',
      nonce: 'nonce',
    });
    await expect(createOidcClient(settings).verifyLogout(token)).rejects.toThrow();
  });
});
