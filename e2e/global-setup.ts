import { adminApi, demoTemplateId, expect, waitForStack } from './fixtures';

/**
 * Перед прогоном: ждём стек и приводим «Счёт (демо)» к эталону — файл, запросы, параметры и доступ
 * (прошлые прогоны правили шаблон в OnlyOffice). Один вход админа: лимит 10 попыток в минуту.
 * После прогона шаблон остаётся изменённым до следующего запуска или `pnpm demo:seed -- --reset-template`.
 */
export default async function globalSetup(): Promise<void> {
  await waitForStack();
  // Динамический импорт: jszip (CommonJS) уже загружен через require в fixtures,
  // статический ESM-импорт demo/template падает в Node 22 («Unexpected module status 3»).
  const { buildDemoTemplate, DEMO, DEMO_PARAMS, DEMO_QUERIES } = await import('../demo/template');
  const api = await adminApi();
  const id = await demoTemplateId(api);
  const res = await api.ctx.put(`/api/templates/${id}/file`, {
    multipart: {
      file: {
        name: 'schet-demo.docx',
        mimeType: 'application/octet-stream',
        buffer: await buildDemoTemplate(),
      },
    },
  });
  expect(res.ok(), `восстановление файла шаблона: ${res.status()}`).toBeTruthy();
  await api.put(`/api/templates/${id}/queries`, DEMO_QUERIES);
  await api.put(`/api/templates/${id}/params`, DEMO_PARAMS);
  // Доступ — как после demo-seed: «доступно всем», категория «Финансы» (если есть), без групп.
  const categories = await api.get<{ id: string; name: string }[]>('/api/categories');
  const category = categories.find((c) => c.name === DEMO.categoryName);
  await api.put(`/api/templates/${id}/access`, {
    public: true,
    categoryId: category?.id ?? null,
    groupIds: [],
  });
  await api.ctx.dispose();
}
