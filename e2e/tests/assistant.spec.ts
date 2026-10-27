import { adminApi, expect, loginAdminUi, test, waitForStack } from '../fixtures';

test.beforeAll(waitForStack);

const OFF = { enabled: false, baseUrl: '', model: '', extraInstructions: '', apiKey: null };

test.afterAll(async () => {
  // Стек общий с другими сценариями и с демо: ассистент остаётся выключенным.
  const api = await adminApi();
  await api.put('/api/admin/assistant', OFF);
});

test('админ: настройки ассистента, проверка недоступного адреса, кнопка в меню', async ({
  page,
}) => {
  await loginAdminUi(page);
  await page.goto('/admin/assistant');
  await page.getByLabel('Адрес API').fill('http://127.0.0.1:9/v1');
  await page.getByLabel('Модель').fill('test-model');
  await page.getByRole('button', { name: 'Проверить подключение' }).click();
  await expect(page.getByText('Сервис модели не отвечает, попробуйте позже')).toBeVisible();
  await page.getByRole('switch', { name: 'Ассистент включён' }).click();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Настройки сохранены')).toBeVisible();
  await page.goto('/reports');
  // Пункт «Ассистент» есть и в меню администрирования; пункт подвала идёт в DOM последним.
  await page.getByText('Ассистент', { exact: true }).last().click();
  await expect(page.getByRole('complementary', { name: 'Ассистент' })).toBeVisible();
});
