import { adminApi, demoTemplateId, expect, loginAdminUi, test, waitForStack } from '../fixtures';

test.beforeAll(waitForStack);

test('админ: запрос во вкладке «Данные», предпросмотр и дерево тегов', async ({ page }) => {
  const id = await demoTemplateId(await adminApi());
  await loginAdminUi(page);

  await page.goto(`/admin/templates/${id}?tab=data`);

  // Подсветка: токены SQL получают классы, отличные от mtk1 (обычный текст) — язык зарегистрирован.
  const sql = page.getByRole('group', { name: 'SQL', exact: true });
  await expect(sql.locator('.view-line span[class*="mtk"]:not(.mtk1)').first()).toBeVisible();
  // Редактор принимает ввод: правка делает вкладку грязной, «Отменить» возвращает сохранённое.
  await sql.locator('.view-lines').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' ');
  await expect(page.getByText('Есть несохранённые изменения')).toBeVisible();
  await page.getByRole('button', { name: 'Отменить' }).click();
  await expect(page.getByText('Есть несохранённые изменения')).toBeHidden();

  await page.getByRole('button', { name: /^items/ }).click();
  await page.getByRole('button', { name: 'Выполнить' }).click();
  await expect(page.getByText('Бумага А4', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Предпросмотр' }).click();
  await page.getByRole('button', { name: 'Получить данные' }).click();
  const json = page.getByRole('group', { name: 'Данные отчёта' });
  await expect(json).toBeVisible();
  await expect(json.locator('.view-line span[class*="mtk"]:not(.mtk1)').first()).toBeVisible();

  await page.getByRole('tab', { name: 'Документ' }).click();
  await expect(page.getByText('{d.company.name}', { exact: true })).toBeVisible();
  await expect(page.getByText('{d.items[i+1]}', { exact: true })).toBeVisible();
});
