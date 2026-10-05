import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { CALLBACK_MAX_AGE_SECONDS, verifyOnlyOfficeCallback } from './jwt';

const secret = new TextEncoder().encode('s'.repeat(40));
const now = Math.floor(Date.now() / 1000);
const sign = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(secret);

describe('verifyOnlyOfficeCallback', () => {
  it('принимает свежий токен с exp', async () => {
    await expect(
      verifyOnlyOfficeCallback(await sign({ key: 'k', exp: now + 300 }), secret),
    ).resolves.toMatchObject({ key: 'k' });
  });
  it('отклоняет просроченный exp (за пределами допуска 60 с)', async () => {
    await expect(
      verifyOnlyOfficeCallback(await sign({ exp: now - 120 }), secret),
    ).rejects.toThrow();
  });
  it('допуск 60 с на расхождение часов', async () => {
    await expect(
      verifyOnlyOfficeCallback(await sign({ exp: now - 30 }), secret),
    ).resolves.toBeTruthy();
  });
  it('без exp: свежий iat — ок, старый — отказ', async () => {
    await expect(
      verifyOnlyOfficeCallback(await sign({ iat: now - 60 }), secret),
    ).resolves.toBeTruthy();
    await expect(
      verifyOnlyOfficeCallback(await sign({ iat: now - CALLBACK_MAX_AGE_SECONDS - 120 }), secret),
    ).rejects.toThrow();
  });
  it('без exp и iat — отказ', async () => {
    await expect(verifyOnlyOfficeCallback(await sign({ key: 'k' }), secret)).rejects.toThrow();
  });
  it('чужой секрет — отказ', async () => {
    const other = await new SignJWT({ exp: now + 60 })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('x'.repeat(40)));
    await expect(verifyOnlyOfficeCallback(other, secret)).rejects.toThrow();
  });
});
