import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateParams, templateQueries } from '../src/db/schema';
import {
  createSourceDatabase,
  createTestApp,
  loginAs,
  openTemplate,
  type TestApp,
} from './helpers';

let t: TestApp;
let admin: string;
let liveDs: string;
let deadDs: string;

async function createDs(payload: object): Promise<string> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

async function createTpl(datasourceId: string): Promise<string> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/templates',
    headers: { cookie: admin },
    payload: { name: `ro ${Math.random().toString(16).slice(2, 8)}`, datasourceId, blank: 'docx' },
  });
  expect(r.statusCode).toBe(201);
  const id = r.json().id as string;
  await openTemplate(t, id);
  return id;
}

/** Запрос, записанный в БД в обход проверки (как сохранённый до 2.16.0). */
async function storeQuery(templateId: string, key: string, sql: string) {
  await t.deps.db
    .insert(templateQueries)
    .values({ templateId, key, sql, mode: 'list', sortOrder: 0 });
}

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  const src = await createSourceDatabase('create table orders(id int, total numeric);');
  liveDs = await createDs({ name: 'live', ...src, sslMode: 'disable' });
  // Порт 1 закрыт: попытка соединения дала бы 502 DATASOURCE_UNAVAILABLE.
  deadDs = await createDs({
    name: 'dead',
    host: '127.0.0.1',
    port: 1,
    database: 'x',
    username: 'x',
    password: 'x',
    sslMode: 'disable',
  });
});
afterAll(() => t.close());

describe('выполнение запроса, сохранённого до 2.16.0 (§47.2)', () => {
  it('формирование: 400 SQL_ERROR без подключения к источнику', async () => {
    const id = await createTpl(deadDs);
    await storeQuery(id, 'bad', 'delete from orders');
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/reports/${id}/render`,
      headers: { cookie: admin },
      payload: { params: {} },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toMatchObject({
      code: 'SQL_ERROR',
      message: 'запрос "bad": разрешены только запросы на чтение (SELECT); найдено: DELETE',
    });
  });

  it('контроль: допустимый запрос к тому же источнику — 502 (соединение пробовалось)', async () => {
    const id = await createTpl(deadDs);
    await storeQuery(id, 'ok', 'select 1');
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/reports/${id}/render`,
      headers: { cookie: admin },
      payload: { params: {} },
    });
    expect([r.statusCode, r.json().error.code]).toEqual([502, 'DATASOURCE_UNAVAILABLE']);
  });

  it('предпросмотр данных и «Выполнить» в редакторе: 400 SQL_ERROR, текст на en', async () => {
    const id = await createTpl(deadDs);
    await storeQuery(id, 'bad', 'select * from orders for update');
    const preview = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/preview`,
      headers: { cookie: admin, 'x-locale': 'en' },
      payload: { params: {}, mode: 'data' },
    });
    expect(preview.statusCode, preview.body).toBe(400);
    expect(preview.json().error.code).toBe('SQL_ERROR');
    expect(preview.json().error.message).toContain(
      'only read queries (SELECT) are allowed; found: FOR UPDATE',
    );
    const run = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/queries/run`,
      headers: { cookie: admin },
      payload: { sql: 'drop table orders', params: {} },
    });
    expect([run.statusCode, run.json().error.code]).toEqual([400, 'SQL_ERROR']);
    expect(run.json().error.message).toContain('найдено: DROP');
  });

  it('варианты параметра: 400 SQL_ERROR', async () => {
    const id = await createTpl(deadDs);
    await t.deps.db.insert(templateParams).values({
      templateId: id,
      name: 'p',
      label: 'Счёт',
      type: 'query',
      required: false,
      defaultValue: null,
      options: null,
      sql: 'select pg_sleep(1) as value',
      multiple: false,
      sortOrder: 0,
    });
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/params/p/options`,
      headers: { cookie: admin },
      payload: { params: {} },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toMatchObject({
      code: 'SQL_ERROR',
      message: 'параметр "Счёт": разрешены только запросы на чтение (SELECT); найдено: pg_sleep',
    });
  });

  it('допустимый запрос к живому источнику выполняется', async () => {
    const id = await createTpl(liveDs);
    await storeQuery(id, 'ok', 'select count(*)::int as n from orders');
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/preview`,
      headers: { cookie: admin },
      payload: { params: {}, mode: 'data' },
    });
    expect(r.statusCode, r.body).toBe(200);
  });
});
