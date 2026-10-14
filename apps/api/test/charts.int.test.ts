import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateCharts } from '../src/db/schema';
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
let user: string;
let dsId: string;
let tplId: string;

// Поддельный Carbone возвращает JSON переданных данных.
const carbone: CarboneRenderer = {
  async render(_tpl, data) {
    return Buffer.from(JSON.stringify({ data }));
  },
};

const SALES = {
  key: 'sales',
  query: 'orders',
  type: 'bar',
  category: 'month',
  series: [{ column: 'total', name: 'Сумма' }],
};
const putCharts = (id: string, body: object, cookie = admin) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/charts`,
    headers: { cookie },
    payload: body,
  });
const putQueries = (id: string, body: object) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/queries`,
    headers: { cookie: admin },
    payload: body,
  });
const previewData = (id: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/templates/${id}/preview`,
    headers: { cookie: admin },
    payload: { params: {}, mode: 'data' },
  });
const QUERIES = [
  { key: 'orders', mode: 'list', sql: 'select month, total, region from orders order by id' },
  { key: 'one', mode: 'single', sql: 'select 1 as x' },
];

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase(`
    create table orders(id int, month text, total numeric, region text);
    insert into orders values (1, 'Янв', 100, 'Север'), (2, 'Фев', 12345678901234567890.5, 'Юг'), (3, 'Мар', null, 'Север');
  `);
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: { name: 'src', ...src, sslMode: 'disable' },
  });
  dsId = ds.json().id;
  tplId = await createTemplate(t, admin, dsId, { public: true, queries: QUERIES as never });
});
afterAll(() => t.close());

describe('графики шаблона (§35.3)', () => {
  it('PUT charts: сохраняет с умолчаниями и порядком; GET отдаёт; пользователю — 403', async () => {
    const r = await putCharts(tplId, [SALES, { ...SALES, key: 'byRegion', splitBy: 'region' }]);
    expect(r.statusCode).toBe(200);
    expect(r.json().charts).toEqual([
      expect.objectContaining({
        key: 'sales',
        legend: 'bottom',
        splitBy: null,
        number: { decimals: null, thousands: false, suffix: '' },
      }),
      expect.objectContaining({ key: 'byRegion', splitBy: 'region' }),
    ]);
    const g = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${tplId}`,
      headers: { cookie: admin },
    });
    expect(g.json().charts.map((c: { key: string }) => c.key)).toEqual(['sales', 'byRegion']);
    expect((await putCharts(tplId, [SALES], user)).statusCode).toBe(403);
  });
  it('проверки: схема, запрос, «одна строка», дубликаты, больше 20 — 400 VALIDATION по полям', async () => {
    const bad = async (body: object) => {
      const r = await putCharts(tplId, body);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION');
      return r.json().error.details as { path: string; message: string }[];
    };
    expect(await bad([{ ...SALES, query: 'nope' }])).toEqual([
      { path: '/0/query', message: 'нет запроса «nope»' },
    ]);
    expect(await bad([{ ...SALES, query: 'one' }])).toEqual([
      {
        path: '/0/query',
        message: 'запрос «one» возвращает одну строку — нужен режим «Список строк»',
      },
    ]);
    expect((await bad([SALES, SALES]))[0]).toMatchObject({ path: '/1/key' });
    expect(
      (await bad([{ ...SALES, type: 'pie', series: [{ column: 'a' }, { column: 'b' }] }]))[0],
    ).toMatchObject({ path: '/0/series' });
    expect(
      (await bad(Array.from({ length: 21 }, (_, i) => ({ ...SALES, key: `k${i}` }))))[0],
    ).toBeDefined();
  });
  it('ключ charts: запрос charts при графиках и графики при запросе charts — ошибка (R8)', async () => {
    await putCharts(tplId, [SALES]);
    const q = await putQueries(tplId, [
      ...QUERIES,
      { key: 'charts', mode: 'list', sql: 'select 1' },
    ]);
    expect(q.statusCode).toBe(400);
    expect(q.json().error.details).toEqual([
      { path: '/2/key', message: 'ключ charts занят графиками' },
    ]);
    const gone = await putQueries(tplId, [QUERIES[1]]);
    expect(gone.json().error.details).toEqual([
      { path: '', message: 'запрос «orders» используется графиком «sales»' },
    ]);
    const other = await createTemplate(t, admin, dsId, {
      queries: [...QUERIES, { key: 'charts', mode: 'list', sql: 'select 1' }] as never,
    });
    const c = await putCharts(other, [SALES]);
    expect(c.statusCode).toBe(400);
    expect(c.json().error.details).toEqual([{ path: '', message: 'ключ charts занят графиками' }]);
  });
  it('запрос графика нельзя перевести в «Одна строка» (R8)', async () => {
    await putCharts(tplId, [SALES]);
    const q = await putQueries(tplId, [{ ...QUERIES[0], mode: 'single' }, QUERIES[1]]);
    expect(q.statusCode).toBe(400);
    expect(q.json().error.details).toEqual([
      {
        path: '/0/mode',
        message: 'запрос используется графиком «sales» — нужен режим «Список строк»',
      },
    ]);
  });
  it('одновременные PUT charts и PUT queries: проходит только один (блокировка строки)', async () => {
    const id = await createTemplate(t, admin, dsId, { queries: QUERIES as never });
    for (let i = 0; i < 5; i++) {
      await putQueries(id, QUERIES);
      await putCharts(id, []);
      const [c, q] = await Promise.all([putCharts(id, [SALES]), putQueries(id, [QUERIES[1]])]);
      expect([c.statusCode, q.statusCode].sort()).toEqual([200, 400]);
    }
  });
});

