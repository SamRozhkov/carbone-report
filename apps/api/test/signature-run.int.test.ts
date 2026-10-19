import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportRunSignatures, reportRuns } from '../src/db/schema';
import type { CarboneRenderer } from '../src/deps';
import { cleanupOldReports } from '../src/modules/reports/cleanup';
import { fixture, FIXTURE_PASSWORD } from '../src/modules/pdf/sign/fixtures';
import { startTestTsa, type TestTsa } from '../src/modules/pdf/sign/test-tsa';
import { opensslVerify } from '../src/modules/pdf/sign/test-verify';
import { makePdf } from '../src/modules/pdf/test-pdf';
import { createTemplate, createTestApp, loginAs, multipart, type TestApp } from './helpers';

let t: TestApp;
let tsa: TestTsa;
let templateId: string;
let plainId: string;
let user: { cookie: string; user: { id: string } };
let adminCookie: string;

// Поддельный Carbone (как в pdf-render.int.test.ts): PDF с одной страницей; прочие форматы — текст.
const carbone: CarboneRenderer = {
  async render(_tpl, _data, ro) {
    return ro.convertTo === 'pdf'
      ? Buffer.from(await makePdf([{ label: 'REPORT' }]))
      : Buffer.from('DOCX');
  },
};

const savePdf = (id: string, body: object) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/pdf-options`,
    headers: { cookie: adminCookie },
    payload: body,
  });

beforeAll(async () => {
  tsa = await startTestTsa();
  t = await createTestApp({ carbone }, { signTsaUrl: tsa.url });
  adminCookie = (await loginAs(t, 'admin')).cookie;
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
  templateId = await createTemplate(t, adminCookie, dsId, { public: true });
  plainId = await createTemplate(t, adminCookie, dsId, { public: true });
  const saved = await savePdf(templateId, { pdfa: false, signature: { position: 'bottom-left' } });
  if (saved.statusCode !== 200) throw new Error(saved.body);
});
afterAll(async () => {
  await t?.close();
  await tsa?.close();
});
beforeEach(async () => {
  tsa.mode = 'ok';
  user = await loginAs(t, 'user');
  const body = multipart(
    { password: FIXTURE_PASSWORD },
    { name: 'me.p12', data: fixture('rsa.p12') },
  );
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/me/certificate',
    headers: { cookie: user.cookie, ...body.headers },
    payload: body.payload,
  });
  if (r.statusCode !== 201) throw new Error(r.body);
});

const render = async (cookie: string, id = templateId) => {
  const r = await t.app.inject({
    method: 'POST',
    url: `/api/reports/${id}/render`,
    headers: { cookie },
    payload: { params: {} },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().runId as string;
};
const signRun = (cookie: string, runId: string, password = FIXTURE_PASSWORD) =>
  t.app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/sign`,
    headers: { cookie },
    payload: { password },
  });
const runsOf = async (cookie: string) =>
  (await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie } })).json()
    .items as Array<{ id: string; signable: boolean; signature: unknown }>;

