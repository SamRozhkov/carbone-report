import { createHash } from 'node:crypto';
import type { RunDto } from '@carbone-reports/shared';
import { and, desc, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reportRunFiles, reportRuns, templates } from '../src/db/schema';
import type { CarboneRenderer } from '../src/deps';
import { Deadline } from '../src/lib/deadline';
import { AppError } from '../src/lib/errors';
import { createRunFileGate } from '../src/lib/run-file-gate';
import { RUN_FILE_LOCK_CLASS } from '../src/modules/reports/snapshot';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  openTemplate,
  type SourceConn,
  type TestApp,
} from './helpers';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const GONE = 'файл удалён — сформируйте отчёт заново';
const UNAVAILABLE = { code: 'VALIDATION', message: 'формат недоступен для этого отчёта' };

let t: TestApp;
let admin: string;
let userA: string;
let userAId: string;
let userB: string;
let src: SourceConn;
let dsId: string;
let tplId: string;
let xlsxId: string;

const renders: { tplId: string; convertTo: string }[] = [];
let delayMs = 0;
let failWith: AppError | null = null;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// Поддельный Carbone: отвечает JSON-описанием того, что получил.
const carbone: CarboneRenderer = {
  async render(tpl, data, opts) {
    renders.push({ tplId: tpl.id, convertTo: opts.convertTo });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (failWith) throw failWith;
    return Buffer.from(
      JSON.stringify({
        tplId: tpl.id,
        version: tpl.version,
        tplSha: sha(await tpl.read()),
        data,
        convertTo: opts.convertTo,
      }),
    );
  },
};

const render = (cookie: string, id = tplId) =>
  t.app.inject({
    method: 'POST',
    url: `/api/reports/${id}/render`,
    headers: { cookie },
    payload: { params: {} },
  });
const file = (cookie: string, runId: string, q = '') =>
  t.app.inject({ method: 'GET', url: `/api/runs/${runId}/file${q}`, headers: { cookie } });
const newRun = async (cookie = userA, id = tplId): Promise<string> => {
  const r = await render(cookie, id);
  expect(r.statusCode).toBe(201);
  return r.json().runId as string;
};
const listed = async (cookie: string, runId: string): Promise<RunDto> =>
  (
    (await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie } })).json()
      .items as RunDto[]
  ).find((x) => x.id === runId)!;
const srcExec = async (q: string) => {
  const c = new pg.Client({
    host: src.host,
    port: src.port,
    database: src.database,
    user: src.username,
    password: src.password,
  });
  await c.connect();
  try {
    await c.query(q);
  } finally {
    await c.end();
  }
};
const tplRow = async () =>
  (await t.deps.db.select().from(templates).where(eq(templates.id, tplId)))[0]!;

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = (await loginAs(t, 'admin')).cookie;
  const a = await loginAs(t, 'user');
  userA = a.cookie;
  userAId = a.user.id;
  userB = (await loginAs(t, 'user')).cookie;
  src = await createSourceDatabase(
    'create table orders(id int, total numeric); insert into orders values (1, 100);',
  );
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: { name: 'src', ...src, sslMode: 'disable' },
  });
  dsId = ds.json().id;
  tplId = await createTemplate(t, admin, dsId, {
    public: true,
    queries: [{ key: 'orders', mode: 'list', sql: 'select id, total from orders order by id' }],
  });
  const x = await t.app.inject({
    method: 'POST',
    url: '/api/templates',
    headers: { cookie: admin },
    payload: { name: 'Таблица', datasourceId: dsId, blank: 'xlsx' },
  });
  xlsxId = x.json().id;
  await openTemplate(t, xlsxId);
});
afterAll(() => t.close());
beforeEach(() => {
  renders.length = 0;
  delayMs = 0;
  failWith = null;
});

