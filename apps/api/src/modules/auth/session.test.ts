import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from './session';

const secret = new TextEncoder().encode('s'.repeat(32));
const user = { id: '00000000-0000-0000-0000-000000000001', login: 'admin', role: 'admin' as const };

describe('session', () => {
  it('подписывает и проверяет', async () => {
    expect(await verifySession(await signSession(user, 3, secret), secret)).toEqual({
      ...user,
      sv: 3,
    });
  });
  it('null на чужой подписи', async () => {
    const other = new TextEncoder().encode('x'.repeat(32));
    expect(await verifySession(await signSession(user, 0, other), secret)).toBeNull();
  });
  it('null на мусоре', async () => {
    expect(await verifySession('garbage', secret)).toBeNull();
  });
  it('null на токене без sv', async () => {
    const legacy = await new SignJWT({ login: user.login, role: user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);
    expect(await verifySession(legacy, secret)).toBeNull();
  });
});
