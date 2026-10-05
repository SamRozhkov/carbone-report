import { RUNS_PAGE_SIZE } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportRuns } from '../src/db/schema';
import { AppError } from '../src/lib/errors';
import type { CarboneRenderer } from '../src/deps';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  type TestApp,
} from './helpers';

let t: TestApp;
let admin: string;
let userA: string;
let userB: string;
let dsId: string;
let tplId: string;
let carboneFails = false;

// Поддельный Carbone возвращает JSON того, что ему передали.
const carbone: CarboneRenderer = {
  async render(tpl, data, opts) {
    if (carboneFails) throw new AppError('CARBONE_ERROR', 502, 'ошибка генерации: boom');
    return Buffer.from(
      JSON.stringify({ version: tpl.version, data, convertTo: opts.convertTo, tz: opts.timezone }),
    );
  },
};

const render = (cookie: string, id: string, payload: object) =>
  t.app.inject({ method: 'POST', url: `/api/reports/${id}/render`, headers: { cookie }, payload });

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = (await loginAs(t, 'admin')).cookie;
  userA = (await loginAs(t, 'user')).cookie;
  userB = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase(`
    create table orders(id int, total numeric, created date);
    insert into orders values (1, 100, '2026-01-10'), (2, 250.5, '2026-02-10');
    create table company(name text); insert into company values ('ООО Ромашка');
  `);
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: { name: 'src', ...src, sslMode: 'disable' },
  });
  dsId = ds.json().id;
  tplId = await createTemplate(t, admin, dsId, {
    queries: [
      {
        key: 'orders',
        mode: 'list',
        sql: 'select id, total from orders where created >= :from order by id',
      },
      { key: 'company', mode: 'single', sql: 'select name from company' },
    ],
    params: [
      {
        name: 'from',
        label: 'С даты',
        type: 'date',
        required: true,
        defaultValue: null,
        options: null,
        sql: null,
        multiple: false,
      },
    ],
  });
});
afterAll(() => t.close());

describe('генерация', () => {
  it('user генерирует отчёт; данные собраны из SQL и параметров; файл скачивается', async () => {
    const r = await render(userA, tplId, { params: { from: '2026-02-01' }, format: 'pdf' });
    expect(r.statusCode).toBe(201);
    const file = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${r.json().runId}/file`,
      headers: { cookie: userA },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(JSON.parse(file.body)).toEqual({
      version: 1,
      data: {
        orders: [{ id: 2, total: 250.5 }],
        company: { name: 'ООО Ромашка' },
        params: { from: '2026-02-01' },
      },
      convertTo: 'pdf',
      tz: 'Europe/Moscow',
    });
  });

  it('inline=1 отдаёт inline для предпросмотра PDF', async () => {
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    const file = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${r.json().runId}/file?inline=1`,
      headers: { cookie: userA },
    });
    expect(file.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('неверные параметры → 400 с полями и без записи в историю', async () => {
    const before = await t.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie: admin },
    });
    const r = await render(userA, tplId, { params: {}, format: 'pdf' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fields).toEqual({ from: 'обязательный параметр' });
    const after = await t.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie: admin },
    });
    expect(after.json().total).toBe(before.json().total);
  });

  it('формат, недоступный для шаблона → 400', async () => {
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'xlsx' });
    expect(r.statusCode).toBe(400);
  });

  it('ошибка Carbone → 502 и запись со status=error', async () => {
    carboneFails = true;
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    carboneFails = false;
    expect(r.statusCode).toBe(502);
    const runs = await t.app.inject({
      method: 'GET',
      url: '/api/runs?status=error',
      headers: { cookie: userA },
    });
    expect(runs.json().items[0]).toMatchObject({
      status: 'error',
      error: 'ошибка генерации: boom',
      fileAvailable: false,
    });
  });

  it('ошибка SQL → 400 и запись со status=error', async () => {
    const bad = await createTemplate(t, admin, dsId, {
      queries: [{ key: 'x', mode: 'list', sql: 'select nope from orders' }],
    });
    const r = await render(userA, bad, { params: {}, format: 'pdf' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/^запрос "x": /);
    const runs = await t.app.inject({
      method: 'GET',
      url: '/api/runs?status=error',
      headers: { cookie: userA },
    });
    const row = runs
      .json()
      .items.find((x: { error: string }) => x.error.startsWith('запрос "x": '));
    expect(row).toBeDefined();
    expect(row.error).not.toMatch(/\n/);
  });

  it('шаблон без запросов генерируется только с params', async () => {
    const empty = await createTemplate(t, admin, dsId);
    const r = await render(userA, empty, { params: {}, format: 'pdf' });
    const file = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${r.json().runId}/file`,
      headers: { cookie: userA },
    });
    expect(JSON.parse(file.body).data).toEqual({ params: {} });
  });
});

describe('история', () => {
  it('пагинация: страница по RUNS_PAGE_SIZE, total, вторая страница, порядок от новых к старым', async () => {
    const u = await loginAs(t, 'user');
    for (let i = 0; i < RUNS_PAGE_SIZE + 3; i++) {
      const r = await render(u.cookie, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
      expect(r.statusCode).toBe(201);
    }
    const p1 = (
      await t.app.inject({ method: 'GET', url: '/api/runs?page=1', headers: { cookie: u.cookie } })
    ).json();
    const p2 = (
      await t.app.inject({ method: 'GET', url: '/api/runs?page=2', headers: { cookie: u.cookie } })
    ).json();
    expect(p1.total).toBe(RUNS_PAGE_SIZE + 3);
    expect(p1.items).toHaveLength(RUNS_PAGE_SIZE);
    expect(p2.items).toHaveLength(3);
    const ids = [...p1.items, ...p2.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    const times = [...p1.items, ...p2.items].map((x: { createdAt: string }) =>
      Date.parse(x.createdAt),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('page=0 и нечисловая страница → 400', async () => {
    const u = await loginAs(t, 'user');
    for (const q of ['page=0', 'page=abc']) {
      const r = await t.app.inject({
        method: 'GET',
        url: `/api/runs?${q}`,
        headers: { cookie: u.cookie },
      });
      expect(r.statusCode).toBe(400);
    }
  });

  it('файл отчёта удалён с диска → 410', async () => {
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    const runId = r.json().runId;
    const [run] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, runId));
    await t.deps.storage.remove(run!.filePath!);
    const file = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/file`,
      headers: { cookie: userA },
    });
    expect(file.statusCode).toBe(410);
  });

  it('user видит только свои запуски и не может скачать чужой файл', async () => {
    const r = await render(userB, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    const runId = r.json().runId;
    const listA = await t.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie: userA },
    });
    expect(listA.json().items.some((x: { id: string }) => x.id === runId)).toBe(false);
    const steal = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/file`,
      headers: { cookie: userA },
    });
    expect(steal.statusCode).toBe(404);
    const asAdmin = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${runId}/file`,
      headers: { cookie: admin },
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  it('user не может подсмотреть чужие запуски через ?userId', async () => {
    const rb = await render(userB, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    const ra = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    const listB = await t.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie: userB },
    });
    const otherUserId = listB.json().items[0].userId;
    const listA = await t.app.inject({
      method: 'GET',
      url: `/api/runs?userId=${otherUserId}`,
      headers: { cookie: userA },
    });
    const ids = listA.json().items.map((x: { id: string }) => x.id);
    expect(ids).toContain(ra.json().runId);
    expect(ids).not.toContain(rb.json().runId);
    expect(listA.json().items.every((x: { userId: string }) => x.userId !== otherUserId)).toBe(
      true,
    );
  });

  it('admin фильтрует по пользователю; в записи есть логин и название шаблона', async () => {
    const listB = await t.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie: userB },
    });
    const uid = listB.json().items[0].userId;
    const r = await t.app.inject({
      method: 'GET',
      url: `/api/runs?userId=${uid}`,
      headers: { cookie: admin },
    });
    expect(r.json().items.every((x: { userId: string }) => x.userId === uid)).toBe(true);
    expect(r.json().items[0]).toMatchObject({
      userLogin: expect.stringMatching(/^user_/),
      templateName: expect.any(String),
    });
  });

  it('после удаления шаблона история остаётся читаемой', async () => {
    const tmp = await createTemplate(t, admin, dsId);
    const r = await render(userA, tmp, { params: {}, format: 'pdf' });
    const runId = r.json().runId;
    await t.app.inject({
      method: 'DELETE',
      url: `/api/templates/${tmp}`,
      headers: { cookie: admin },
    });
    const runs = await t.app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { cookie: userA },
    });
    const run = runs.json().items.find((x: { id: string }) => x.id === runId);
    expect(run).toMatchObject({
      templateId: null,
      templateName: expect.stringMatching(/^Шаблон /),
    });
  });
});

