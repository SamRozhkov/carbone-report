import type { TemplateDetails, TemplateParam } from '@carbone-reports/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CarboneRenderer } from '../src/deps';
import { createSourceDatabase, createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let user: string;
let tplId: string;
let badTplId: string;

// Поддельный Carbone возвращает JSON переданных данных.
const carbone: CarboneRenderer = {
  async render(_tpl, data) {
    return Buffer.from(JSON.stringify(data));
  },
};

const CITIES_SQL =
  'select id as value, name as label from cities where region_id = :region order by id';

const param = (over: Partial<TemplateParam> & Pick<TemplateParam, 'name'>): TemplateParam => ({
  label: over.name,
  type: 'query',
  required: false,
  defaultValue: null,
  options: null,
  sql: null,
  multiple: false,
  ...over,
});

async function createTpl(
  dsId: string,
  queries: object[],
  params: TemplateParam[],
): Promise<string> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/templates',
    headers: { cookie: admin },
    payload: {
      name: `Шаблон ${Math.random().toString(16).slice(2, 6)}`,
      datasourceId: dsId,
      blank: 'docx',
    },
  });
  expect(r.statusCode).toBe(201);
  const id = r.json().id as string;
  const q = await t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/queries`,
    headers: { cookie: admin },
    payload: queries,
  });
  expect(q.statusCode).toBe(200);
  const p = await t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/params`,
    headers: { cookie: admin },
    payload: params,
  });
  expect(p.statusCode, p.body).toBe(200);
  return id;
}

const options = (id: string, name: string, params: object, cookie = user) =>
  t.app.inject({
    method: 'POST',
    url: `/api/templates/${id}/params/${name}/options`,
    headers: { cookie },
    payload: { params },
  });

const render = (id: string, params: object) =>
  t.app.inject({
    method: 'POST',
    url: `/api/reports/${id}/render`,
    headers: { cookie: user },
    payload: { params, format: 'pdf' },
  });

async function runsTotal(): Promise<number> {
  const r = await t.app.inject({ method: 'GET', url: '/api/runs', headers: { cookie: admin } });
  return r.json().total as number;
}

async function renderedData(runId: string): Promise<Record<string, unknown>> {
  const f = await t.app.inject({
    method: 'GET',
    url: `/api/runs/${runId}/file`,
    headers: { cookie: user },
  });
  return JSON.parse(f.body) as Record<string, unknown>;
}

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase(`
    create table regions(id int primary key, name text);
    create table cities(id int primary key, region_id int, name text);
    insert into regions values (1, 'Север'), (2, 'Юг');
    insert into cities values (10, 1, 'Архангельск'), (11, 1, 'Мурманск'), (20, 2, 'Сочи');
  `);
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: { name: 'geo', ...src, sslMode: 'disable' },
  });
  const dsId = ds.json().id as string;
  tplId = await createTpl(
    dsId,
    [
      {
        key: 'stat',
        mode: 'single',
        sql: 'select count(*)::int as n from cities where id = any(:cities)',
      },
    ],
    [
      param({
        name: 'region',
        label: 'Регион',
        required: true,
        sql: 'select id as value, name as label from regions order by id',
      }),
      param({ name: 'city', label: 'Город', sql: CITIES_SQL }),
      param({ name: 'cities', label: 'Города', sql: CITIES_SQL, multiple: true }),
      param({
        name: 'pick',
        label: 'Выбор',
        sql: 'select id as value, name as label from cities where id = :city',
      }),
    ],
  );
  badTplId = await createTpl(
    dsId,
    [],
    [
      param({ name: 'bad', label: 'Плохой', sql: 'selec id from regions' }),
      param({ name: 'many', label: 'Много', sql: 'select g from generate_series(1, 1001) g' }),
      param({ name: 'note', label: 'Заметка', type: 'string' }),
    ],
  );
});
afterAll(() => t.close());

