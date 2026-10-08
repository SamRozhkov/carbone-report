import { readFile } from 'node:fs/promises';
import {
  adminApi,
  docxText,
  expect,
  loginAdminUi,
  loginUi,
  logoutUi,
  test,
  waitForStack,
} from '../fixtures';

const login = `e2e_${Date.now().toString(36)}`;
const password = 'password123';

test.beforeAll(waitForStack);

test.afterAll(async () => {
  const api = await adminApi();
  const users = await api.get<{ id: string; login: string }[]>('/api/users');
  const u = users.find((x) => x.login === login);
  if (u) await api.del(`/api/users/${u.id}`);
});

test('пользователь: создание админом, просмотр PDF, «Сохранить как» DOCX, история', async ({
  page,
}) => {
  await loginAdminUi(page);
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Добавить пользователя' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Логин').fill(login);
  await dialog.getByLabel('Пароль').fill(password);
  await dialog.getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByText(login, { exact: true })).toBeVisible();
  await logoutUi(page);

  await loginUi(page, login, password);
  // Сначала меню отрисовано (пункты для всех пользователей видны), потом проверяем отсутствие админских.
  await expect(page.getByText('Отчёты', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Выйти', { exact: true })).toBeVisible();
  await expect(page.getByText('Пользователи', { exact: true })).toHaveCount(0);
  await page.goto('/reports');
  await page.getByText('Счёт (демо)', { exact: true }).click();
  // Значения по умолчанию: «Компания» = 1, «Счёт» = 1 (зависимые SQL-списки).
  await expect(page.getByRole('combobox', { name: 'Компания *' })).toContainText('ООО «Ромашка»');
  await expect(page.getByRole('combobox', { name: 'Счёт *' })).toContainText('СЧ-001');

  await page.getByRole('button', { name: 'Сформировать' }).click();
  const frame = page.getByTitle('Предпросмотр отчёта');
  await expect(frame).toBeVisible();
  const pdfUrl = await frame.getAttribute('src');
  expect(pdfUrl).toMatch(/^\/api\/runs\/[0-9a-f-]{36}\/file\?format=pdf&inline=1$/);
  const pdf = await page.request.get(pdfUrl!);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  // Выбора формата на форме нет; под просмотром — «Сохранить как» с форматами Word-шаблона.
  await expect(page.getByRole('radio')).toHaveCount(0);
  const saveAs = page.getByRole('group', { name: 'Сохранить как' });
  await expect(saveAs.getByRole('button')).toHaveText(['PDF', 'DOCX', 'ODT']);
  const downloadPromise = page.waitForEvent('download');
  await saveAs.getByRole('button', { name: 'DOCX' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^Счёт \(демо\) \d{4}-\d{2}-\d{2}\.docx$/);
  const text = await docxText(await readFile((await download.path())!));
  for (const s of ['СЧ-001', 'ООО «Ромашка»', 'Бумага А4', 'Картридж', 'Ручки шариковые'])
    expect(text).toContain(s);
  expect(text).not.toContain('{d.');

  // История: запуск со снимком — собраны PDF и DOCX, меню «Скачать» со всеми форматами.
  await page.goto('/history');
  await expect(page.getByText('Счёт (демо)').first()).toBeVisible();
  await expect(page.getByText('PDF, DOCX').first()).toBeVisible();
  await page.getByRole('button', { name: 'Скачать' }).first().click();
  await expect(page.getByRole('menuitem')).toHaveText(['PDF', 'DOCX', 'ODT']);
});
