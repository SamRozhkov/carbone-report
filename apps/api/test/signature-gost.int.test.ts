import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { gostSignPending, reportRunSignatures, reportRuns } from '../src/db/schema';
import type { CarboneRenderer, GostPreparer } from '../src/deps';
import { streebog } from '../src/modules/pdf/sign/gost/streebog';
import { cleanupGostPending } from '../src/modules/signature/gost-pending';
import { cleanupOldReports } from '../src/modules/reports/cleanup';
import { createTemplate, createTestApp, loginAs, type TestApp } from './helpers';
import { createTranslator } from '@carbone-reports/shared/i18n/server';

const gostFx = (n: string) =>
  readFileSync(new URL(`./fixtures/gost/${n}`, import.meta.url)) as Buffer;
const pemToB64 = (pem: string) =>
  pem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
    .trim();
const certB64 = (file: string, dir = 'gost') =>
  pemToB64(readFileSync(new URL(`./fixtures/${dir}/${file}`, import.meta.url), 'utf8'));
const sigB64 = (n: string) => gostFx(n).toString('base64');

const docPdf = gostFx('doc.pdf');
const docHash = Buffer.from(streebog(256, docPdf)).toString('hex');

// Поддельный Carbone отдаёт doc.pdf: подписи из фикстур сделаны над ним.
const carbone: CarboneRenderer = {
  async render(_tpl, _data, ro) {
    return ro.convertTo === 'pdf' ? docPdf : Buffer.from('DOCX');
  },
};

// Штамп не ставится: черновик = out.pdf. Ворота — для проверки одновременной подготовки (SIGN_BUSY);
// altered — черновик с другими байтами (как штамп с другим временем у повторной подготовки).
let hold: { entered: () => void; gate: Promise<void> } | null = null;
let altered = false;
const gostPrepare: GostPreparer = async (pdf) => {
  const h = hold;
  if (h) {
    hold = null;
    h.entered();
    await h.gate;
  }
  const out = altered ? Buffer.concat([pdf, Buffer.from('%altered\n')]) : pdf;
  return { pdf: out, hash: streebog(256, out) };
};

interface Env {
  t: TestApp;
  adminCookie: string;
  gostId: string;
  p12Id: string;
  templateName: string;
}

async function setup(
  config: Parameters<typeof createTestApp>[1] = {},
  stamp = false,
): Promise<Env> {
  // stamp — настоящая подготовка (штамп в пуле не нужен: inProcessGostPreparer из createTestApp).
  const t = await createTestApp(stamp ? { carbone } : { carbone, gostPrepare }, config);
  const adminCookie = (await loginAs(t, 'admin')).cookie;
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: adminCookie },
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
  const dsId = ds.json().id as string;
  const savePdf = async (id: string, body: object) => {
    const r = await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${id}/pdf-options`,
      headers: { cookie: adminCookie },
      payload: body,
    });
    if (r.statusCode !== 200) throw new Error(r.body);
  };
  const gostId = await createTemplate(t, adminCookie, dsId, { public: true });
  await savePdf(gostId, { pdfa: false, signature: { position: 'bottom-left', method: 'gost' } });
  const p12Id = await createTemplate(t, adminCookie, dsId, { public: true });
  await savePdf(p12Id, { pdfa: false, signature: { position: 'bottom-left' } });
  const tpl = await t.app.inject({
    method: 'GET',
    url: `/api/templates/${gostId}`,
    headers: { cookie: adminCookie },
  });
  return { t, adminCookie, gostId, p12Id, templateName: tpl.json().name as string };
}

let env: Env;
let tsaEnv: Env;
let user: { cookie: string; user: { id: string } };

beforeAll(async () => {
  env = await setup();
  tsaEnv = await setup({ signGostTsaUrl: 'http://tsa.example' });
});
afterAll(async () => {
  await env?.t.close();
  await tsaEnv?.t.close();
});
beforeEach(async () => {
  hold = null;
  altered = false;
  user = await loginAs(env.t, 'user');
});

const render = async (cookie: string, id = env.gostId, e: Env = env) => {
  const r = await e.t.app.inject({
    method: 'POST',
    url: `/api/reports/${id}/render`,
    headers: { cookie },
    payload: { params: {} },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().runId as string;
};
const prepare = (cookie: string, runId: string, certificate = certB64('user256a.pem'), e = env) =>
  e.t.app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/sign/gost/prepare`,
    headers: { cookie },
    payload: { certificate },
  });