describe('варианты параметров', () => {
  it('корневой параметр, ожидание родителя, зависимый с родителем', async () => {
    const r = await options(tplId, 'region', {});
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      options: [
        { value: 1, label: 'Север' },
        { value: 2, label: 'Юг' },
      ],
    });

    const w = await options(tplId, 'city', {});
    expect(w.json()).toEqual({ options: [], waitingFor: ['region'] });

    const c = await options(tplId, 'city', { region: 1 });
    expect(c.json()).toEqual({
      options: [
        { value: 10, label: 'Архангельск' },
        { value: 11, label: 'Мурманск' },
      ],
    });
  });

  it('недопустимое значение предка → ожидание прямого родителя, варианты ребёнка не выдаются', async () => {
    expect((await options(tplId, 'city', { region: 999 })).json()).toEqual({
      options: [],
      waitingFor: ['region'],
    });
    // Транзитивно: регион недопустим → город тоже, ждём прямого родителя city.
    expect((await options(tplId, 'pick', { region: 999, city: 10 })).json()).toEqual({
      options: [],
      waitingFor: ['city'],
    });
    // Город не из выбранного региона; city необязательный, но недопустимое значение — тоже ожидание.
    expect((await options(tplId, 'pick', { region: 2, city: 10 })).json()).toEqual({
      options: [],
      waitingFor: ['city'],
    });
    expect((await options(tplId, 'pick', { region: 1, city: 10 })).json()).toEqual({
      options: [{ value: 10, label: 'Архангельск' }],
    });
  });

  it('синтаксическая ошибка в SQL параметра → 400 с текстом ошибки SQL; генерация — тот же код', async () => {
    const r = await options(badTplId, 'bad', {});
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('SQL_ERROR');
    expect(r.json().error.message).toMatch(/syntax error/);
    const g = await render(badTplId, { bad: 1 });
    expect(g.statusCode).toBe(400);
    expect(g.json().error.code).toBe('SQL_ERROR');
  });

  it('больше 1000 вариантов → 400 TOO_MANY_OPTIONS', async () => {
    const r = await options(badTplId, 'many', {});
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('TOO_MANY_OPTIONS');
  });

  it('несуществующий параметр и параметр не-query → 404', async () => {
    expect((await options(badTplId, 'nope', {})).statusCode).toBe(404);
    expect((await options(badTplId, 'note', {})).statusCode).toBe(404);
  });
});

describe('строгая проверка при генерации', () => {
  it('допустимые значения → 201', async () => {
    const r = await render(tplId, { region: 1, city: 10 });
    expect(r.statusCode).toBe(201);
  });

  it('город не из выбранного региона → 400 у поля, запуск не записан', async () => {
    const before = await runsTotal();
    const r = await render(tplId, { region: 2, city: 10 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION');
    expect(r.json().error.details.fields).toEqual({ city: 'значение недоступно' });
    expect(await runsTotal()).toBe(before);
  });

  it('множественный: все значения допустимы → 201 и n = 2; одно чужое → 400', async () => {
    const r = await render(tplId, { region: 1, cities: [10, 11] });
    expect(r.statusCode).toBe(201);
    expect((await renderedData(r.json().runId)).stat).toEqual({ n: 2 });

    const before = await runsTotal();
    const bad = await render(tplId, { region: 1, cities: [10, 20] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.fields).toEqual({ cities: 'значение недоступно' });
    expect(await runsTotal()).toBe(before);
  });

  it('необязательный множественный не задан → 201, any(null) даёт n = 0', async () => {
    const r = await render(tplId, { region: 1 });
    expect(r.statusCode).toBe(201);
    expect((await renderedData(r.json().runId)).stat).toEqual({ n: 0 });
  });

  it('предпросмотр проходит ту же проверку', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tplId}/preview`,
      headers: { cookie: admin },
      payload: { params: { region: 2, city: 10 }, mode: 'data' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fields).toEqual({ city: 'значение недоступно' });
  });
});

describe('карточка шаблона', () => {
  it('пользователю sql скрыт, админу виден; dependsOn у обоих', async () => {
    const u = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${tplId}`,
      headers: { cookie: user },
    });
    const a = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${tplId}`,
      headers: { cookie: admin },
    });
    const byName = (body: TemplateDetails, name: string) =>
      body.params.find((p) => p.name === name)!;
    for (const name of ['region', 'city', 'cities']) expect(byName(u.json(), name).sql).toBeNull();
    expect(byName(a.json(), 'city').sql).toBe(CITIES_SQL);
    expect(byName(u.json(), 'city').dependsOn).toEqual(['region']);
    expect(byName(a.json(), 'city').dependsOn).toEqual(['region']);
    expect(byName(a.json(), 'region').dependsOn).toEqual([]);
  });
});
