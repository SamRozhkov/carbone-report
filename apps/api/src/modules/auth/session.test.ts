import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from './session';

const secret = new TextEncoder().encode('s'.repeat(32));
const user = { id: '00000000-0000-0000-0000-000000000001', login: 'admin', role: 'admin' as const };

describe('session', () => {
  it('подписывает и проверяет', async () => {
    expect(await verifySession(await signSession(user, secret), secret)).toEqual(user);
  });
  it('null на чужой подписи', async () => {
    const other = new TextEncoder().encode('x'.repeat(32));
    expect(await verifySession(await signSession(user, other), secret)).toBeNull();
  });
  it('null на мусоре', async () => {
    expect(await verifySession('garbage', secret)).toBeNull();
  });
});
