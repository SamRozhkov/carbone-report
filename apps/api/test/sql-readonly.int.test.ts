import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { templateParams, templateQueries } from '../src/db/schema';
import {
  createSourceDatabase,
  createTestApp,
  loginAs,
  openTemplate,
  type TestApp,
} from './helpers';
import { DEMO_PARAMS, DEMO_QUERIES } from '../../../demo/template';

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

const put = (id: string, what: 'queries' | 'params', payload: object, locale?: string) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/${what}`,
    headers: { cookie: admin, ...(locale ? { 'x-locale': locale } : {}) },
    payload,
  });

describe('сохранение (§47.2)', () => {
  it('запрос шаблона: 400 VALIDATION у поля sql, ru и en', async () => {
    const id = await createTpl(liveDs);
    const body = [
      { key: 'ok', sql: 'select 1', mode: 'list' },
      { key: 'bad', sql: 'update orders set total = 0', mode: 'list' },
    ];
    const ru = await put(id, 'queries', body);
    expect(ru.statusCode).toBe(400);
    expect(ru.json().error.code).toBe('VALIDATION');
    expect(ru.json().error.details).toEqual([
      {
        path: '/1/sql',
        message:
          'Разрешены только запросы на чтение (SELECT); найдено: UPDATE. Если это имя колонки, возьмите его в двойные кавычки',
      },
    ]);
    const en = await put(id, 'queries', body, 'en');
    expect(en.json().error.details[0].message).toBe(
      'Only read queries (SELECT) are allowed; found: UPDATE. If this is a column name, put it in double quotes',
    );
    const [stored] = await t.deps.db
      .select()
      .from(templateQueries)
      .where(eq(templateQueries.templateId, id));
    expect(stored).toBeUndefined();
  });

  it('запрос списка значений параметра: 400 VALIDATION у /0/sql', async () => {
    const id = await createTpl(liveDs);
    const r = await put(id, 'params', [
      {
        name: 'p',
        label: 'P',
        type: 'query',
        required: false,
        defaultValue: null,
        options: null,
        sql: 'select id as value from orders for share',
        multiple: false,
      },
    ]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toEqual([
      {
        path: '/0/sql',
        message:
          'Разрешены только запросы на чтение (SELECT); найдено: FOR SHARE. Если это имя колонки, возьмите его в двойные кавычки',
      },
    ]);
  });

  it('демо-шаблон «Счёт (демо)» сохраняется', async () => {
    const id = await createTpl(liveDs);
    expect((await put(id, 'queries', DEMO_QUERIES)).statusCode).toBe(200);
    expect((await put(id, 'params', DEMO_PARAMS)).statusCode).toBe(200);
  });
});

describe('выгрузка шаблона с запросом, сохранённым до 2.16.0', () => {
  it('400 с путём queries.0.sql, а не 500', async () => {
    const id = await createTpl(liveDs);
    await storeQuery(id, 'bad', 'delete from orders');
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/templates/export',
      headers: { cookie: admin },
      payload: { ids: [id] },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.message).toContain('queries.0.sql');
    expect(r.json().error.message).toContain('DELETE');
  });
});