const complete = (cookie: string, runId: string, signature: string, e = env) =>
  e.t.app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/sign/gost/complete`,
    headers: { cookie },
    payload: { signature },
  });
const download = (cookie: string, runId: string, query: string, e = env) =>
  e.t.app.inject({ method: 'GET', url: `/api/runs/${runId}/file?${query}`, headers: { cookie } });
const pendingOf = (runId: string, e = env) =>
  e.t.deps.db.select().from(gostSignPending).where(eq(gostSignPending.runId, runId));
/** Путь черновика у каждой подготовки свой (§42.2). */
const draftRe = (runId: string) =>
  new RegExp(`^reports/${runId}/out\\.gost\\.[0-9a-f-]{36}\\.pdf$`);
const draftOf = async (runId: string, e = env) => (await pendingOf(runId, e))[0]!.draftPath;

describe('подготовка подписи ГОСТ (§42.2)', () => {
  it('успех: хеш черновика, строка ожидания, черновик в хранилище', async () => {
    const runId = await render(user.cookie);
    const res = await prepare(user.cookie, runId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hash: docHash, hashAlg: 'streebog256', tsaUrl: null });
    const [row] = await pendingOf(runId);
    expect(row).toMatchObject({
      userId: user.user.id,
      hashAlg: 'streebog256',
      draftPath: expect.stringMatching(draftRe(runId)),
    });
    expect(Buffer.from(row!.hash).toString('hex')).toBe(docHash);
    expect(Buffer.from(row!.certDer).toString('base64')).toBe(certB64('user256a.pem'));
    const ttl = row!.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(await env.t.deps.storage.read(row!.draftPath)).toEqual(docPdf);
  });

  it.each([
    ['пустой', '', 'неверный сертификат'],
    ['мусор', Buffer.from('это не сертификат').toString('base64'), 'неверный сертификат'],
    ['RSA', certB64('ca.pem', 'sign'), 'сертификат не ГОСТ Р 34.10-2012 или не поддерживается'],
    ['истёкший', certB64('expired256.pem'), 'срок действия сертификата истёк'],
    ['без digitalSignature', certB64('nosign256.pem'), 'сертификат не предназначен для подписи'],
  ])('сертификат: %s — 400', async (_name, certificate, message) => {
    const runId = await render(user.cookie);
    const res = await prepare(user.cookie, runId, certificate);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ message });
    expect(await pendingOf(runId)).toHaveLength(0);
  });

  it('истёкший сертификат — текст на языке запроса (X-Locale), без заголовка — по-русски', async () => {
    const runId = await render(user.cookie);
    for (const locale of ['en', 'zh-CN'] as const) {
      const res = await env.t.app.inject({
        method: 'POST',
        url: `/api/runs/${runId}/sign/gost/prepare`,
        headers: { cookie: user.cookie, 'x-locale': locale },
        payload: { certificate: certB64('expired256.pem') },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe(createTranslator(locale)('errors:sign.certExpired'));
      expect(res.json().error.message).not.toMatch(/[а-яё]/i);
    }
    const ru = await prepare(user.cookie, runId, certB64('expired256.pem'));
    expect(ru.json().error.message).toBe('срок действия сертификата истёк');
  });

  it('чужой запуск — 404 (и для администратора); .p12-шаблон — 400', async () => {
    const runId = await render(user.cookie);
    const other = await loginAs(env.t, 'user');
    expect((await prepare(other.cookie, runId)).statusCode).toBe(404);
    expect((await prepare(env.adminCookie, runId)).statusCode).toBe(404);
    expect((await complete(other.cookie, runId, sigB64('bes-256a.sig'))).statusCode).toBe(404);
    const p12Run = await render(user.cookie, env.p12Id);
    const res = await prepare(user.cookie, p12Run);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ message: 'подпись для этого отчёта недоступна' });
    const done = await complete(user.cookie, p12Run, sigB64('bes-256a.sig'));
    expect(done.statusCode).toBe(400);
    expect(done.json().error).toMatchObject({ message: 'подпись для этого отчёта недоступна' });
  });

  it('повторная подготовка заменяет строку и удаляет прежний черновик', async () => {
    const runId = await render(user.cookie);
    // Прежнее ожидание с черновиком по другому пути (например, от прежней версии).
    const oldDraft = `reports/${runId}/old.gost.pdf`;
    await env.t.deps.storage.write(oldDraft, Buffer.from('old'));
    await env.t.deps.db.insert(gostSignPending).values({
      runId,
      userId: user.user.id,
      certDer: Buffer.from(certB64('other256.pem'), 'base64'),
      hash: Buffer.alloc(32),
      hashAlg: 'streebog256',
      draftPath: oldDraft,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await prepare(user.cookie, runId)).statusCode).toBe(200);
    const rows = await pendingOf(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.draftPath).toMatch(draftRe(runId));
    expect(Buffer.from(rows[0]!.certDer).toString('base64')).toBe(certB64('user256a.pem'));
    expect(Buffer.from(rows[0]!.hash).toString('hex')).toBe(docHash);
    expect(await env.t.deps.storage.exists(oldDraft)).toBe(false);
    // Повтор: новый путь, прежний черновик удалён, ожидание одно.
    const first = rows[0]!.draftPath;
    expect((await prepare(user.cookie, runId, certB64('other256.pem'))).statusCode).toBe(200);
    const again = await pendingOf(runId);
    expect(again).toHaveLength(1);
    expect(Buffer.from(again[0]!.certDer).toString('base64')).toBe(certB64('other256.pem'));
    expect(again[0]!.draftPath).toMatch(draftRe(runId));
    expect(again[0]!.draftPath).not.toBe(first);
    expect(await env.t.deps.storage.exists(first)).toBe(false);
    expect(await env.t.deps.storage.exists(again[0]!.draftPath)).toBe(true);
  });

  it('сбой фиксации повторной подготовки: прежняя строка с нетронутым черновиком, подпись совпадает', async () => {
    const runId = await render(user.cookie);
    expect((await prepare(user.cookie, runId)).statusCode).toBe(200);
    const [old] = await pendingOf(runId);
    // Отложенный триггер падает на COMMIT — уже после записи нового черновика и upsert строки.
    await env.t.deps.db.execute(sql`
      CREATE FUNCTION fail_gost_pending_commit() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'test: commit failed'; END $$`);
    await env.t.deps.db.execute(sql`
      CREATE CONSTRAINT TRIGGER fail_gost_pending_commit AFTER UPDATE ON gost_sign_pending
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_gost_pending_commit()`);
    altered = true;
    try {
      expect((await prepare(user.cookie, runId)).statusCode).toBe(500);
    } finally {
      altered = false;
      await env.t.deps.db.execute(sql`DROP TRIGGER fail_gost_pending_commit ON gost_sign_pending`);
      await env.t.deps.db.execute(sql`DROP FUNCTION fail_gost_pending_commit()`);
    }
    const [kept] = await pendingOf(runId);
    expect(kept!.draftPath).toBe(old!.draftPath);
    expect(Buffer.from(kept!.hash).toString('hex')).toBe(docHash);
    expect(await env.t.deps.storage.read(kept!.draftPath)).toEqual(docPdf);
    // Клиент с прежним хешем завершает подпись: подписанный PDF — ровно то, что покрывает .sig.
    expect((await complete(user.cookie, runId, sigB64('bes-256a.sig'))).statusCode).toBe(201);
    const signed = await download(user.cookie, runId, 'format=pdf&signed=1');
    expect(Buffer.from(streebog(256, signed.rawPayload)).toString('hex')).toBe(docHash);
  });

  it('одновременная вторая подготовка того же пользователя — 409 SIGN_BUSY', async () => {
    const a = await render(user.cookie);
    const b = await render(user.cookie);
    let release!: () => void;
    let entered!: () => void;
    const enteredFirst = new Promise<void>((r) => (entered = r));
    hold = { entered, gate: new Promise<void>((r) => (release = r)) };
    try {
      const first = prepare(user.cookie, a);
      await enteredFirst;
      const busy = await prepare(user.cookie, b);
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error).toMatchObject({
        code: 'SIGN_BUSY',
        message: 'другая подпись уже выполняется — повторите через несколько секунд',
      });
      release();
      expect((await first).statusCode).toBe(200);
    } finally {
      release();
    }
    expect(await pendingOf(b)).toHaveLength(0);
  });
});

describe('завершение подписи ГОСТ (§42.2, §42.6)', () => {
  it('успех: 201, история, PDF и .sig скачиваются', async () => {
    const runId = await render(user.cookie);
    expect((await prepare(user.cookie, runId)).statusCode).toBe(200);
    const draftPath = await draftOf(runId);
    const before = Date.now();
    const res = await complete(user.cookie, runId, sigB64('bes-256a.sig'));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      method: 'gost',
      signerCn: 'Иванов Иван Иванович (user256a)',
      timestamped: false,
    });
    expect(body.fingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(new Date(body.signedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await pendingOf(runId)).toHaveLength(0);
    expect(await env.t.deps.storage.exists(draftPath)).toBe(false);
    const [sig] = await env.t.deps.db
      .select()
      .from(reportRunSignatures)
      .where(eq(reportRunSignatures.runId, runId));
    expect(sig).toMatchObject({
      method: 'gost',
      filePath: `reports/${runId}/out.signed.pdf`,
      sigPath: `reports/${runId}/out.signed.pdf.sig`,
    });

    const runs = (
      await env.t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: user.cookie } })
    ).json().items as Array<{ id: string; signable: boolean; signature: { method: string } }>;
    expect(runs.find((r) => r.id === runId)).toMatchObject({
      signable: false,
      signature: { method: 'gost' },
    });

    const pdf = await download(user.cookie, runId, 'format=pdf&signed=1');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload).toEqual(docPdf);

    const date = new Date().toISOString().slice(0, 10);
    const file = await download(user.cookie, runId, 'format=sig');
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pkcs7-signature');
    expect(file.rawPayload).toEqual(gostFx('bes-256a.sig'));
    expect(String(file.headers['content-disposition'])).toContain(
      `filename*=UTF-8''${encodeURIComponent(`${env.templateName} ${date}-signed.pdf.sig`)}`,
    );
    // Администратор скачивает чужие файлы (§24.4).
    expect((await download(env.adminCookie, runId, 'format=sig')).statusCode).toBe(200);
    expect((await download(user.cookie, runId, 'format=sig&inline=1')).statusCode).toBe(400);
    expect((await download(user.cookie, runId, 'format=sig&signed=1')).statusCode).toBe(400);

    const again = await complete(user.cookie, runId, sigB64('bes-256a.sig'));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ message: 'отчёт уже подписан' });
    const reprep = await prepare(user.cookie, runId);
    expect(reprep.statusCode).toBe(409);
    expect(reprep.json().error).toMatchObject({ message: 'отчёт уже подписан' });
  });

  it('format=sig: не подписан и подписан .p12 — 404', async () => {
    const runId = await render(user.cookie);
    expect((await download(user.cookie, runId, 'format=sig')).statusCode).toBe(404);
    const p12Run = await render(user.cookie, env.p12Id);
    await env.t.deps.db.insert(reportRunSignatures).values({
      runId: p12Run,
      userId: user.user.id,
      signerCn: 'x',
      fingerprint: 'x',
      signedAt: new Date(),
      timestamped: false,
      filePath: `reports/${p12Run}/out.signed.pdf`,
    });
    expect((await download(user.cookie, p12Run, 'format=sig')).statusCode).toBe(404);
  });

  it('недействительная подпись — 400, ожидание остаётся, повтор верной — 201', async () => {
    const runId = await render(user.cookie);
    expect((await prepare(user.cookie, runId)).statusCode).toBe(200);
    const bad = await complete(user.cookie, runId, sigB64('bad-value.sig'));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ message: 'подпись недействительна' });
    expect(await pendingOf(runId)).toHaveLength(1);
    expect(await env.t.deps.storage.exists(await draftOf(runId))).toBe(true);
    expect(await env.t.deps.storage.exists(`reports/${runId}/out.signed.pdf`)).toBe(false);
    expect(await env.t.deps.storage.exists(`reports/${runId}/out.signed.pdf.sig`)).toBe(false);
    expect((await complete(user.cookie, runId, sigB64('bes-256a.sig'))).statusCode).toBe(201);
  });

  it('подпись другим сертификатом — 400', async () => {
    const runId = await render(user.cookie);
    expect((await prepare(user.cookie, runId)).statusCode).toBe(200);
    const res = await complete(user.cookie, runId, sigB64('bes-256a-other.sig'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ message: 'подпись сделана другим сертификатом' });
  });

  it('подпись больше 64 КБ — 400', async () => {
    const runId = await render(user.cookie);
    expect((await prepare(user.cookie, runId)).statusCode).toBe(200);
    const res = await complete(user.cookie, runId, Buffer.alloc(65_537).toString('base64'));
    expect(res.statusCode).toBe(400);
    expect(await pendingOf(runId)).toHaveLength(1);
  });

  it('без ожидания — 409; истёкшее — 409, строка и черновик удалены', async () => {
    const runId = await render(user.cookie);
    const none = await complete(user.cookie, runId, sigB64('bes-256a.sig'));
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toMatchObject({ message: 'начните подписание заново' });
    expect((await prepare(user.cookie, runId)).statusCode).toBe(200);
    const draftPath = await draftOf(runId);
    await env.t.deps.db.execute(
      sql`update gost_sign_pending set expires_at = now() - interval '1 minute' where run_id = ${runId}`,
    );
    const expired = await complete(user.cookie, runId, sigB64('bes-256a.sig'));
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error).toMatchObject({ message: 'начните подписание заново' });
    expect(await pendingOf(runId)).toHaveLength(0);
    expect(await env.t.deps.storage.exists(draftPath)).toBe(false);
  });

  it('вставка строки подписи упала — файлы удалены, ожидание остаётся, повтор подписывает', async () => {
    const runId = await render(user.cookie);
    expect((await prepare(user.cookie, runId)).statusCode).toBe(200);
    await env.t.deps.db.execute(sql`
      CREATE FUNCTION fail_gost_insert() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'test: insert failed'; END $$`);
    await env.t.deps.db.execute(sql`
      CREATE TRIGGER fail_gost_insert BEFORE INSERT ON report_run_signatures
        FOR EACH ROW EXECUTE FUNCTION fail_gost_insert()`);
    try {
      expect((await complete(user.cookie, runId, sigB64('bes-256a.sig'))).statusCode).toBe(500);
      expect(await env.t.deps.storage.exists(`reports/${runId}/out.signed.pdf`)).toBe(false);
      expect(await env.t.deps.storage.exists(`reports/${runId}/out.signed.pdf.sig`)).toBe(false);
      expect(await pendingOf(runId)).toHaveLength(1);
      expect(await env.t.deps.storage.exists(await draftOf(runId))).toBe(true);
    } finally {
      await env.t.deps.db.execute(sql`DROP TRIGGER fail_gost_insert ON report_run_signatures`);
      await env.t.deps.db.execute(sql`DROP FUNCTION fail_gost_insert()`);
    }
    expect((await complete(user.cookie, runId, sigB64('bes-256a.sig'))).statusCode).toBe(201);
  });

  it('сбой фиксации завершения: ожидание и его черновик остаются, повтор подписывает', async () => {
    const runId = await render(user.cookie);
    expect((await prepare(user.cookie, runId)).statusCode).toBe(200);
    const draftPath = await draftOf(runId);
    // Отложенный триггер падает на COMMIT — после записи файлов, строки подписи и удаления ожидания.
    await env.t.deps.db.execute(sql`
      CREATE FUNCTION fail_gost_complete_commit() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'test: commit failed'; END $$`);
    await env.t.deps.db.execute(sql`
      CREATE CONSTRAINT TRIGGER fail_gost_complete_commit AFTER DELETE ON gost_sign_pending
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_gost_complete_commit()`);
    try {
      expect((await complete(user.cookie, runId, sigB64('bes-256a.sig'))).statusCode).toBe(500);
    } finally {
      await env.t.deps.db.execute(sql`DROP TRIGGER fail_gost_complete_commit ON gost_sign_pending`);
      await env.t.deps.db.execute(sql`DROP FUNCTION fail_gost_complete_commit()`);
    }
    expect(await pendingOf(runId)).toHaveLength(1);
    expect(await env.t.deps.storage.exists(draftPath)).toBe(true);
    expect((await complete(user.cookie, runId, sigB64('bes-256a.sig'))).statusCode).toBe(201);
    expect(await env.t.deps.storage.exists(draftPath)).toBe(false);
  });
});

describe('снимок решает способ (§42.1)', () => {
  const setMethod = async (templateId: string, method?: 'gost') => {
    const r = await env.t.app.inject({
      method: 'PUT',
      url: `/api/templates/${templateId}/pdf-options`,
      headers: { cookie: env.adminCookie },
      payload: { pdfa: false, signature: { position: 'bottom-left', ...(method && { method }) } },
    });
    if (r.statusCode !== 200) throw new Error(r.body);
  };
  const signP12 = (runId: string) =>
    env.t.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/sign`,
      headers: { cookie: user.cookie },
      payload: { password: 'x' },
    });
  const methodOf = async (runId: string) =>
    (
      (
        await env.t.app.inject({
          method: 'GET',
          url: '/api/runs',
          headers: { cookie: user.cookie },
        })
      ).json().items as Array<{ id: string; signMethod: unknown }>
    ).find((r) => r.id === runId)?.signMethod;

  it('смена способа в шаблоне не меняет уже созданные запуски', async () => {
    const gostRun = await render(user.cookie);
    const p12Run = await render(user.cookie, env.p12Id);
    await setMethod(env.gostId);
    await setMethod(env.p12Id, 'gost');
    try {
      expect(await methodOf(gostRun)).toBe('gost');
      expect(await methodOf(p12Run)).toBe('p12');
      // ГОСТ-запуск: .p12 по-прежнему не подписывает, плагин — подписывает.
      const p12 = await signP12(gostRun);
      expect(p12.statusCode).toBe(400);
      expect(p12.json().error).toMatchObject({ message: 'подпись для этого отчёта недоступна' });
      expect((await prepare(user.cookie, gostRun)).statusCode).toBe(200);
      expect((await complete(user.cookie, gostRun, sigB64('bes-256a.sig'))).statusCode).toBe(201);
      // .p12-запуск ГОСТ не подписывается.
      const gost = await prepare(user.cookie, p12Run);
      expect(gost.statusCode).toBe(400);
      expect(gost.json().error).toMatchObject({ message: 'подпись для этого отчёта недоступна' });
    } finally {
      await setMethod(env.gostId, 'gost');
      await setMethod(env.p12Id);
    }
  });
});

