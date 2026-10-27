import { randomUUID } from 'node:crypto';
import pg from 'pg';
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
    create table invoices (id int primary key, company_id int references company(id), total numeric(12,2));
    create view v_totals as select company_id, sum(total) as total from invoices group by company_id;
    create schema hidden;
    create table hidden.salaries (id int, amount int);
    insert into company values (1, 'ООО Ромашка');
    create role ${role} login password 'pw';
    grant usage on schema public to ${role};
    grant select on company, invoices, v_totals to ${role};
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
  it('список: доступные отношения, виды, комментарии; без системных и недоступных', async () => {
    const r = await get(`/api/templates/${tpl}/schema/tables`, editor);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      total: 3,
      tables: [
        { schema: 'public', name: 'company', kind: 'table', comment: 'Покупатели' },
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
    ]);
    expect(inv.primaryKey).toEqual(['id']);
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
});
