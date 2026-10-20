import { Role } from '@carbone-reports/shared';
import { jwtVerify, SignJWT } from 'jose';

/** Прежнее имя cookie сессии (до 2.10.1 и при COOKIE_SECURE=false); при выходе его тоже очищают. */
export const LEGACY_SESSION_COOKIE = 'session';
/** `__Host-`: браузер принимает её только с Secure, Path=/ и без Domain — не подставить с поддомена. */
export const sessionCookieName = (secure: boolean) =>
  secure ? '__Host-session' : LEGACY_SESSION_COOKIE;
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionUser {
  id: string;
  login: string;
  role: Role;
}

export interface SessionClaims extends SessionUser {
  sv: number;
  oidcSessionId?: string;
}

export function signSession(
  user: SessionUser,
  sv: number,
  secret: Uint8Array,
  oidcSessionId?: string,
): Promise<string> {
  return new SignJWT({
    login: user.login,
    role: user.role,
    sv,
    ...(oidcSessionId ? { oidcSessionId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifySession(
  token: string,
  secret: Uint8Array,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    const role = Role.safeParse(payload.role);
    if (!payload.sub || typeof payload.login !== 'string' || !role.success) return null;
    // Cookie, выпущенные до появления отзыва сессий, не содержат sv и недействительны.
    if (!Number.isInteger(payload.sv)) return null;
    if (
      payload.oidcSessionId !== undefined &&
      (typeof payload.oidcSessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.oidcSessionId))
    )
      return null;
    return {
      id: payload.sub,
      login: payload.login,
      role: role.data,
      sv: payload.sv as number,
      ...(typeof payload.oidcSessionId === 'string'
        ? { oidcSessionId: payload.oidcSessionId }
        : {}),
    };
  } catch {
    return null;
  }
}