describe('снимок запуска', () => {
  it('формирование создаёт снимок и PDF; Carbone получает копию шаблона под ключом запуска', async () => {
    const runId = await newRun();
    const [run] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, runId));
    expect(run).toMatchObject({
      status: 'ok',
      snapshot: true,
      outputFormat: null,
      filePath: `reports/${runId}/template.docx`,
    });
    expect(await t.deps.storage.read(`reports/${runId}/template.docx`)).toEqual(
      await t.deps.storage.read((await tplRow()).filePath),
    );
    expect(
      JSON.parse((await t.deps.storage.read(`reports/${runId}/data.json`)).toString('utf8')),
    ).toEqual({ orders: [{ id: 1, total: 100 }], params: {} });
    expect(await t.deps.storage.exists(`reports/${runId}/out.pdf`)).toBe(true);
    expect(renders).toEqual([{ tplId: `run:${runId}`, convertTo: 'pdf' }]);
    const files = await t.deps.db
      .select()
      .from(reportRunFiles)
      .where(eq(reportRunFiles.runId, runId));
    expect(files.map((f) => [f.format, f.filePath])).toEqual([['pdf', `reports/${runId}/out.pdf`]]);

    const pdf = await file(userA, runId, '?format=pdf&inline=1');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/^inline;/);
    expect(renders).toHaveLength(1); // PDF готов — повторного рендера нет
  });

  it('без format — PDF; DOCX собирается по требованию один раз, дальше отдаётся готовым', async () => {
    const runId = await newRun();
    const def = await file(userA, runId);
    expect(def.headers['content-type']).toBe('application/pdf');
    renders.length = 0;

    const d1 = await file(userA, runId, '?format=docx');
    expect(d1.statusCode).toBe(200);
    expect(d1.headers['content-type']).toBe(DOCX_MIME);
    expect(d1.headers['content-disposition']).toMatch(/^attachment; filename=".*\.docx"/);
    expect(JSON.parse(d1.body)).toMatchObject({ tplId: `run:${runId}`, convertTo: 'docx' });
    const d2 = await file(userA, runId, '?format=docx');
    expect(d2.body).toBe(d1.body);
    expect(renders).toEqual([{ tplId: `run:${runId}`, convertTo: 'docx' }]);
    expect(await t.deps.storage.exists(`reports/${runId}/out.docx`)).toBe(true);

    expect(await listed(userA, runId)).toMatchObject({
      outputFormat: null,
      fileAvailable: true,
      formats: ['pdf', 'docx', 'odt'],
      readyFormats: ['pdf', 'docx'],
    });
  });

  it('Excel-шаблон: просмотр PDF, XLSX и ODS по требованию; DOCX — 400', async () => {
    const runId = await newRun(userA, xlsxId);
    expect(renders).toEqual([{ tplId: `run:${runId}`, convertTo: 'pdf' }]);
    expect((await file(userA, runId, '?format=xlsx')).statusCode).toBe(200);
    expect((await file(userA, runId, '?format=ods')).statusCode).toBe(200);
    const docx = await file(userA, runId, '?format=docx');
    expect(docx.statusCode).toBe(400);
    expect(docx.json().error).toEqual(UNAVAILABLE);
    expect((await listed(userA, runId)).formats).toEqual(['pdf', 'xlsx', 'ods']);
  });

  it('файл собирается из снимка: данные в источнике и шаблон изменились', async () => {
    const runId = await newRun();
    const preview = JSON.parse((await file(userA, runId)).body);
    const tpl = await tplRow();
    const original = await t.deps.storage.read(tpl.filePath);
    await srcExec('insert into orders values (2, 999)');
    await t.deps.storage.write(tpl.filePath, Buffer.from('другой шаблон'));
    await t.deps.db
      .update(templates)
      .set({ version: tpl.version + 1 })
      .where(eq(templates.id, tplId));
    try {
      const docx = JSON.parse((await file(userA, runId, '?format=docx')).body);
      expect(docx.data).toEqual(preview.data);
      expect(docx.tplSha).toBe(preview.tplSha);
      expect(docx.version).toBe(preview.version);
      expect(docx.tplId).toBe(`run:${runId}`);
      // Новый запуск видит новые данные и новый шаблон.
      const fresh = JSON.parse((await file(userA, await newRun())).body);
      expect(fresh.tplSha).toBe(sha(Buffer.from('другой шаблон')));
      expect(fresh.data.orders).toHaveLength(2);
    } finally {
      await srcExec('delete from orders where id = 2');
      await t.deps.storage.write(tpl.filePath, original);
    }
  });

  it('два одновременных запроса DOCX — одна сборка, оба получают один и тот же файл', async () => {
    const runId = await newRun();
    renders.length = 0;
    delayMs = 300;
    const [a, b] = await Promise.all([
      file(userA, runId, '?format=docx'),
      file(userA, runId, '?format=docx'),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.body).toBe(b.body);
    expect(renders).toEqual([{ tplId: `run:${runId}`, convertTo: 'docx' }]);
  });

  it('много одновременных запросов DOCX не занимают основной пул: история отвечает во время сборки, сборка одна', async () => {
    const runId = await newRun();
    renders.length = 0;
    delayMs = 1500;
    const N = 14; // больше, чем соединений в основном пуле (10)
    let settled = 0;
    const reqs = Array.from({ length: N }, () =>
      file(userA, runId, '?format=docx').then((r) => {
        settled++;
        return r;
      }),
    );
    await expect.poll(() => renders.length).toBe(1);
    const runs = await t.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie: userA },
    });
    expect(runs.statusCode).toBe(200);
    // История ответила, пока сборка ещё идёт: ни один запрос файла не завершился.
    expect(settled).toBe(0);
    const all = await Promise.all(reqs);
    expect(all.map((r) => r.statusCode)).toEqual(Array(N).fill(200));
    expect(new Set(all.map((r) => r.body)).size).toBe(1);
    expect(renders).toEqual([{ tplId: `run:${runId}`, convertTo: 'docx' }]);
  });

  it('недопустимый формат → 400 VALIDATION; ничего не собирается', async () => {
    const runId = await newRun();
    renders.length = 0;
    for (const q of ['?format=xlsx', '?format=pptx', '?format=exe', '?format=']) {
      const r = await file(userA, runId, q);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toEqual(UNAVAILABLE);
    }
    expect(renders).toHaveLength(0);
  });

  it('старый запуск: только его формат, без format — он же; в истории formats = [его формат]', async () => {
    const id = crypto.randomUUID();
    await t.deps.storage.write(`reports/${id}.docx`, Buffer.from('old-docx'));
    await t.deps.db.insert(reportRuns).values({
      id,
      templateId: tplId,
      templateName: 'старый',
      templateVersion: 1,
      userId: userAId,
      params: {},
      outputFormat: 'docx',
      status: 'ok',
      filePath: `reports/${id}.docx`,
      durationMs: 1,
    });
    const def = await file(userA, id);
    expect(def.statusCode).toBe(200);
    expect(def.headers['content-type']).toBe(DOCX_MIME);
    expect(def.body).toBe('old-docx');
    expect((await file(userA, id, '?format=docx')).body).toBe('old-docx');
    const pdf = await file(userA, id, '?format=pdf');
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json().error).toEqual(UNAVAILABLE);
    expect(await listed(userA, id)).toMatchObject({
      outputFormat: 'docx',
      fileAvailable: true,
      formats: ['docx'],
      readyFormats: ['docx'],
    });
    expect(renders).toHaveLength(0);
  });

  it('снимок удалён → 410 «файл удалён — сформируйте отчёт заново», сборки нет', async () => {
    const runId = await newRun();
    await t.deps.storage.remove(`reports/${runId}`);
    renders.length = 0;
    for (const q of ['?format=docx', '']) {
      const r = await file(userA, runId, q);
      expect(r.statusCode).toBe(410);
      expect(r.json().error).toEqual({ code: 'GONE', message: GONE });
    }
    expect(renders).toHaveLength(0);

    const expired = await newRun();
    await t.deps.db.update(reportRuns).set({ fileDeleted: true }).where(eq(reportRuns.id, expired));
    const r = await file(userA, expired, '?format=odt');
    expect(r.statusCode).toBe(410);
    expect(r.json().error.message).toBe(GONE);
    expect(await listed(userA, expired)).toMatchObject({
      fileAvailable: false,
      formats: [],
      readyFormats: [],
    });
  });

  it('ошибка сборки возвращается как есть; статус запуска не меняется; повтор собирает заново', async () => {
    const runId = await newRun();
    const message =
      'в шаблоне используется html — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»';
    failWith = new AppError('CARBONE_COMMUNITY', 400, message);
    const r = await file(userA, runId, '?format=docx');
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: 'CARBONE_COMMUNITY', message });
    failWith = null;
    const [run] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, runId));
    expect(run).toMatchObject({ status: 'ok', error: null, fileDeleted: false });
    expect(await t.deps.storage.exists(`reports/${runId}/out.docx`)).toBe(false);
    expect((await listed(userA, runId)).readyFormats).toEqual(['pdf']);
    expect((await file(userA, runId, '?format=docx')).statusCode).toBe(200);
  });

  it('чужой запуск → 404 без сборки; админ — 200', async () => {
    const runId = await newRun(userB);
    renders.length = 0;
    expect((await file(userA, runId, '?format=docx')).statusCode).toBe(404);
    expect(renders).toHaveLength(0);
    expect((await file(admin, runId, '?format=docx')).statusCode).toBe(200);
  });

  it('ошибка Carbone при формировании → 502; запуск со status=error без формата и снимка; каталог удалён', async () => {
    failWith = new AppError('CARBONE_ERROR', 502, 'ошибка генерации: boom');
    const r = await render(userA);
    expect(r.statusCode).toBe(502);
    const [run] = await t.deps.db
      .select()
      .from(reportRuns)
      .where(and(eq(reportRuns.userId, userAId), eq(reportRuns.status, 'error')))
      .orderBy(desc(reportRuns.createdAt))
      .limit(1);
    expect(run).toMatchObject({
      status: 'error',
      error: 'ошибка генерации: boom',
      snapshot: false,
      outputFormat: null,
      filePath: null,
    });
    await expect.poll(() => t.deps.storage.exists(`reports/${run!.id}/data.json`)).toBe(false);
    expect(await t.deps.storage.exists(`reports/${run!.id}/template.docx`)).toBe(false);
    expect(await listed(userA, run!.id)).toMatchObject({ formats: [], readyFormats: [] });
  });
});

