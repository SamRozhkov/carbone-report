import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templates } from '../src/db/schema';
import { decryptSecret } from '../src/lib/crypto';
import { createTemplate, createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let dsId: string;

const putOptions = (id: string, body: object) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/pdf-options`,
    headers: { cookie: admin },
    payload: body,
  });
const storedEnc = async (id: string) =>
  (await t.deps.db.select().from(templates).where(eq(templates.id, id)))[0]!.pdfPasswordEnc;
const newTemplate = () => createTemplate(t, admin, dsId);

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: {
      name: 'src',
      host: 'localhost',
      port: 5432,
      database: 'x',
      username: 'x',
      password: 'x',
      sslMode: 'disable',
    },
  });
  dsId = ds.json().id;
});
afterAll(() => t.close());

describe('пароль и запреты PDF (§37.1)', () => {
  it('пароль хранится зашифрованным, наружу — только pdfPasswordSet', async () => {
    const id = await newTemplate();
    const r = await putOptions(id, { protection: { noCopy: true }, password: 'секрет1' });
    expect(r.statusCode).toBe(200);
    expect(r.json().pdfPasswordSet).toBe(true);
    expect(r.json().pdfOptions.protection).toEqual({
      noPrint: false,
      noCopy: true,
      noModify: false,
    });
    expect(r.body).not.toContain('секрет1');
    const enc = await storedEnc(id);
    expect(enc).not.toContain('секрет1');
    expect(decryptSecret(enc!, t.deps.config.encryptionKey)).toBe('секрет1');
    const card = await t.app.inject({ url: `/api/templates/${id}`, headers: { cookie: admin } });
    expect(card.json().pdfPasswordSet).toBe(true);
    expect(card.body).not.toContain('секрет1');
  });

  it('password: не передан — не меняется; null — снят; строка — заменён', async () => {
    const id = await newTemplate();
    await putOptions(id, { password: 'первый1' });
    const keep = await putOptions(id, { watermark: { text: 'КОПИЯ' } });
    expect(keep.json().pdfPasswordSet).toBe(true);
    expect(decryptSecret((await storedEnc(id))!, t.deps.config.encryptionKey)).toBe('первый1');
    await putOptions(id, { password: 'второй2' });
    expect(decryptSecret((await storedEnc(id))!, t.deps.config.encryptionKey)).toBe('второй2');
    const off = await putOptions(id, { password: null });
    expect(off.json().pdfPasswordSet).toBe(false);
    expect(await storedEnc(id)).toBeNull();
  });

  it('пустые запреты не хранятся (R1)', async () => {
    const id = await newTemplate();
    const r = await putOptions(id, { protection: {} });
    expect(r.json().pdfOptions).toEqual({ pdfa: false });
  });

  it('ошибки пароля — у поля /password', async () => {
    const id = await newTemplate();
    const short = await putOptions(id, { password: 'abc' });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.details).toContainEqual({
      path: '/password',
      message: 'пароль — от 4 до 64 символов',
    });
    const ctl = await putOptions(id, { password: 'ab\ncd' });
    expect(ctl.json().error.details).toContainEqual({
      path: '/password',
      message: 'пароль содержит недопустимые символы',
    });
    expect(await storedEnc(id)).toBeNull();
  });

  it('PDF/A несовместим с паролем и запретами — в обе стороны (R3)', async () => {
    const id = await newTemplate();
    const both = await putOptions(id, { pdfa: true, protection: { noPrint: true } });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.details).toEqual([
      { path: '/pdfa', message: 'PDF/A несовместим с паролем и ограничениями' },
    ]);
    await putOptions(id, { password: 'секрет1' });
    const pdfaKeepPw = await putOptions(id, { pdfa: true });
    expect(pdfaKeepPw.statusCode).toBe(400);
    expect(pdfaKeepPw.json().error.details[0].path).toBe('/pdfa');
    const pdfaDropPw = await putOptions(id, { pdfa: true, password: null });
    expect(pdfaDropPw.statusCode).toBe(200);
    expect(pdfaDropPw.json()).toMatchObject({ pdfPasswordSet: false, pdfOptions: { pdfa: true } });
    const pwOnPdfa = await putOptions(id, { pdfa: true, password: 'секрет1' });
    expect(pwOnPdfa.statusCode).toBe(400);
    expect(await storedEnc(id)).toBeNull();
  });

  it('«Дублировать» копирует пароль и запреты (R7)', async () => {
    const id = await newTemplate();
    await putOptions(id, { protection: { noModify: true }, password: 'секрет1' });
    const dup = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/duplicate`,
      headers: { cookie: admin },
    });
    expect(dup.statusCode).toBe(201);
    const copyId = dup.json().id as string;
    expect(decryptSecret((await storedEnc(copyId))!, t.deps.config.encryptionKey)).toBe('секрет1');
    const card = await t.app.inject({
      url: `/api/templates/${copyId}`,
      headers: { cookie: admin },
    });
    expect(card.json()).toMatchObject({
      pdfPasswordSet: true,
      pdfOptions: { protection: { noModify: true } },
    });
  });
});
