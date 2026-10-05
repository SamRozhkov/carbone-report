import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TemplateParam, TemplateSummary } from '@carbone-reports/shared';
import { eq, and } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  categories,
  categoryGroups,
  groups,
  reportRuns,
  templateGroups,
  templates,
  userGroups,
} from '../src/db/schema';
import type { CarboneRenderer } from '../src/deps';
import { accessibleTemplates } from '../src/modules/access/access';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  createTestDatabase,
  loginAs,
  type TestApp,
} from './helpers';

let t: TestApp;
let admin: string;
let alice: { cookie: string; id: string };
let bob: { cookie: string; id: string };
let dsId: string;
let salesId: string;
let catSalesId: string;
let catCommonId: string;
const tpl = {} as Record<'public' | 'cat' | 'direct' | 'closed' | 'catpub', string>;

const carbone: CarboneRenderer = {
  async render(_tpl, data) {
    return Buffer.from(JSON.stringify(data));
  },
};

const CITY_PARAM: TemplateParam = {
  name: 'city',
  label: 'Город',
  type: 'query',
  required: false,
  defaultValue: null,
  options: null,
  sql: 'select id as value, name as label from cities order by id',
  multiple: false,
};

const get = (url: string, cookie: string) =>
  t.app.inject({ method: 'GET', url, headers: { cookie } });

const listIds = async (cookie: string) => {
  const r = await get('/api/templates', cookie);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as TemplateSummary[]).map((s) => s.id).sort();
};

