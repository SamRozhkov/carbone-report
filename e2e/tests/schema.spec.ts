import { adminApi, demoTemplateId, expect, test, waitForStack } from '../fixtures';

test.beforeAll(waitForStack);

test('схема демо-источника и проверка SQL через API автора', async () => {
  const api = await adminApi();
  const id = await demoTemplateId(api);
  const list = await api.get<{ tables: { name: string }[] }>(`/api/templates/${id}/schema/tables`);
  expect(list.tables.map((t) => t.name)).toContain('company');
  const company = await api.get<{ columns: { name: string }[] }>(`/api/templates/${id}/schema/tables/company`);
  expect(company.columns.map((c) => c.name)).toContain('name');
  const check = await api.post<{ ok: boolean; columns?: { name: string }[] }>(`/api/templates/${id}/queries/check`, {
    sql: 'select c.name from company c where c.id = :companyId',
  });
  expect(check).toEqual({ ok: true, columns: [{ name: 'name', type: 'text' }] });
});
