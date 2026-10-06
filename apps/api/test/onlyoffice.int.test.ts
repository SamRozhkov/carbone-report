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
  multipart,
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
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Заглушка для internal('held'): сообщает о начале скачивания и ждёт сигнала теста.
let held = { started: deferred(), release: deferred() };
// Document Server строит ссылку на результат от публичного origin (за nginx — префикс /onlyoffice).
const CACHE = (name: string) => `/cache/files/data/${name}/output.docx?md5=abc&expires=1`;
const pub = (name: string) => `https://localhost:8443/onlyoffice${CACHE(name)}`;
const internal = (name: string) => `http://onlyoffice${CACHE(name)}`;

beforeAll(async () => {
  t = await createTestApp({
    fetchFile: async (url) => {
      fetchedUrls.push(url);
      if (url === internal('held')) {
        held.started.resolve();
        await held.release.promise;
        return Buffer.concat([await createBlankDocument('docx'), Buffer.from('held')]);
      }
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
  if (via === 'body')
    payload = { ...body, token: await signOnlyOffice(body, secret(), { expiresIn: '5m' }) };
  else
    headers.authorization = `Bearer ${await signOnlyOffice({ payload: body }, secret(), { expiresIn: '5m' })}`;
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

  const adminDetails = async () =>
    (
      await t.app.inject({
        method: 'GET',
        url: `/api/templates/${tplId}`,
        headers: { cookie: admin },
      })
    ).json();

  it('повтор той же ошибки (status 3) даёт новую lastSaveErrorAt; успешное сохранение обнуляет оба поля', async () => {
    const key = (await row()).docKey;
    await callback({ key, status: 3 });
    const first = await adminDetails();
    await callback({ key, status: 3 });
    const second = await adminDetails();
    expect(second.lastSaveError).toBe(first.lastSaveError);
    expect(first.lastSaveErrorAt).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/));
    expect(Date.parse(second.lastSaveErrorAt)).toBeGreaterThan(Date.parse(first.lastSaveErrorAt));
    await callback({ key, status: 6, url: pub('f.docx') });
    const after = await adminDetails();
    expect(after.lastSaveError).toBeNull();
    expect(after.lastSaveErrorAt).toBeNull();
  });

  it('метка ошибки строго растёт, даже если часы не сдвинулись', async () => {
    const key = (await row()).docKey;
    const future = new Date(Date.now() + 3_600_000);
    await t.deps.db
      .update(templates)
      .set({ lastSaveError: 'прежняя', lastSaveErrorAt: future })
      .where(eq(templates.id, tplId));
    await callback({ key, status: 7 });
    expect((await row()).lastSaveErrorAt!.getTime()).toBe(future.getTime() + 1);
  });

  it('замена файла обнуляет lastSaveError и lastSaveErrorAt', async () => {
    await callback({ key: (await row()).docKey, status: 3 });
    expect((await row()).lastSaveErrorAt).not.toBeNull();
    const mp = multipart({}, { name: 'new.docx', data: await createBlankDocument('docx') });
    const r = await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${tplId}/file`,
      headers: { cookie: admin, ...mp.headers },
      payload: mp.payload,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ lastSaveError: null, lastSaveErrorAt: null });
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

  it('callback не держит блокировку строки во время скачивания: параллельный PATCH шаблона проходит', async () => {
    held = { started: deferred(), release: deferred() };
    const r0 = await row();
    let settled = false;
    const saving = callback({ key: r0.docKey, status: 6, url: pub('held') }).finally(() => {
      settled = true;
    });
    try {
      await held.started.promise; // скачивание идёт, release ещё не отдан
      const patch = await t.app.inject({
        method: 'PATCH',
        url: `/api/templates/${tplId}`,
        headers: { cookie: admin },
        payload: { description: 'параллельно' },
      });
      expect(patch.statusCode).toBe(200);
      expect(settled).toBe(false);
      expect((await row()).description).toBe('параллельно');
    } finally {
      held.release.resolve(); // и при падении — чтобы callback не висел до конца файла
    }
    expect((await saving).statusCode).toBe(200);
    const r1 = await row();
    expect(r1.version).toBe(r0.version + 1);
    expect((await t.deps.storage.read(r1.filePath)).subarray(-4).toString()).toBe('held');
  });

  it('ключ сменился за время скачивания: файл выбрасывается, версия не растёт', async () => {
    const r0 = await row();
    const saving = callback({ key: r0.docKey, status: 2, url: pub('slow') });
    await new Promise((r) => setTimeout(r, 50));
    await t.deps.db.update(templates).set({ docKey: 'changed' }).where(eq(templates.id, tplId));
    expect((await saving).statusCode).toBe(200);
    const r1 = await row();
    expect(r1.version).toBe(r0.version);
    expect(r1.filePath).toBe(r0.filePath);
    expect(r1.lastSaveError).toBeNull();
    expect(await t.deps.storage.exists(`templates/${tplId}/v${r0.version + 1}.docx`)).toBe(false);
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

describe('срок жизни callback-токена', () => {
  const raw = (token: string) =>
    t.app.inject({
      method: 'POST',
      url: `/internal/onlyoffice/callback/${tplId}`,
      payload: { token },
    });

  it('просроченный токен → 403, версия не меняется', async () => {
    const r0 = await row();
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ key: r0.docKey, status: 2, url: pub('x') })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3000)
      .sign(secret());
    expect((await raw(token)).statusCode).toBe(403);
    expect((await row()).version).toBe(r0.version);
  });

  it('токен без exp и iat → 403', async () => {
    const r0 = await row();
    const token = await signOnlyOffice({ key: r0.docKey, status: 2, url: pub('x') }, secret());
    expect((await raw(token)).statusCode).toBe(403);
  });

  it('повтор со свежим токеном после отказа сохраняет версию', async () => {
    const r0 = await row();
    const res = await callback({ key: r0.docKey, status: 2, url: pub('fresh') });
    expect(res.statusCode).toBe(200);
    expect((await row()).version).toBe(r0.version + 1);
  });

  it('чужой секрет → 403', async () => {
    const r0 = await row();
    const token = await signOnlyOffice(
      { key: r0.docKey, status: 2, url: pub('x') },
      new TextEncoder().encode('wrong-secret-'.repeat(4)),
      { expiresIn: '5m' },
    );
    expect((await raw(token)).statusCode).toBe(403);
  });

  it('статус 7 записывает lastSaveError и не меняет версию', async () => {
    const r0 = await row();
    const res = await callback({ key: r0.docKey, status: 7 });
    expect(res.statusCode).toBe(200);
    const r1 = await row();
    expect(r1.version).toBe(r0.version);
    expect(r1.lastSaveError).toBe('ошибка принудительного сохранения OnlyOffice');
  });
});
