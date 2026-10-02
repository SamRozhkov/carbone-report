import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('база данных', () => {
  it('миграции создали все таблицы', async () => {
    const r = await t.deps.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(r.rows.map((x) => x.table_name)).toEqual(
      expect.arrayContaining([
        'datasources',
        'report_runs',
        'template_params',
        'template_queries',
        'templates',
        'users',
      ]),
    );
  });
  it('GET /api/health работает', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
