import {
  ADMIN,
  adminApi,
  demoTemplateId,
  expect,
  loginAdminUi,
  loginUi,
  test,
  waitForStack,
} from '../fixtures';

const ts = Date.now().toString(36);
const login = `e2e_acc_${ts}`;
const password = 'password123';
const groupName = `E2E ${ts}`;
const templateName = `Закрытый ${ts}`;

let userId: string | undefined;
let groupId: string | undefined;
let templateId: string | undefined;

test.beforeAll(async () => {
  await waitForStack();
  const api = await adminApi();
  userId = (await api.post<{ id: string }>('/api/users', { login, password, role: 'user' })).id;
  groupId = (await api.post<{ id: string }>('/api/groups', { name: groupName })).id;
  const demoId = await demoTemplateId(api);
  templateId = (await api.post<{ id: string }>(`/api/templates/${demoId}/duplicate`)).id;
  await api.patch(`/api/templates/${templateId}`, { name: templateName });
  // Копия наследует доступ демо-шаблона («доступно всем», «Финансы») — закрываем полностью.
  await api.put(`/api/templates/${templateId}/access`, {
    public: false,
    categoryId: null,
    groupIds: [],
  });
});

test.afterAll(async () => {
  const api = await adminApi();
  if (templateId) await api.del(`/api/templates/${templateId}`);
  if (groupId) await api.del(`/api/groups/${groupId}`);
  if (userId) await api.del(`/api/users/${userId}`);
});

test('доступ: закрытый шаблон открывается пользователю через группу', async ({ page }) => {
  // 1. Пользователь не видит закрытый шаблон ни в каталоге, ни по прямой ссылке.
  await loginUi(page, login, password);
  await page.goto('/reports');
  await expect(page.getByText('Счёт (демо)', { exact: true })).toBeVisible();
  await expect(page.getByText(templateName, { exact: true })).toHaveCount(0);
  await page.goto(`/reports/${templateId}`);
  await expect(page.getByText('Не удалось открыть отчёт')).toBeVisible();
  await expect(page.getByText(/шаблон не найден/)).toBeVisible();
  const userCookies = await page.context().cookies();

  // 2. Админ (в той же вкладке, сессия пользователя сохранена): доступ группе в «Настройках».
  await page.context().clearCookies();
  await loginAdminUi(page);
  await page.goto(`/admin/templates/${templateId}?tab=settings`);
  const access = page.getByRole('region', { name: 'Доступ' });
  await expect(access.getByText('Шаблон сейчас доступен только администраторам')).toBeVisible();
  await access.getByRole('combobox', { name: 'Группы' }).click();
  await page.getByRole('option', { name: groupName, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(access.getByText('Шаблон сейчас доступен только администраторам')).toHaveCount(0);
  await access.getByRole('button', { name: 'Сохранить доступ' }).click();
  await expect(page.getByText('Доступ сохранён')).toBeVisible();

  // 3. «Группы» → «Участники»: два варианта за одно открытие мультиселекта в диалоге.
  await page.goto('/admin/groups');
  const row = page.getByRole('row').filter({ hasText: groupName });
  await row.getByRole('button', { name: 'Участники' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Участники' }).click();
  await page.getByRole('option', { name: login, exact: true }).click();
  // Список не закрылся и не скрыт от a11y-дерева (aria-hidden): следующий вариант доступен по роли.
  await expect(page.getByRole('option', { name: ADMIN.login, exact: true })).toBeVisible();
  await page.getByRole('option', { name: ADMIN.login, exact: true }).click();
  await expect(page.getByRole('option', { name: login, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const members = dialog.getByRole('combobox', { name: 'Участники' });
  await expect(members).toContainText(login);
  await expect(members).toContainText(ADMIN.login);
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByRole('cell').nth(2)).toHaveText('2');

  // 4. Пользователь обновляет страницу — шаблон виден, PDF формируется.
  await page.context().clearCookies();
  await page.context().addCookies(userCookies);
  await page.goto('/reports');
  await page.reload();
  await page.getByText(templateName, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/reports/${templateId}$`));
  // Как в user.spec: ждём значения по умолчанию зависимых SQL-списков, иначе «Сформировать» уйдёт раньше.
  await expect(page.getByRole('combobox', { name: 'Компания *' })).toContainText('ООО «Ромашка»');
  await expect(page.getByRole('combobox', { name: 'Счёт *' })).toContainText('СЧ-001');
  await page.getByRole('button', { name: 'Сформировать' }).click();
  const frame = page.getByTitle('Предпросмотр отчёта');
  await expect(frame).toBeVisible();
  const pdf = await page.request.get((await frame.getAttribute('src'))!);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');
});
