[Русский](keycloak.md) · **English**

# Keycloak / OpenID Connect

The integration is disabled by default (`OIDC_ENABLED=false`). The login page and its buttons do not change.
LDAP and local login keep working. This change does not install the Keycloak service.

## Connecting after a separate decision to enable it

1. In your realm, create the OIDC client `carbone-reports`: Client authentication on,
   Standard flow on, PKCE S256; Direct access grants and Implicit flow off.
2. Set **exact** URLs (no wildcards):
   - Valid redirect URI: `https://reports.example.org/api/auth/oidc/callback`;
   - Valid post logout redirect URI: `https://reports.example.org/login`;
   - Backchannel logout URL: `https://reports.example.org/api/auth/oidc/backchannel-logout`;
   - Backchannel logout session required on. ID/logout tokens are signed with RS256.
3. Make sure `preferred_username` is present in the ID token (scope `profile`). For existing LDAP accounts
   it usually matches `sAMAccountName`. The AD/LDAP source is configured in Keycloak separately.
4. In the server's protected `.env` (mode 600), set:

```dotenv
OIDC_ENABLED=true
OIDC_ISSUER=https://sso.example.org/realms/yg
OIDC_CLIENT_ID=carbone-reports
OIDC_CLIENT_SECRET=<client secret>
OIDC_REDIRECT_URI=https://reports.example.org/api/auth/oidc/callback
OIDC_POST_LOGOUT_REDIRECT_URI=https://reports.example.org/login
COOKIE_SECURE=true
```

The issuer and callback must use HTTPS with a trusted certificate. For an internal CA, you can
pass Node `NODE_EXTRA_CA_CERTS` pointing to an accessible CA file through a compose override; TLS verification is never disabled.
The client secret is stored only by the API. After changing the configuration, recreate the API container.
Direct URL for testing: `/api/auth/oidc/login?next=/reports`. This URL alone does not add a button.

## Users, roles, and sessions

- Identity is stored by `issuer + sub`, not by email or display login.
- A new user gets the local role `user` and a random, unknown local password. An administrator then changes the role (`editor`, `access_manager`, `admin`) in the "Users" section; roles are not taken from the OIDC token.
- Existing roles, groups, history, and local blocks remain in the application.
- If the login matches an existing account, sign-in returns `403 OIDC_LOGIN_UNAVAILABLE`
  (the same for `ADMIN_LOGIN`; the reason differs only in the API log);
  there is no automatic merge and no duplicate is created.
- The built-in `ADMIN_LOGIN` is used only for emergency local login and is not linked.
- Accounts created by a first sign-in through Keycloak (`users.auth_source = 'oidc'`) sign in only through
  Keycloak: LDAP sign-in with the same login is rejected even if the directory entry is found and the password is correct.
  LDAP users sign in through LDAP, and through Keycloak only after an administrator explicitly links them
  (linking does not change `auth_source`). Configure the realm without self-registration
  (User registration off) and without users editing their username (Edit username off):
  otherwise a person could choose a `preferred_username` that matches someone else's login.
- Linking an existing user: an authorized local administrator sends
  `POST /api/admin/auth/oidc/identities` with the JSON `{"userId":"<local UUID>","subject":"<sub from Keycloak>"}`.
  The issuer is taken from the API configuration, not from the request. Obtain `sub` from the trusted Keycloak admin console.
- Unlinking: `DELETE /api/admin/auth/oidc/identities/<local UUID>`; OIDC sessions are revoked.
- Login codes are single-use: state, nonce, PKCE, and binding to an HttpOnly cookie; the state is kept in Redis for 10 minutes.
  If Redis fails, OIDC fails closed; local/LDAP login remains available.
- Keycloak tokens are not stored in the browser, the DB, or application logs. The refresh token is not used:
  the local OIDC session lasts as long as a regular application session (12 hours), regardless
  of the ID token `exp`. It is ended early by back-channel logout, logout through Keycloak, blocking, or
  unlinking. After it expires, a new OIDC sign-in is required; a still-active Keycloak SSO session
  may let the user complete it without re-entering a password.
- In the request log, `/api/auth/oidc/*` route paths are recorded without the query (the authorization code and state
  are not written). Keycloak sign-ins, linking, and unlinking are logged with `userId`, without tokens.
- Expired OIDC sessions and those revoked more than a day ago are removed by a periodic cleanup (hourly).
- `/api/auth/logout` revokes the current local OIDC session. For a global logout,
  `POST /api/auth/oidc/logout` returns a `url` that the client must navigate to in the top-level window.
  Keycloak may ask to confirm the logout because the ID token hint is not stored.
- A signed back-channel logout immediately revokes the matching OIDC sessions. The limit is 600 requests
  per minute per address. If the API cannot obtain Keycloak's discovery document or keys (JWKS), the response is 503
  (Keycloak will show a delivery failure); an invalid token gets 400. Rejections are logged with the reason, without the token.
  Re-sending the same token (the same `jti`, within 10 minutes) revokes nothing and gets 200 —
  so an intercepted token cannot end sessions opened later.
- With `COOKIE_SECURE=true`, the session cookie is named `__Host-session` and the login cookie `__Secure-oidc_flow`
  (with `false`, `session` and `oidc_flow`).
  When OIDC is turned off, previously issued OIDC sessions are no longer accepted.

## Checks and rollback

Migration `0013_oidc` adds the tables `oidc_identities` and `oidc_sessions` and makes user logins
unique regardless of case (the `lower(login)` index). If the database contains logins
that differ only in case (`Ivan` and `ivan`), the migration fails with the error
"логины, отличающиеся только регистром: …" (logins that differ only in case) — rename them beforehand. To find such logins before upgrading:

```sql
SELECT lower(login) AS key, string_agg(login, ', ' ORDER BY login) AS logins
FROM users
GROUP BY lower(login)
HAVING count(*) > 1
ORDER BY 1;
```

The migration also adds the column `users.auth_source` (`local`, `ldap`, `oidc`); existing
users get `local`.
Existing users and reports are not changed. The backup must include the new migration:
the backup agent image is rebuilt together with the API.

The protocol tests use their own test HTTPS IdP and a test certificate; the `test` script
adds it to the trusted set itself (`NODE_EXTRA_CA_CERTS`):

```bash
pnpm --filter @carbone-reports/api test
```

The OIDC routes with PostgreSQL and Redis are checked by the integration test `apps/api/test/oidc.int.test.ts`
(testcontainers, part of `pnpm test:int` and CI):

```bash
pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/oidc.int.test.ts
```

To disable immediately, set `OIDC_ENABLED=false` and recreate the API. Returning to the previous images
is possible without dropping the added tables; the database needs no reverse migration. Keep the backup separately.
