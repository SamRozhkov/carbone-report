import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

export function signOnlyOffice(payload: Record<string, unknown>, secret: Uint8Array): Promise<string> {
  return new SignJWT(payload as JWTPayload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(secret);
}

export async function verifyOnlyOffice(token: string, secret: Uint8Array): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  return payload as Record<string, unknown>;
}

export function signFileToken(templateId: string, secret: Uint8Array): Promise<string> {
  return new SignJWT({ purpose: 'oo-file' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(templateId)
    .setExpirationTime('10m')
    .sign(secret);
}

export async function verifyFileToken(token: string, templateId: string, secret: Uint8Array): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], subject: templateId });
    return payload.purpose === 'oo-file';
  } catch {
    return false;
  }
}
