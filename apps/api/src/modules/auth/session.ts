import { Role } from '@carbone-reports/shared';
import { jwtVerify, SignJWT } from 'jose';

export const SESSION_COOKIE = 'session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionUser {
  id: string;
  login: string;
  role: Role;
}

export function signSession(user: SessionUser, secret: Uint8Array): Promise<string> {
  return new SignJWT({ login: user.login, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifySession(token: string, secret: Uint8Array): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    const role = Role.safeParse(payload.role);
    if (!payload.sub || typeof payload.login !== 'string' || !role.success) return null;
    return { id: payload.sub, login: payload.login, role: role.data };
  } catch {
    return null;
  }
}