describe('d.charts в предпросмотре и отчёте (§35.4)', () => {
  it('предпросмотр: описание по строкам, numeric строкой — число, null — пропуск (Review Focus 1)', async () => {
    await putCharts(tplId, [SALES]);
    const r = await previewData(tplId);
    expect(r.statusCode).toBe(200);
    const chart = r.json().charts.sales;
    expect(chart.type).toBe('echarts@v5');
    expect(chart.option.xAxis.data).toEqual(['Янв', 'Фев', 'Мар']);
    expect(chart.option.series[0]).toMatchObject({
      type: 'bar',
      name: 'Сумма',
      data: [100, Number('12345678901234567890.5'), null],
    });
  });
  it('без графиков ключа charts нет', async () => {
    const id = await createTemplate(t, admin, dsId, { queries: QUERIES as never });
    expect(Object.keys((await previewData(id)).json())).toEqual(['orders', 'one', 'params']);
  });
  it('PUT charts [] очищает графики — ключа charts в данных нет', async () => {
    const id = await createTemplate(t, admin, dsId, { queries: QUERIES as never });
    await putCharts(id, [SALES]);
    expect(Object.keys((await previewData(id)).json())).toContain('charts');
    const r = await putCharts(id, []);
    expect(r.statusCode).toBe(200);
    expect(r.json().charts).toEqual([]);
    expect(Object.keys((await previewData(id)).json())).toEqual(['orders', 'one', 'params']);
  });
  it('нет колонки — 400 CARBONE_TEMPLATE с ключом графика (Review Focus 1)', async () => {
    await putCharts(tplId, [{ ...SALES, series: [{ column: 'totl' }] }]);
    const r = await previewData(tplId);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({
      code: 'CARBONE_TEMPLATE',
      message: 'ошибка шаблона: график sales: нет колонки totl',
    });
    await putCharts(tplId, [SALES]);
  });
  it('отчёт: данные запуска содержат charts', async () => {
    await putCharts(tplId, [SALES]);
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/reports/${tplId}/render`,
      headers: { cookie: user },
      payload: { params: {} },
    });
    expect(r.statusCode).toBe(201);
    const file = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${r.json().runId}/file`,
      headers: { cookie: user },
    });
    expect(JSON.parse(file.body).data.charts.sales.option.series[0].data).toEqual([
      100,
      Number('12345678901234567890.5'),
      null,
    ]);
  });
  it('копия шаблона копирует графики; удаление шаблона удаляет их', async () => {
    await putCharts(tplId, [SALES]);
    const d = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${tplId}/duplicate`,
      headers: { cookie: admin },
    });
    const copyId = d.json().id;
    const g = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${copyId}`,
      headers: { cookie: admin },
    });
    expect(g.json().charts.map((c: { key: string }) => c.key)).toEqual(['sales']);
    await t.app.inject({
      method: 'DELETE',
      url: `/api/templates/${copyId}`,
      headers: { cookie: admin },
    });
    expect(
      await t.deps.db.select().from(templateCharts).where(eq(templateCharts.templateId, copyId)),
    ).toEqual([]);
  });
});
