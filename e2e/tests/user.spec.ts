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

test('пользователь: создание админом, генерация PDF и DOCX, история', async ({ page }) => {
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
  await expect(page.getByText('Пользователи', { exact: true })).toHaveCount(0);
  await page.goto('/reports');
  await page.getByText('Счёт (демо)', { exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: /Номер счёта/ }).or(page.getByLabel(/Номер счёта/)),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Сформировать' }).click();
  const frame = page.getByTitle('Предпросмотр отчёта');
  await expect(frame).toBeVisible();
  const pdfUrl = await frame.getAttribute('src');
  const pdf = await page.request.get(pdfUrl!);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  await page.getByRole('radio', { name: 'DOCX' }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Сформировать' }).click();
  const download = await downloadPromise;
  const text = await docxText(await readFile((await download.path())!));
  for (const s of ['СЧ-001', 'ООО «Ромашка»', 'Бумага А4', 'Картридж', 'Ручки шариковые'])
    expect(text).toContain(s);
  expect(text).not.toContain('{d.');

  await page.goto('/history');
  await expect(page.getByText('Счёт (демо)').first()).toBeVisible();
});