describe('настоящая подготовка (штамп §42.3)', () => {
  it('черновик со штампом, хеш — Стрибог черновика; out.pdf не меняется', async () => {
    const e = await setup({}, true);
    try {
      const u = await loginAs(e.t, 'user');
      const runId = await render(u.cookie, e.gostId, e);
      const res = await prepare(u.cookie, runId, undefined, e);
      expect(res.statusCode).toBe(200);
      const stamped = await e.t.deps.storage.read(await draftOf(runId, e));
      expect(stamped.equals(docPdf)).toBe(false);
      expect(res.json().hash).toBe(Buffer.from(streebog(256, stamped)).toString('hex'));
      expect(await e.t.deps.storage.read(`reports/${runId}/out.pdf`)).toEqual(docPdf);
    } finally {
      await e.t.close();
    }
  });
});

describe('метка времени (SIGN_GOST_TSA_URL)', () => {
  it('подготовка отдаёт tsaUrl; без метки — 400; CAdES-T — 201, signedAt — время метки', async () => {
    const u = await loginAs(tsaEnv.t, 'user');
    const runId = await render(u.cookie, tsaEnv.gostId, tsaEnv);
    const res = await prepare(u.cookie, runId, undefined, tsaEnv);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      hash: docHash,
      hashAlg: 'streebog256',
      tsaUrl: 'http://tsa.example',
    });
    const bes = await complete(u.cookie, runId, sigB64('bes-256a.sig'), tsaEnv);
    expect(bes.statusCode).toBe(400);
    expect(bes.json().error).toMatchObject({ message: 'нет метки времени' });
    // genTime t-256a.sig (2026-10-20T15:04:15Z) раньше этой подготовки больше чем на 5 минут.
    const late = await complete(u.cookie, runId, sigB64('t-256a.sig'), tsaEnv);
    expect(late.statusCode).toBe(400);
    expect(late.json().error).toMatchObject({ message: 'метка времени недействительна' });
    // Подготовка и завершение «в момент» создания тестовых данных: метка — в окне (§42.4 п. 5).
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-20T15:06:00Z') });
    try {
      expect((await prepare(u.cookie, runId, undefined, tsaEnv)).statusCode).toBe(200);
      vi.setSystemTime(new Date('2026-10-20T15:07:00Z'));
      const t = await complete(u.cookie, runId, sigB64('t-256a.sig'), tsaEnv);
      expect(t.statusCode).toBe(201);
      expect(t.json()).toMatchObject({
        method: 'gost',
        timestamped: true,
        signedAt: '2026-10-20T15:04:15.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('очистка (§42.5)', () => {
  it('cleanupGostPending удаляет истёкшие ожидания и черновики, действующие оставляет', async () => {
    const live = await render(user.cookie);
    const old = await render(user.cookie);
    expect((await prepare(user.cookie, live)).statusCode).toBe(200);
    expect((await prepare(user.cookie, old)).statusCode).toBe(200);
    const [liveDraft, oldDraft] = [await draftOf(live), await draftOf(old)];
    await env.t.deps.db
      .update(gostSignPending)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(gostSignPending.runId, old));
    expect(await cleanupGostPending(env.t.deps)).toBeGreaterThanOrEqual(1);
    expect(await pendingOf(old)).toHaveLength(0);
    expect(await env.t.deps.storage.exists(oldDraft)).toBe(false);
    expect(await pendingOf(live)).toHaveLength(1);
    expect(await env.t.deps.storage.exists(liveDraft)).toBe(true);
  });

  it('cleanupOldReports удаляет ожидание запуска и каталог с .sig', async () => {
    const signed = await render(user.cookie);
    expect((await prepare(user.cookie, signed)).statusCode).toBe(200);
    expect((await complete(user.cookie, signed, sigB64('bes-256a.sig'))).statusCode).toBe(201);
    const waiting = await render(user.cookie);
    expect((await prepare(user.cookie, waiting)).statusCode).toBe(200);
    const waitingDraft = await draftOf(waiting);
    await env.t.deps.db
      .update(reportRuns)
      .set({ createdAt: new Date('2000-01-01') })
      .where(sql`${reportRuns.id} in (${signed}, ${waiting})`);
    await cleanupOldReports(env.t.deps);
    expect(await pendingOf(waiting)).toHaveLength(0);
    expect(await env.t.deps.storage.exists(waitingDraft)).toBe(false);
    expect(await env.t.deps.storage.exists(`reports/${signed}/out.signed.pdf.sig`)).toBe(false);
    expect(
      await env.t.deps.db
        .select()
        .from(reportRunSignatures)
        .where(eq(reportRunSignatures.runId, signed)),
    ).toHaveLength(0);
    expect((await download(user.cookie, signed, 'format=sig')).statusCode).toBe(410);
  });
});
