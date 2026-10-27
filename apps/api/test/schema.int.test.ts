import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { checkQuery } from '../src/modules/queries/executor';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  type SourceConn,
  type TestApp,
} from './helpers';

let t: TestApp;
let editor: string;
let plainUser: string;
let tpl: string;
let admin: SourceConn;
// Роли общие для кластера и переживают тесты: имя уникально, в afterAll роль удаляется.
const role = `ds_limited_${randomUUID().slice(0, 8)}`;

const get = (url: string, cookie: string) =>
  t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const post = (url: string, payload: object, cookie: string) =>
  t.app.inject({ method: 'POST', url, headers: { cookie }, payload });

beforeAll(async () => {
  t = await createTestApp();
  editor = (await loginAs(t, 'admin')).cookie;
  plainUser = (await loginAs(t, 'user')).cookie;
  admin = await createSourceDatabase(`
    create table company (id int primary key, name text not null);
    comment on table company is 'Покупатели';
    comment on column company.name is 'Название';
    create schema hidden;
    create table hidden.regions (id int primary key);
    create table invoices (id int primary key, company_id int references company(id), total numeric(12,2),
                           region_id int references hidden.regions(id));
    create table events (id int, d date) partition by range (d);
    create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');
    create view v_totals as select company_id, sum(total) as total from invoices group by company_id;
    create table hidden.salaries (id int, amount int);
    insert into company values (1, 'ООО Ромашка');
    create role ${role} login password 'pw';
    grant usage on schema public to ${role};
    grant select on company, invoices, v_totals, events, events_2026 to ${role};
  `);
  const ds = await post(
    '/api/datasources',
    { name: 'limited', ...admin, username: role, password: 'pw', sslMode: 'disable' },
    editor,
  );
  expect(ds.statusCode, ds.body).toBe(201);
  tpl = await createTemplate(t, editor, ds.json().id as string, { public: true });
});

afterAll(async () => {
  await t.close();
  const c = new pg.Client({ ...admin, user: admin.username });
  try {
    await c.connect();
    await c.query(`drop owned by ${role}`);
    await c.query(`drop role ${role}`);
  } catch {
    // роль не создалась или уже удалена
  } finally {
    await c.end().catch(() => {});
  }
});

describe('схема источника и проверка SQL', () => {
  it('список: доступные отношения, виды, комментарии; без системных, недоступных и секций', async () => {
    const r = await get(`/api/templates/${tpl}/schema/tables`, editor);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      total: 4,
      tables: [
        { schema: 'public', name: 'company', kind: 'table', comment: 'Покупатели' },
        // Секция events_2026 не показывается — только секционированная таблица.
        { schema: 'public', name: 'events', kind: 'table', comment: null },
        { schema: 'public', name: 'invoices', kind: 'table', comment: null },
        { schema: 'public', name: 'v_totals', kind: 'view', comment: null },
      ],
    });
    expect(
      (await get(`/api/templates/${tpl}/schema/tables?search=ПОКУП`, editor))
        .json()
        .tables.map((x: { name: string }) => x.name),
    ).toEqual(['company']);
    // «_» — буква, а не шаблон LIKE: только v_totals
    expect((await get(`/api/templates/${tpl}/schema/tables?search=_`, editor)).json().total).toBe(
      1,
    );
  });

  it('описание: колонки, первичный и внешние ключи; недоступная таблица — 404', async () => {
    const inv = (await get(`/api/templates/${tpl}/schema/tables/invoices`, editor)).json();
    expect(inv.columns).toEqual([
      { name: 'id', type: 'integer', notNull: true, comment: null },
      { name: 'company_id', type: 'integer', notNull: false, comment: null },
      { name: 'total', type: 'numeric(12,2)', notNull: false, comment: null },
      { name: 'region_id', type: 'integer', notNull: false, comment: null },
    ]);
    expect(inv.primaryKey).toEqual(['id']);
    // Ключ на недоступную hidden.regions не раскрывается.
    expect(inv.foreignKeys).toEqual([
      {
        columns: ['company_id'],
        references: { schema: 'public', table: 'company', columns: ['id'] },
      },
    ]);
    expect(
      (await get(`/api/templates/${tpl}/schema/tables/public.company`, editor)).json().columns[1],
    ).toEqual({ name: 'name', type: 'text', notNull: true, comment: 'Название' });
    expect(
      (await get(`/api/templates/${tpl}/schema/tables/hidden.salaries`, editor)).statusCode,
    ).toBe(404);
    expect((await get(`/api/templates/${tpl}/schema/tables/salaries`, editor)).statusCode).toBe(
      404,
    );
  });

  it('проверка SQL: колонки и типы без строк; ; в конце, комментарий, :параметр', async () => {
    const ok = await post(
      `/api/templates/${tpl}/queries/check`,
      { sql: 'select id, name from company where id = :companyId; -- последняя строка' },
      editor,
    );
    expect(ok.json()).toEqual({
      ok: true,
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'name', type: 'text' },
      ],
    });
    expect(ok.body).not.toContain('Ромашка');
    const bad = (
      await post(`/api/templates/${tpl}/queries/check`, { sql: 'select nope from company' }, editor)
    ).json();
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('nope');
    // Черновик — не запрос шаблона: без ключа «check» в тексте.
    expect(bad.error).not.toContain('check');
    const write = (
      await post(`/api/templates/${tpl}/queries/check`, { sql: 'delete from company' }, editor)
    ).json();
    expect(write.ok).toBe(false);
  });

  it('права: пользователь без права правки — 403; без входа — 401', async () => {
    expect((await get(`/api/templates/${tpl}/schema/tables`, plainUser)).statusCode).toBe(403);
    expect(
      (await post(`/api/templates/${tpl}/queries/check`, { sql: 'select 1' }, plainUser))
        .statusCode,
    ).toBe(403);
    expect((await get(`/api/templates/${tpl}/schema/tables`, '')).statusCode).toBe(401);
  });

  it('проверка SQL без параметров идёт расширенным протоколом', async () => {
    const real = await t.deps.sources.get(
      (await t.deps.db.query.templates.findFirst({ where: (x, { eq }) => eq(x.id, tpl) }))!
        .datasourceId,
    );
    const modes: unknown[] = [];
    const pool = {
      connect: async () => {
        const client = await real.pool.connect();
        const q = client.query.bind(client) as (...a: unknown[]) => unknown;
        (client as unknown as { query: unknown }).query = (...a: unknown[]) => {
          const c = a[0] as { text?: string; queryMode?: string };
          if (c?.text?.includes('limit 0')) modes.push(c.queryMode);
          return q(...a);
        };
        return client;
      },
    } as unknown as Parameters<typeof checkQuery>[0];
    const r = await checkQuery(pool, 'x', 'select id from company', 5000, 'ru');
    expect(r).toEqual({ ok: true, columns: [{ name: 'id', type: 'integer' }] });
    expect(modes).toEqual(['extended']);
  });
});
