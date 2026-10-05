import type { Page } from '@playwright/test';
import {
  adminApi,
  demoTemplateId,
  docxText,
  expect,
  loginAdminUi,
  test,
  waitForStack,
  type ApiClient,
} from '../fixtures';

let api: ApiClient;
let templateId: string;

test.beforeAll(async () => {
  await waitForStack();
  api = await adminApi();
  templateId = await demoTemplateId(api);
  // Исходный файл, запросы и параметры шаблона восстанавливает global-setup.ts.
});

async function openEditor(page: Page) {
  await page.goto(`/admin/templates/${templateId}?tab=document`);
  const frame = page.frameLocator('iframe[name="frameEditor"]');
  await expect(frame.locator('#id_viewer')).toBeVisible({ timeout: 180_000 });
  // Документ загружен, оверлей загрузки исчез.
  await expect(frame.locator('.asc-loadmask')).toHaveCount(0, { timeout: 120_000 });
  return frame;
}

test('OnlyOffice: правка шаблона, сохранение, новые данные в отчёте', async ({ page }) => {
  const before = await api.get<{ version: number }>(`/api/templates/${templateId}`);
  await loginAdminUi(page);
  const frame = await openEditor(page);

  // Поверх холста документа лежит холст-оверлей, клики принимает он.
  await frame.locator('#id_viewer_overlay').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ИНН: {d.company.inn}', { delay: 30 });
  // Правки ушли на Document Server — иначе forcesave ответит «изменений нет».
  await expect(frame.getByText('Все изменения сохранены')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText(/Сохранено, версия \d+/)).toBeVisible({ timeout: 90_000 });

  const after = await api.get<{ version: number }>(`/api/templates/${templateId}`);
  expect(after.version).toBeGreaterThan(before.version);

  const { runId } = await api.post<{ runId: string }>(`/api/reports/${templateId}/render`, {
    params: { invoiceId: 1 },
    format: 'docx',
  });
  const file = await api.ctx.get(`/api/runs/${runId}/file`);
  const text = await docxText(Buffer.from(await file.body()));
  expect(text).toContain('ИНН: 7701234567');
  expect(text).not.toContain('{d.');
});

test('OnlyOffice: редактор виден после переключения вкладок', async ({ page }) => {
  await loginAdminUi(page);
  await openEditor(page);
  await page.getByRole('tab', { name: 'Данные' }).click();
  await page.getByRole('tab', { name: 'Документ' }).click();
  const box = await page.locator('iframe[name="frameEditor"]').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
  expect(box?.height ?? 0).toBeGreaterThan(300);
  await expect(page.frameLocator('iframe[name="frameEditor"]').locator('#id_viewer')).toBeVisible();
});

test('наблюдение: смена ключа документа после закрытия редактора', async ({ page }) => {
  await loginAdminUi(page);
  await openEditor(page);
  const keyBefore = (
    await api.get<{ document: { key: string } }>(`/api/templates/${templateId}/editor-config`)
  ).document.key;
  await page.goto('/reports'); // редактор закрыт
  await page.waitForTimeout(20_000); // наблюдение: Document Server закрывает сессию с задержкой
  const keyAfter = (
    await api.get<{ document: { key: string } }>(`/api/templates/${templateId}/editor-config`)
  ).document.key;
  const observed =
    keyBefore === keyAfter
      ? 'ключ не сменился (источник сессии и статус callback не определялись)'
      : 'ключ сменился (источник сессии и статус callback не определялись)';
  test.info().annotations.push({ type: 'doc_key после закрытия', description: observed });
  console.log(`наблюдение: ${observed}`);
});