const render = (id: string, cookie: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/reports/${id}/render`,
    headers: { cookie },
    payload: { params: {}, format: 'pdf' },
  });

const runsOf = (templateId: string) =>
  t.deps.db.select().from(reportRuns).where(eq(reportRuns.templateId, templateId));

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = (await loginAs(t, 'admin')).cookie;
  const a = await loginAs(t, 'user');
  const b = await loginAs(t, 'user');
  alice = { cookie: a.cookie, id: a.user.id };
  bob = { cookie: b.cookie, id: b.user.id };

  const src = await createSourceDatabase(`
    create table cities(id int, name text);
    insert into cities values (1, 'Москва'), (2, 'Казань');
  `);
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: { name: 'src', ...src, sslMode: 'disable' },
  });
  dsId = ds.json().id;

  const db = t.deps.db;
  const [sales] = await db.insert(groups).values({ name: 'sales' }).returning();
  salesId = sales!.id;
  await db.insert(userGroups).values({ userId: alice.id, groupId: salesId });
  const [catSales] = await db
    .insert(categories)
    .values({ name: 'Продажи', sortOrder: 2, public: false })
    .returning();
  catSalesId = catSales!.id;
  await db.insert(categoryGroups).values({ categoryId: catSalesId, groupId: salesId });
  const [catCommon] = await db
    .insert(categories)
    .values({ name: 'Общая', sortOrder: 1, public: true })
    .returning();
  catCommonId = catCommon!.id;

  for (const k of ['public', 'cat', 'direct', 'closed', 'catpub'] as const) {
    tpl[k] = await createTemplate(t, admin, dsId, { params: [CITY_PARAM] });
  }
  await db.update(templates).set({ public: true }).where(eq(templates.id, tpl.public));
  await db.update(templates).set({ categoryId: catSalesId }).where(eq(templates.id, tpl.cat));
  await db.insert(templateGroups).values({ templateId: tpl.direct, groupId: salesId });
  await db.update(templates).set({ categoryId: catCommonId }).where(eq(templates.id, tpl.catpub));
});
afterAll(() => t.close());

describe('правило доступа', () => {
  it('подзапросы ссылаются на внешнюю таблицу templates полными именами', () => {
    const q = t.deps.db
      .select({ id: templates.id })
      .from(templates)
      .where(accessibleTemplates({ id: alice.id, login: 'alice', role: 'user' }))
      .toSQL();
    expect(q.sql).toContain('"categories"."id" = "templates"."category_id"');
    expect(q.sql).toContain('"categories"."public"');
    expect(q.sql).toContain('"category_groups"."category_id" = "templates"."category_id"');
    expect(q.sql).toContain('"template_groups"."template_id" = "templates"."id"');
    expect(q.sql.match(/exists \(select 1 from/g)).toHaveLength(3);
    expect(accessibleTemplates({ id: alice.id, login: 'x', role: 'admin' })).toBeUndefined();
  });

  it('список шаблонов зависит от групп и категорий', async () => {
    expect(await listIds(alice.cookie)).toEqual(
      [tpl.public, tpl.cat, tpl.direct, tpl.catpub].sort(),
    );
    expect(await listIds(bob.cookie)).toEqual([tpl.public, tpl.catpub].sort());
    expect(await listIds(admin)).toEqual(Object.values(tpl).sort());
  });

  it('список отдаёт категорию шаблона', async () => {
    const r = await get('/api/templates', admin);
    const byId = new Map((r.json() as TemplateSummary[]).map((s) => [s.id, s]));
    expect(byId.get(tpl.cat)!.category).toEqual({ id: catSalesId, name: 'Продажи', sortOrder: 2 });
    expect(byId.get(tpl.catpub)!.category).toEqual({
      id: catCommonId,
      name: 'Общая',
      sortOrder: 1,
    });
    expect(byId.get(tpl.public)!.category).toBeNull();
  });

  it('карточка отдаёт категорию', async () => {
    const r = await get(`/api/templates/${tpl.cat}`, alice.cookie);
    expect(r.statusCode).toBe(200);
    expect(r.json().category).toEqual({ id: catSalesId, name: 'Продажи', sortOrder: 2 });
    const a = await get(`/api/templates/${tpl.closed}`, admin);
    expect(a.statusCode).toBe(200);
    expect(a.json().category).toBeNull();
  });

  it('закрытая карточка неотличима от несуществующей', async () => {
    const closed = await get(`/api/templates/${tpl.closed}`, alice.cookie);
    const missing = await get('/api/templates/00000000-0000-4000-8000-000000000000', alice.cookie);
    expect(closed.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(closed.body).toBe(missing.body);
  });

  it('генерация недоступного шаблона — 404 без записи запуска', async () => {
    const r = await render(tpl.cat, bob.cookie);
    expect(r.statusCode).toBe(404);
    expect(await runsOf(tpl.cat)).toHaveLength(0);
    const ok = await render(tpl.cat, alice.cookie);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await runsOf(tpl.cat)).toHaveLength(1);
  });

  it('варианты параметра недоступного шаблона — 404', async () => {
    const url = `/api/templates/${tpl.cat}/params/city/options`;
    const r = await t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: bob.cookie },
      payload: { params: {} },
    });
    expect(r.statusCode).toBe(404);
    const ok = await t.app.inject({
      method: 'POST',
      url,
      headers: { cookie: alice.cookie },
      payload: { params: {} },
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('предпросмотр закрытого шаблона админу доступен', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tpl.closed}/preview`,
      headers: { cookie: admin },
      payload: { params: {}, mode: 'data' },
    });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('исключение из группы закрывает шаблоны, но не историю', async () => {
    const [run] = await runsOf(tpl.cat);
    await t.deps.db
      .delete(userGroups)
      .where(and(eq(userGroups.userId, alice.id), eq(userGroups.groupId, salesId)));
    expect(await listIds(alice.cookie)).toEqual([tpl.public, tpl.catpub].sort());
    const runs = await get('/api/runs', alice.cookie);
    expect(runs.json().items.map((x: { id: string }) => x.id)).toContain(run!.id);
    const file = await get(`/api/runs/${run!.id}/file`, alice.cookie);
    expect(file.statusCode).toBe(200);
    // Вернуть, чтобы порядок тестов не влиял на остальные.
    await t.deps.db.insert(userGroups).values({ userId: alice.id, groupId: salesId });
  });

  it('новый шаблон создаётся закрытым', async () => {
    const id = await createTemplate(t, admin, dsId);
    const [row] = await t.deps.db.select().from(templates).where(eq(templates.id, id));
    expect(row!.public).toBe(false);
    expect(row!.categoryId).toBeNull();
    expect(await listIds(bob.cookie)).not.toContain(id);
  });

  it('копия наследует категорию, public и группы', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tpl.direct}/duplicate`,
      headers: { cookie: admin },
    });
    expect(r.statusCode, r.body).toBe(201);
    const copyId = r.json().id as string;
    const gs = await t.deps.db
      .select()
      .from(templateGroups)
      .where(eq(templateGroups.templateId, copyId));
    expect(gs.map((g) => g.groupId)).toEqual([salesId]);

    const r2 = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tpl.catpub}/duplicate`,
      headers: { cookie: admin },
    });
    expect(r2.json().category?.id).toBe(catCommonId);
    await t.deps.db.update(templates).set({ public: true }).where(eq(templates.id, tpl.closed));
    const r3 = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tpl.closed}/duplicate`,
      headers: { cookie: admin },
    });
    const [copy3] = await t.deps.db
      .select()
      .from(templates)
      .where(eq(templates.id, r3.json().id as string));
    expect(copy3!.public).toBe(true);
    await t.deps.db.update(templates).set({ public: false }).where(eq(templates.id, tpl.closed));
  });
});

it('миграция 0004 оставляет существующие шаблоны открытыми', async () => {
  const client = new pg.Client({ connectionString: await createTestDatabase() });
  await client.connect();
  try {
    const dir = join(import.meta.dirname, '../drizzle');
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const apply = async (file: string) => {
      const sqlText = await readFile(join(dir, file), 'utf8');
      for (const stmt of sqlText.split('--> statement-breakpoint')) {
        if (stmt.trim()) await client.query(stmt);
      }
    };
    for (const f of files.filter((f) => f < '0004')) await apply(f);
    const {
      rows: [ds],
    } = await client.query(
      `insert into datasources (name, host, port, database, username, password_enc)
       values ('s', 'h', 5432, 'd', 'u', 'x') returning id`,
    );
    await client.query(
      `insert into templates (name, datasource_id, file_ext, file_path, doc_key)
       values ('old', $1, 'docx', 'templates/x/v1.docx', 'k')`,
      [ds.id],
    );
    await apply(files.find((f) => f.startsWith('0004_'))!);
    const { rows } = await client.query(`select public, category_id from templates`);
    expect(rows).toEqual([{ public: true, category_id: null }]);
    await client.query(
      `insert into templates (name, datasource_id, file_ext, file_path, doc_key)
       values ('new', $1, 'docx', 'templates/y/v1.docx', 'k2')`,
      [ds.id],
    );
    const { rows: fresh } = await client.query(`select public from templates where name = 'new'`);
    expect(fresh).toEqual([{ public: false }]);
  } finally {
    await client.end();
  }
});