describe('подпись запуска (§39.3)', () => {
  it('успех: 201, подписанный PDF скачивается и проверяется, история', async () => {
    const runId = await render(user.cookie);
    expect((await runsOf(user.cookie)).find((r) => r.id === runId)).toMatchObject({
      signable: true,
      signature: null,
    });
    const res = await signRun(user.cookie, runId);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      signerCn: 'Иванов Иван Иванович (rsa)',
      timestamped: true,
    });
    const file = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/file?format=pdf&signed=1`,
      headers: { cookie: user.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(String(file.headers['content-disposition'])).toContain('-signed.pdf');
    await opensslVerify(file.rawPayload);
    const plain = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/file?format=pdf`,
      headers: { cookie: user.cookie },
    });
    expect(plain.rawPayload.includes(Buffer.from('/ETSI.CAdES.detached'))).toBe(false);
    expect((await runsOf(user.cookie)).find((r) => r.id === runId)).toMatchObject({
      signable: false,
      signature: { timestamped: true, signerCn: 'Иванов Иван Иванович (rsa)' },
    });
  });

  it('повтор — 409; два одновременных — одна подпись', async () => {
    const runId = await render(user.cookie);
    const [a, b] = await Promise.all([signRun(user.cookie, runId), signRun(user.cookie, runId)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const again = await signRun(user.cookie, runId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ message: 'отчёт уже подписан' });
    expect(
      await t.deps.db
        .select()
        .from(reportRunSignatures)
        .where(eq(reportRunSignatures.runId, runId)),
    ).toHaveLength(1);
  });

  it('служба меток отказала — 502, подписи нет; повтор после восстановления — 201', async () => {
    const runId = await render(user.cookie);
    tsa.mode = 'reject';
    const failed = await signRun(user.cookie, runId);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toMatchObject({
      code: 'TSA_UNAVAILABLE',
      message: 'служба меток времени недоступна',
    });
    expect(failed.body).not.toContain(FIXTURE_PASSWORD);
    expect(
      await t.deps.db
        .select()
        .from(reportRunSignatures)
        .where(eq(reportRunSignatures.runId, runId)),
    ).toHaveLength(0);
    expect(await t.deps.storage.exists(`reports/${runId}/out.signed.pdf`)).toBe(false);
    tsa.mode = 'ok';
    expect((await signRun(user.cookie, runId)).statusCode).toBe(201);
  });

  it('чужой запуск — 404 (и для администратора); без подписи в снимке — 400', async () => {
    const runId = await render(user.cookie);
    const other = await loginAs(t, 'user');
    expect((await signRun(other.cookie, runId)).statusCode).toBe(404);
    const admin = await loginAs(t, 'admin');
    expect((await signRun(admin.cookie, runId)).statusCode).toBe(404);
    const plainRun = await render(user.cookie, plainId);
    expect((await runsOf(user.cookie)).find((r) => r.id === plainRun)).toMatchObject({
      signable: false,
      signature: null,
    });
    const res = await signRun(user.cookie, plainRun);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ message: 'подпись для этого отчёта недоступна' });
  });

  it('снимок решает: выключили подпись после запуска — подписать можно; включили — старый запуск нельзя', async () => {
    const before = await render(user.cookie);
    await savePdf(templateId, { pdfa: false });
    try {
      expect((await signRun(user.cookie, before)).statusCode).toBe(201);
      const noSig = await render(user.cookie);
      await savePdf(templateId, { pdfa: false, signature: { position: 'bottom-left' } });
      expect((await signRun(user.cookie, noSig)).statusCode).toBe(400);
    } finally {
      await savePdf(templateId, { pdfa: false, signature: { position: 'bottom-left' } });
    }
  });

  it('нет сертификата — 400 с подсказкой', async () => {
    const runId = await render(user.cookie);
    await t.app.inject({
      method: 'DELETE',
      url: '/api/me/certificate',
      headers: { cookie: user.cookie },
    });
    const res = await signRun(user.cookie, runId);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      message: 'загрузите сертификат на странице «Моя подпись»',
    });
  });

  it('неверный пароль — 400 у /password; пять неверных — затем 429 даже с верным', async () => {
    const runId = await render(user.cookie);
    for (let i = 0; i < 5; i++) {
      const r = await signRun(user.cookie, runId, `неверный-${i}`);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatchObject({
        code: 'VALIDATION',
        details: [{ path: '/password', message: 'неверный пароль к ключу' }],
      });
      expect(r.body).not.toContain(`неверный-${i}`);
    }
    const blocked = await signRun(user.cookie, runId);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatchObject({
      code: 'TOO_MANY_ATTEMPTS',
      message: 'слишком много неверных паролей — попробуйте через 15 минут',
    });
    expect(
      await t.deps.db
        .select()
        .from(reportRunSignatures)
        .where(eq(reportRunSignatures.runId, runId)),
    ).toHaveLength(0);
  });

  it('четыре неверных, затем верный — подписано; верные попытки счёт не увеличивают', async () => {
    const runId = await render(user.cookie);
    for (let i = 0; i < 4; i++) await signRun(user.cookie, runId, 'нет');
    expect((await signRun(user.cookie, runId)).statusCode).toBe(201);
    // Верная попытка счёт не увеличила: ещё один неверный — 400, а не 429.
    const second = await render(user.cookie);
    expect((await signRun(user.cookie, second, 'нет')).statusCode).toBe(400);
    expect((await signRun(user.cookie, second)).statusCode).toBe(429);
  });

  it('signed=1: не подписан — 404, другой формат — 400', async () => {
    const runId = await render(user.cookie);
    const url = `/api/runs/${runId}/file?signed=1`;
    expect(
      (await t.app.inject({ method: 'GET', url, headers: { cookie: user.cookie } })).statusCode,
    ).toBe(404);
    const docx = await t.app.inject({
      method: 'GET',
      url: `${url}&format=docx`,
      headers: { cookie: user.cookie },
    });
    expect(docx.statusCode).toBe(400);
    expect(docx.json().error).toMatchObject({
      code: 'VALIDATION',
      message: 'формат недоступен для этого отчёта',
    });
  });

  it('пароль не попадает в строку подписи и в файлы запуска', async () => {
    const runId = await render(user.cookie);
    expect((await signRun(user.cookie, runId)).statusCode).toBe(201);
    const [row] = await t.deps.db
      .select()
      .from(reportRunSignatures)
      .where(eq(reportRunSignatures.runId, runId));
    expect(JSON.stringify(row)).not.toContain(FIXTURE_PASSWORD);
    for (const name of ['data.json', 'pdf-options.json', 'out.pdf', 'out.signed.pdf']) {
      const content = await t.deps.storage.read(`reports/${runId}/${name}`);
      expect(content.includes(Buffer.from(FIXTURE_PASSWORD))).toBe(false);
    }
  });

  it('очистка по сроку удаляет подпись и файл', async () => {
    const runId = await render(user.cookie);
    expect((await signRun(user.cookie, runId)).statusCode).toBe(201);
    await t.deps.db
      .update(reportRuns)
      .set({ createdAt: new Date('2000-01-01') })
      .where(eq(reportRuns.id, runId));
    await cleanupOldReports(t.deps);
    expect(
      await t.deps.db
        .select()
        .from(reportRunSignatures)
        .where(eq(reportRunSignatures.runId, runId)),
    ).toHaveLength(0);
    expect(await t.deps.storage.exists(`reports/${runId}/out.signed.pdf`)).toBe(false);
    const file = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/file?signed=1`,
      headers: { cookie: user.cookie },
    });
    expect(file.statusCode).toBe(410);
  });
});
