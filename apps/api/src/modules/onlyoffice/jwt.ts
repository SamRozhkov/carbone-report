import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

export const CALLBACK_MAX_AGE_SECONDS = 600;
const CLOCK_TOLERANCE_SECONDS = 60;

export function signOnlyOffice(
  payload: Record<string, unknown>,
  secret: Uint8Array,
  opts: { expiresIn?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(payload as JWTPayload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' });
  if (opts.expiresIn) jwt.setIssuedAt().setExpirationTime(opts.expiresIn);
  return jwt.sign(secret);
}

export async function verifyOnlyOffice(
  token: string,
  secret: Uint8Array,
): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  return payload as Record<string, unknown>;
}

/**
 * Токен входящего callback: подпись + срок жизни. Document Server ставит exp (token.outbox.expires);
 * без exp принимается только свежий iat — иначе перехваченный callback можно было бы повторить.
 */
export async function verifyOnlyOfficeCallback(
  token: string,
  secret: Uint8Array,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    currentDate: new Date(now * 1000),
  });
  if (payload.exp === undefined) {
    if (typeof payload.iat !== 'number' || now - payload.iat > CALLBACK_MAX_AGE_SECONDS) {
      throw new Error('callback-токен без срока действия');
    }
  }
  return payload as Record<string, unknown>;
}

export function signFileToken(templateId: string, secret: Uint8Array): Promise<string> {
  return new SignJWT({ purpose: 'oo-file' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(templateId)
    .setAudience('oo-file')
    .setExpirationTime('10m')
    .sign(secret);
}

export async function verifyFileToken(
  token: string,
  templateId: string,
  secret: Uint8Array,
): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      subject: templateId,
      audience: 'oo-file',
    });
    return payload.purpose === 'oo-file';
  } catch {
    return false;
  }
}
