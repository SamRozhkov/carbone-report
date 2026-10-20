import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userCertificates } from '../src/db/schema';
import { decryptSecret } from '../src/lib/crypto';
import { AppError } from '../src/lib/errors';
import { fixture, FIXTURE_PASSWORD } from '../src/modules/pdf/sign/fixtures';
import { createTestApp, loginAs, multipart, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t?.close());

function upload(cookie: string, file: Buffer | null, password?: string, app = t) {
  const fields: Record<string, string> = password === undefined ? {} : { password };
  const body = multipart(fields, file ? { name: 'me.p12', data: file } : undefined);
  return app.app.inject({
    method: 'POST',
    url: '/api/me/certificate',
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
}

describe('сертификат пользователя (§39.1)', () => {
  it('нет сертификата — { certificate: null }', async () => {
    const { cookie } = await loginAs(t, 'user');
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/me/certificate',
      headers: { cookie },
    });
    expect(res.json()).toEqual({ certificate: null });
  });

  it('загрузка: 201, сведения; хранится зашифрованным, пароль нигде не сохранён', async () => {
    const { cookie, user } = await loginAs(t, 'user');
    const res = await upload(cookie, fixture('rsa.p12'), FIXTURE_PASSWORD);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      subjectCn: 'Иванов Иван Иванович (rsa)',
      serial: '1001',
      keyAlg: 'RSA-2048',
    });
    const [row] = await t.deps.db
      .select()
      .from(userCertificates)
      .where(eq(userCertificates.userId, user.id));
    expect(row!.p12Enc).not.toContain(fixture('rsa.p12').toString('base64').slice(0, 40));
    expect(
      Buffer.from(decryptSecret(row!.p12Enc, t.deps.config.encryptionKey), 'base64').equals(
        fixture('rsa.p12'),
      ),
    ).toBe(true);
    expect(JSON.stringify(row)).not.toContain(FIXTURE_PASSWORD);
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me/certificate',
      headers: { cookie },
    });
    expect(me.json().certificate.serial).toBe('1001');
    expect(me.body).not.toContain('p12');
  });

  it('замена — новый сертификат', async () => {
    const { cookie } = await loginAs(t, 'user');
    await upload(cookie, fixture('rsa.p12'), FIXTURE_PASSWORD);
    const res = await upload(cookie, fixture('ec.p12'), FIXTURE_PASSWORD);
    expect(res.json().keyAlg).toBe('ECDSA P-256');
  });

  it.each([
    ['rsa.p12', 'wrong-пароль', '/password', 'неверный пароль или повреждённый файл'],
    ['rsa1024.p12', FIXTURE_PASSWORD, '/file', 'алгоритм ключа не поддерживается'],
    ['nosign.p12', FIXTURE_PASSWORD, '/file', 'сертификат не предназначен для подписи'],
    ['nokey.p12', FIXTURE_PASSWORD, '/file', 'в файле должен быть один ключ и его сертификат'],
  ])('%s — 400 у поля %s', async (name, password, path, message) => {
    const { cookie } = await loginAs(t, 'user');
    const res = await upload(cookie, fixture(name), password);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION', details: [{ path, message }] },
    });
    expect(res.body).not.toContain(password);
  });

  it('больше 50 КБ — 400 у файла', async () => {
    const { cookie } = await loginAs(t, 'user');
    const res = await upload(cookie, Buffer.alloc(60 * 1024, 1), 'x');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION', details: [{ path: '/file', message: 'файл больше 50 КБ' }] },
    });
  });

  it('больше лимита части (1 МБ) — тоже 400 «файл больше 50 КБ», а не 413', async () => {
    const { cookie } = await loginAs(t, 'user');
    const res = await upload(cookie, Buffer.alloc(2 * 1024 * 1024, 1), 'x');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'VALIDATION', details: [{ path: '/file', message: 'файл больше 50 КБ' }] },
    });
  });

  it('больше 10 загрузок в минуту на пользователя — 429; другой пользователь не затронут', async () => {
    const { cookie } = await loginAs(t, 'user');
    // Дешёвое тело (не .p12): попытка считается до разбора файла.
    for (let i = 0; i < 10; i++)
      expect((await upload(cookie, Buffer.from('x'), 'x')).statusCode).toBe(400);
    const res = await upload(cookie, Buffer.from('x'), 'x');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      error: {
        code: 'TOO_MANY_ATTEMPTS',
        message: 'слишком много загрузок сертификата — попробуйте через минуту',
      },
    });
    const other = await loginAs(t, 'user');
    expect((await upload(other.cookie, Buffer.from('x'), 'x')).statusCode).toBe(400);
  });

  it('нет файла или пароля — 400', async () => {
    const { cookie } = await loginAs(t, 'user');
    expect((await upload(cookie, null, 'x')).statusCode).toBe(400);
    const noPw = await upload(cookie, fixture('rsa.p12'));
    expect(noPw.json()).toMatchObject({
      error: { details: [{ path: '/password', message: 'укажите пароль' }] },
    });
  });

  it('удаление своего — 204, затем null', async () => {
    const { cookie } = await loginAs(t, 'user');
    await upload(cookie, fixture('rsa.p12'), FIXTURE_PASSWORD);
    expect(
      (await t.app.inject({ method: 'DELETE', url: '/api/me/certificate', headers: { cookie } }))
        .statusCode,
    ).toBe(204);
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me/certificate',
      headers: { cookie },
    });
    expect(me.json()).toEqual({ certificate: null });
  });

  it('администратор: срок в списке пользователей, удаление чужого; пользователь — 403', async () => {
    const owner = await loginAs(t, 'user');
    await upload(owner.cookie, fixture('rsa.p12'), FIXTURE_PASSWORD);
    const admin = await loginAs(t, 'admin');
    const list = await t.app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { cookie: admin.cookie },
    });
    const dto = list.json().find((u: { id: string }) => u.id === owner.user.id);
    expect(dto.certificateNotAfter).toMatch(/^21\d\d-/);
    const other = await loginAs(t, 'user');
    const forbidden = await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${owner.user.id}/certificate`,
      headers: { cookie: other.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${owner.user.id}/certificate`,
      headers: { cookie: admin.cookie },
    });
    expect(del.statusCode).toBe(204);
    const after = await t.app.inject({
      method: 'GET',
      url: '/api/me/certificate',
      headers: { cookie: owner.cookie },
    });
    expect(after.json()).toEqual({ certificate: null });
    const missing = await t.app.inject({
      method: 'DELETE',
      url: '/api/users/00000000-0000-0000-0000-000000000000/certificate',
      headers: { cookie: admin.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('разбор .p12 не успел (TIMEOUT пула) — 504, сертификат не сохранён (§39.8)', async () => {
    const slow = await createTestApp({
      p12Read: async () => {
        throw new AppError('TIMEOUT', 504, 'превышено время ожидания');
      },
    });
    try {
      const { cookie } = await loginAs(slow, 'user');
      const res = await upload(cookie, fixture('rsa.p12'), FIXTURE_PASSWORD, slow);
      expect(res.statusCode).toBe(504);
      expect(res.json().error).toMatchObject({ code: 'TIMEOUT' });
      expect(res.body).not.toContain(FIXTURE_PASSWORD);
      const me = await slow.app.inject({
        method: 'GET',
        url: '/api/me/certificate',
        headers: { cookie },
      });
      expect(me.json()).toEqual({ certificate: null });
    } finally {
      await slow.close();
    }
  });

  it('без входа — 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/me/certificate' })).statusCode).toBe(
      401,
    );
  });
});
