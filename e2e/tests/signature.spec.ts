import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { adminApi, demoTemplateId, expect, loginUi, test, waitForStack } from '../fixtures';

const login = `e2e_sign_${Date.now().toString(36)}`;
const password = 'password123';
const P12 = fileURLToPath(new URL('../../apps/api/test/fixtures/sign/rsa.p12', import.meta.url));
const P12_PASSWORD = 'test-password';
const SUBJECT = 'Иванов Иван Иванович (rsa)';

/** Настройки PDF демо-шаблона до теста: возвращаются в afterAll. */
let templateId = '';
let savedPdfOptions: Record<string, unknown> | undefined;

test.beforeAll(async () => {
  await waitForStack();
  const api = await adminApi();
  templateId = await demoTemplateId(api);
  const t = await api.get<{ pdfOptions: Record<string, unknown> }>(`/api/templates/${templateId}`);
  savedPdfOptions = t.pdfOptions;
  // Пароль не передаём — сохранённый остаётся прежним; подпись с защитой несовместима (400).
  await api.put(`/api/templates/${templateId}/pdf-options`, {
    ...savedPdfOptions,
    signature: { position: 'bottom-right' },
  });
  await api.post('/api/users', { login, password, role: 'user' });
});

test.afterAll(async () => {
  const api = await adminApi();
  if (savedPdfOptions) {
    const { signature: _signature, ...rest } = savedPdfOptions;
    await api.put(`/api/templates/${templateId}/pdf-options`, rest);
  }
  const users = await api.get<{ id: string; login: string }[]>('/api/users');
  const u = users.find((x) => x.login === login);
  if (u) await api.del(`/api/users/${u.id}`);
});

test('подпись PDF: сертификат → отчёт → «Подписать PDF» → подписанный файл, история', async ({
  page,
}) => {
  await loginUi(page, login, password);

  // 1. «Моя подпись»: загрузка сертификата.
  await page.goto('/signature');
  await page.getByLabel('Файл сертификата').setInputFiles(P12);
  await page.getByLabel('Пароль к файлу').fill(P12_PASSWORD);
  await page.getByRole('button', { name: 'Загрузить сертификат' }).click();
  await expect(page.getByText(SUBJECT).first()).toBeVisible();

  // 2. Отчёт и подпись.
  await page.goto('/reports');
  await page.getByText('Счёт (демо)', { exact: true }).click();
  await page.getByRole('button', { name: 'Сформировать' }).click();
  await expect(page.getByTitle('Предпросмотр отчёта')).toBeVisible();
  await page.getByRole('button', { name: 'Подписать PDF' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Пароль к ключу подписи').fill(P12_PASSWORD);
  await dialog.getByRole('button', { name: 'Подписать', exact: true }).click();
  await expect(page.getByText(`Подписан: ${SUBJECT}`)).toBeVisible();

  // 3. Скачанный файл — подписанный PDF.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать подписанный PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/-signed\.pdf$/);
  const bytes = await readFile((await download.path())!);
  expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
  const text = bytes.toString('latin1');
  expect(text).toContain('/ETSI.CAdES.detached');
  expect(text).toContain('/ByteRange');

  // 4. История: у подписанного запуска есть «PDF с подписью».
  await page.goto('/history');
  await page.getByRole('button', { name: 'Скачать' }).first().click();
  await expect(page.getByRole('menuitem', { name: 'PDF с подписью' })).toBeVisible();
  await page.keyboard.press('Escape');

  // 5. Сертификат удаляется.
  await page.goto('/signature');
  await page.getByRole('button', { name: 'Удалить' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Удалить/ })
    .click();
  await expect(page.getByRole('button', { name: 'Загрузить сертификат' })).toBeVisible();
});
