import { adminApi, expect, loginAdminUi, loginUi, test } from '../fixtures';

const login = `e2e_s_${Date.now().toString(36)}`;
const password = 'password123';
let userId: string;

test.beforeAll(async () => {
  const api = await adminApi();
  userId = (await api.post<{ id: string }>('/api/users', { login, password, role: 'user' })).id;
});
test.afterAll(async () => {
  if (userId) await (await adminApi()).del(`/api/users/${userId}`);
});

test('админ завершает сессии пользователя: следующий запрос пользователя ведёт на вход', async ({
  browser,
  page,
}) => {
  // Пользователь в отдельном контексте браузера.
  const userCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const userPage = await userCtx.newPage();
  await loginUi(userPage, login, password);
  await userPage.goto('/reports');
  await expect(userPage.getByText('Счёт (демо)')).toBeVisible();

  await loginAdminUi(page);
  await page.goto('/admin/users');
  const row = page.getByRole('row', { name: new RegExp(login) });
  await row.getByRole('button', { name: 'Завершить сессии' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Завершить' }).click();
  await expect(page.getByText(`Сессии пользователя ${login} завершены`)).toBeVisible();

  await userPage.goto('/history');
  await expect(userPage).toHaveURL(/\/login/);
  await userCtx.close();
});
