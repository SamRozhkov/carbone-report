import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { templates } from '../src/db/schema';
import { signOnlyOffice, verifyOnlyOffice } from '../src/modules/onlyoffice/jwt';
import { createBlankDocument } from '../src/modules/templates/blank';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  type TestApp,
} from './helpers';

let t: TestApp;
let admin: string;
let adminId: string;
let user: string;
let dsId: string;
let tplId: string;
let fetched: Buffer;
const forceSaved: string[] = [];
const fetchedUrls: string[] = [];
// Document Server строит ссылку на результат от публичного origin (за nginx — префикс /onlyoffice).
const CACHE = (name: string) => `/cache/files/data/${name}/output.docx?md5=abc&expires=1`;
const pub = (name: string) => `https://localhost:8443/onlyoffice${CACHE(name)}`;
const internal = (name: string) => `http://onlyoffice${CACHE(name)}`;

beforeAll(async () => {
  t = await createTestApp({
    fetchFile: async (url) => {
      fetchedUrls.push(url);
      if (url === internal('slow')) {
        await new Promise((r) => setTimeout(r, 300));
        return Buffer.concat([await createBlankDocument('docx'), Buffer.from('old')]);
      }
      if (url === internal('final'))
        return Buffer.concat([await createBlankDocument('docx'), Buffer.from('final')]);
      if (url === internal('boom')) throw new Error('network');
      return fetched;
    },
    onlyoffice: { forceSave: async (key) => void forceSaved.push(key) },
  });
  const a = await loginAs(t, 'admin');
  admin = a.cookie;
  adminId = a.user.id;
  user = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase('select 1');
  dsId = (
    await t.app.inject({
      method: 'POST',
      url: '/api/datasources',
      headers: { cookie: admin },
      payload: { name: 's', ...src, sslMode: 'disable' },
    })
  ).json().id;
});
beforeEach(async () => {
  tplId = await createTemplate(t, admin, dsId);
  fetched = await createBlankDocument('docx');
});
afterAll(() => t.close());

const secret = () => t.deps.config.onlyofficeJwtSecret;
const row = async () =>
  (await t.deps.db.select().from(templates).where(eq(templates.id, tplId)))[0]!;

async function callback(body: Record<string, unknown>, via: 'body' | 'header' = 'body') {
  const headers: Record<string, string> = {};
  let payload: Record<string, unknown> = body;
  if (via === 'body') payload = { ...body, token: await signOnlyOffice(body, secret()) };
  else headers.authorization = `Bearer ${await signOnlyOffice({ payload: body }, secret())}`;
  return t.app.inject({
    method: 'POST',
    url: `/internal/onlyoffice/callback/${tplId}`,
    headers,
    payload,
  });
}

describe('callback: прочее', () => {
  it('callback для удалённого шаблона подтверждается {error:0}', async () => {
    const r1 = await callback({ key: 'k', status: 2, url: pub('final') });
    expect(r1.statusCode).toBe(200);
    await t.app.inject({
      method: 'DELETE',
      url: `/api/templates/${tplId}`,
      headers: { cookie: admin },
    });
    const r = await callback({ key: 'k', status: 2, url: pub('final') });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ error: 0 });
  });
});