describe('срок сборки', () => {
  let s: TestApp;
  let sUser: string;
  let sTpl: string;
  let slowMs = 0;
  let slowRenders = 0;
  const slow: CarboneRenderer = {
    async render(_tpl, _data, opts) {
      if (opts.convertTo === 'pdf') return Buffer.from('%PDF');
      slowRenders++;
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      return Buffer.from(`собран ${opts.convertTo}`);
    },
  };

  beforeAll(async () => {
    s = await createTestApp({ carbone: slow }, { reportTimeoutMs: 600 });
    const sAdmin = (await loginAs(s, 'admin')).cookie;
    sUser = (await loginAs(s, 'user')).cookie;
    const ds = await s.app.inject({
      method: 'POST',
      url: '/api/datasources',
      headers: { cookie: sAdmin },
      payload: { name: 'src', ...src, sslMode: 'disable' },
    });
    sTpl = await createTemplate(s, sAdmin, ds.json().id, { public: true });
  });
  afterAll(() => s.close());
  beforeEach(() => {
    slowMs = 0;
    slowRenders = 0;
  });

  const newSlowRun = async () =>
    (
      await s.app.inject({
        method: 'POST',
        url: `/api/reports/${sTpl}/render`,
        headers: { cookie: sUser },
        payload: { params: {} },
      })
    ).json().runId as string;
  const getDocx = (runId: string) =>
    s.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/file?format=docx`,
      headers: { cookie: sUser },
    });

  it('ожидание чужой сборки ограничено сроком (lock_timeout) и не вызывает Carbone', async () => {
    const runId = await newSlowRun();
    // Чужая сборка — тот же ключ, что берёт API: (726100002, hashtext('<runId>:docx')).
    const holder = new pg.Client({ connectionString: s.deps.config.databaseUrl });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock($1::int, hashtext($2))', [
        RUN_FILE_LOCK_CLASS,
        `${runId}:docx`,
      ]);
      const r = await getDocx(runId);
      expect(r.statusCode).toBe(504);
      expect(r.json().error.message).toBe('превышено время формирования отчёта');
      expect(slowRenders).toBe(0);
    } finally {
      await holder.end(); // закрытие сессии снимает блокировку
    }
    const ok = await getDocx(runId);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('собран docx');
  });

  it('сборка, прерванная по сроку, снимает блокировку и не оставляет файла', async () => {
    const runId = await newSlowRun();
    slowMs = 1500;
    const r = await getDocx(runId);
    expect(r.statusCode).toBe(504);
    expect(slowRenders).toBe(1);
    expect(
      await s.deps.db.select().from(reportRunFiles).where(eq(reportRunFiles.runId, runId)),
    ).toHaveLength(1); // только pdf
    expect(await s.deps.storage.exists(`reports/${runId}/out.docx`)).toBe(false);
    slowMs = 0;
    const again = await getDocx(runId);
    expect(again.statusCode).toBe(200);
    expect(slowRenders).toBe(2);
  });
});

describe('пул сборки (createRunFileGate)', () => {
  it('нет свободного соединения до срока → 504; соединение потом возвращается в пул', async () => {
    const pool = new pg.Pool({ connectionString: t.deps.config.databaseUrl, max: 1 });
    pool.on('error', () => {});
    const gate = createRunFileGate(pool);
    try {
      const busy = await pool.connect();
      let ran = false;
      const err = await gate(RUN_FILE_LOCK_CLASS, 'gate-test', new Deadline(200), async () => {
        ran = true;
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'TIMEOUT', status: 504 });
      expect(ran).toBe(false);
      busy.release();
      await expect.poll(() => pool.idleCount).toBe(1);
      expect(
        await gate(RUN_FILE_LOCK_CLASS, 'gate-test', new Deadline(2000), async () => 'ok'),
      ).toBe('ok');
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('ошибка внутри — откат, блокировка снята', async () => {
    const pool = new pg.Pool({ connectionString: t.deps.config.databaseUrl, max: 2 });
    pool.on('error', () => {});
    const gate = createRunFileGate(pool);
    try {
      const boom = new AppError('CARBONE_ERROR', 502, 'boom');
      await expect(
        gate(RUN_FILE_LOCK_CLASS, 'gate-err', new Deadline(2000), async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
      // Блокировка свободна: короткий срок не истекает в ожидании.
      expect(
        await gate(RUN_FILE_LOCK_CLASS, 'gate-err', new Deadline(500), async () => 'free'),
      ).toBe('free');
    } finally {
      await pool.end();
    }
  });
});