describe('недоступный источник', () => {
  it('502 без details и без сырого текста ошибки сети', async () => {
    const ds = await t.app.inject({
      method: 'POST',
      url: '/api/datasources',
      headers: { cookie: admin },
      payload: {
        name: 'dead',
        host: '127.0.0.1',
        port: 1,
        database: 'x',
        username: 'x',
        password: 'x',
        sslMode: 'disable',
      },
    });
    const dead = await createTemplate(t, admin, ds.json().id, {
      queries: [{ key: 'q', mode: 'list', sql: 'select 1 as a' }],
    });
    const r = await render(userA, dead, { params: {}, format: 'pdf' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.details).toBeUndefined();
    expect(r.body).not.toMatch(/ECONNREFUSED/);
  });
});

describe('инструменты админа', () => {
  it('queries/run выполняет произвольный SQL с параметрами и обрезает до 50 строк', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tplId}/queries/run`,
      headers: { cookie: admin },
      payload: { sql: 'select g from generate_series(1, :n) g', params: { n: 60 } },
    });
    expect(r.json()).toMatchObject({ columns: ['g'], truncated: true });
    expect(r.json().rows).toHaveLength(50);
  });

  it('queries/run и preview недоступны user', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tplId}/queries/run`,
      headers: { cookie: userA },
      payload: { sql: 'select 1', params: {} },
    });
    expect(r.statusCode).toBe(403);
  });

  it('preview mode=data возвращает собранный JSON и не пишет историю', async () => {
    const before = (
      await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: admin } })
    ).json().total;
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tplId}/preview`,
      headers: { cookie: admin },
      payload: { params: { from: '2026-01-01' }, mode: 'data' },
    });
    expect(r.json()).toMatchObject({
      orders: [{ id: 1 }, { id: 2 }],
      company: { name: 'ООО Ромашка' },
    });
    const after = (
      await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: admin } })
    ).json().total;
    expect(after).toBe(before);
  });

  it('preview mode=pdf отдаёт application/pdf inline', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tplId}/preview`,
      headers: { cookie: admin },
      payload: { params: { from: '2026-01-01' }, mode: 'pdf' },
    });
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toMatch(/^inline;/);
  });
});