describe('editor-config', () => {
  it('подписанный конфиг с внутренними URL; user → 403', async () => {
    const r = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${tplId}/editor-config`,
      headers: { cookie: admin },
    });
    const cfg = r.json();
    expect(cfg).toMatchObject({
      documentType: 'word',
      document: { fileType: 'docx', key: (await row()).docKey },
      editorConfig: {
        callbackUrl: `http://api:3000/internal/onlyoffice/callback/${tplId}`,
        lang: 'ru',
        customization: { forcesave: true },
        user: { id: adminId },
      },
    });
    expect(cfg.document.url).toMatch(
      new RegExp(`^http://api:3000/internal/templates/${tplId}/file\\?t=`),
    );
    const claims = await verifyOnlyOffice(cfg.token, secret());
    expect(claims).toMatchObject({ document: { key: cfg.document.key } });

    const forbidden = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${tplId}/editor-config`,
      headers: { cookie: user },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('файл отдаётся по токену из конфига и не отдаётся без него или с токеном другого шаблона', async () => {
    const cfg = (
      await t.app.inject({
        method: 'GET',
        url: `/api/templates/${tplId}/editor-config`,
        headers: { cookie: admin },
      })
    ).json();
    const path = new URL(cfg.document.url).pathname + new URL(cfg.document.url).search;
    const ok = await t.app.inject({ method: 'GET', url: path });
    expect(ok.statusCode).toBe(200);
    const noToken = await t.app.inject({ method: 'GET', url: `/internal/templates/${tplId}/file` });
    expect(noToken.statusCode).toBe(403);
    const other = await createTemplate(t, admin, dsId);
    const wrong = await t.app.inject({ method: 'GET', url: path.replace(tplId, other) });
    expect(wrong.statusCode).toBe(403);
  });
});

describe('callback', () => {
  it('без подписи → 403, файл не меняется', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/internal/onlyoffice/callback/${tplId}`,
      payload: { key: (await row()).docKey, status: 2, url: pub('x') },
    });
    expect(r.statusCode).toBe(403);
    expect((await row()).version).toBe(1);
  });

  it('status 1 и 4 — только подтверждение', async () => {
    const key = (await row()).docKey;
    expect((await callback({ key, status: 1 })).json()).toEqual({ error: 0 });
    expect((await callback({ key, status: 4 })).json()).toEqual({ error: 0 });
    expect((await row()).version).toBe(1);
  });

  it('status 6 (forcesave, JWT в теле) — сохраняет файл, version++, ключ не меняется', async () => {
    const before = await row();
    fetched = Buffer.concat([await createBlankDocument('docx'), Buffer.from('changed')]);
    const r = await callback({
      key: before.docKey,
      status: 6,
      url: pub('file.docx'),
      users: [adminId],
    });
    expect(r.json()).toEqual({ error: 0 });
    const after = await row();
    expect(after.version).toBe(2);
    expect(after.docKey).toBe(before.docKey);
    expect(after.updatedBy).toBe(adminId);
    expect((await t.deps.storage.read(after.filePath)).equals(fetched)).toBe(true);
    expect(fetchedUrls.at(-1)).toBe(internal('file.docx'));
  });

  it('status 2 (JWT в заголовке) — сохраняет и выдаёт новый ключ', async () => {
    const before = await row();
    const r = await callback(
      { key: before.docKey, status: 2, url: pub('f.docx'), users: [adminId] },
      'header',
    );
    expect(r.json()).toEqual({ error: 0 });
    const after = await row();
    expect(after.version).toBe(2);
    expect(after.docKey).not.toBe(before.docKey);
  });

  it('устаревший ключ (после закрытия сессии) игнорируется и не затирает новую версию', async () => {
    const old = (await row()).docKey;
    await callback({ key: old, status: 2, url: pub('f.docx') });
    const v = (await row()).version;
    const r = await callback({ key: old, status: 6, url: pub('stale.docx') });
    expect(r.json()).toEqual({ error: 0 });
    expect((await row()).version).toBe(v);
  });

  it('по url пришёл не документ — файл не перезаписывается, lastSaveError заполнен', async () => {
    const before = await row();
    const original = await t.deps.storage.read(before.filePath);
    fetched = Buffer.from('<html>error</html>');
    await callback({ key: before.docKey, status: 6, url: pub('f') });
    const after = await row();
    expect(after.version).toBe(1);
    expect(after.lastSaveError).toMatch(/не является документом/);
    expect((await t.deps.storage.read(after.filePath)).equals(original)).toBe(true);
  });

  it('status 3 — lastSaveError виден админу в деталях шаблона, следующее сохранение его сбрасывает', async () => {
    const key = (await row()).docKey;
    await callback({ key, status: 3, url: pub('f') });
    const d = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${tplId}`,
      headers: { cookie: admin },
    });
    expect(d.json().lastSaveError).toBe('OnlyOffice не смог сохранить документ');
    await callback({ key, status: 6, url: pub('f.docx') });
    expect((await row()).lastSaveError).toBeNull();
  });
});

describe('callback hardening', () => {
  it('конкурентные callback-и: итоговый файл — последний (final), ключ сменён', async () => {
    const before = await row();
    const slow = callback({ key: before.docKey, status: 6, url: pub('slow') });
    await new Promise((r) => setTimeout(r, 50));
    const fin = callback({ key: before.docKey, status: 2, url: pub('final') });
    await Promise.all([slow, fin]);
    const after = await row();
    const stored = await t.deps.storage.read(after.filePath);
    expect(stored.subarray(-5).toString()).toBe('final');
    expect(after.docKey).not.toBe(before.docKey);
  });

  it('callback без status → 400', async () => {
    const r = await callback({ key: (await row()).docKey });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('BAD_CALLBACK');
  });

  it.each([
    'https://localhost:8443/onlyoffice/web-apps/apps/api/documents/api.js',
    'http://169.254.169.254/latest/meta-data',
    'not a url',
  ])('ссылка не на кэш Document Server (%s) → lastSaveError, без скачивания', async (url) => {
    const before = await row();
    const calls = fetchedUrls.length;
    const r = await callback({ key: before.docKey, status: 6, url });
    expect(r.json()).toEqual({ error: 0 });
    const after = await row();
    expect(after.version).toBe(1);
    expect(after.lastSaveError).toBe('OnlyOffice передал недопустимую ссылку на файл');
    expect(fetchedUrls.length).toBe(calls);
  });

  it('fetchFile упал → 5xx и lastSaveError', async () => {
    const r = await callback({ key: (await row()).docKey, status: 6, url: pub('boom') });
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect((await row()).lastSaveError).toBe('не удалось скачать файл из OnlyOffice');
  });

  it('токен сессии в ?t= не открывает файл', async () => {
    const session = admin.split('=')[1]!;
    const r = await t.app.inject({
      method: 'GET',
      url: `/internal/templates/${tplId}/file?t=${session}`,
    });
    expect(r.statusCode).toBe(403);
  });
});

describe('save', () => {
  it('POST /save отправляет forcesave с текущим ключом', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tplId}/save`,
      headers: { cookie: admin },
    });
    expect(r.statusCode).toBe(204);
    expect(forceSaved.at(-1)).toBe((await row()).docKey);
  });
});
