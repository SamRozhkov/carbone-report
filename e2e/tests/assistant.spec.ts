import { adminApi, expect, loginAdminUi, test, waitForStack } from '../fixtures';

test.beforeAll(waitForStack);

interface Saved {
  enabled: boolean;
  baseUrl: string;
  model: string;
  extraInstructions: string;
}
let saved: Saved | undefined;

// Стек общий с другими сценариями и с демо: после теста — настройки, какие были до него.
test.beforeAll(async () => {
  const s = await (await adminApi()).get<Saved>('/api/admin/assistant');
  saved = {
    enabled: s.enabled,
    baseUrl: s.baseUrl,
    model: s.model,
    extraInstructions: s.extraInstructions,
  };
});

test.afterAll(async () => {
  // Без поля apiKey — сохранённый ключ не меняется.
  if (saved) await (await adminApi()).put('/api/admin/assistant', saved);
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
  // Ползунок перекрывает input переключателя — щёлкаем по подписи (label Gravity Switch);
  // если ассистент уже был включён до теста, не выключаем его.
  const enabled = page.getByRole('switch', { name: 'Ассистент включён' });
  if (!(await enabled.isChecked()))
    await page.getByText('Ассистент включён', { exact: true }).click();
  await expect(enabled).toBeChecked();
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Настройки сохранены')).toBeVisible();
  await page.goto('/reports');
  // Пункт «Ассистент» есть и в меню администрирования; пункт подвала идёт в DOM последним.
  await page.getByText('Ассистент', { exact: true }).last().click();
  await expect(page.getByRole('complementary', { name: 'Ассистент' })).toBeVisible();
});
