import { adminApi, demoTemplateId, expect, loginAdminUi, test, waitForStack } from '../fixtures';

test.beforeAll(waitForStack);

test('админ: запрос во вкладке «Данные», предпросмотр и дерево тегов', async ({ page }) => {
  const id = await demoTemplateId(await adminApi());
  await loginAdminUi(page);

  await page.goto(`/admin/templates/${id}?tab=data`);
  await page.getByRole('button', { name: /^items/ }).click();
  await page.getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.getByText('Бумага А4', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Предпросмотр' }).click();
  await page.getByRole('button', { name: 'Получить данные' }).click();
  await expect(page.getByRole('group', { name: 'Данные отчёта' })).toBeVisible();

  await page.getByRole('tab', { name: 'Документ' }).click();
  await expect(page.getByText('{d.company.name}', { exact: true })).toBeVisible();
  await expect(page.getByText('{d.items[i+1]}', { exact: true })).toBeVisible();
});
