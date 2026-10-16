import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  adminApi,
  demoTemplateId,
  docxText,
  expect,
  loginAdminUi,
  loginUi,
  test,
  waitForStack,
  type ApiClient,
} from '../fixtures';

let api: ApiClient;
let templateId: string;
const second = { login: `e2e_admin_${randomUUID().slice(0, 6)}`, password: `P${randomUUID()}` };
let secondId: string | undefined;

test.beforeAll(async () => {
  await waitForStack();
  api = await adminApi();
  templateId = await demoTemplateId(api);
  secondId = (
    await api.post<{ id: string }>('/api/users', {
      login: second.login,
      password: second.password,
      role: 'admin',
    })
  ).id;
});
test.afterAll(async () => {
  if (secondId) await api.del(`/api/users/${secondId}`);
});

/** Уходим со страницы редактора: вкладка снимает блокировку сама, иначе она живёт ещё минуту. */
async function leave(page: Page) {
  await page.goto('/reports');
  await page.waitForTimeout(1_000);
}

async function openDocument(page: Page) {
  await page.goto(`/admin/templates/${templateId}?tab=document`);
  const frame = page.frameLocator('iframe[name="frameEditor"]');
  await expect(frame.locator('#id_viewer')).toBeVisible({ timeout: 180_000 });
  await expect(frame.locator('.asc-loadmask')).toHaveCount(0, { timeout: 120_000 });
  return frame;
}

test('два администратора: просмотр, перехват, правка переходит', async ({ page, browser }) => {
  await loginAdminUi(page);
  await openDocument(page);
  await expect(page.getByText('Вы редактируете')).toBeVisible();

  const ctx2 = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    viewport: { width: 1440, height: 900 },
  });
  const p2 = await ctx2.newPage();
  await loginUi(p2, second.login, second.password);
  await openDocument(p2);
  await expect(p2.getByText(/Только просмотр — редактирует/)).toBeVisible();
  await expect(p2.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);

  // Развёрнутый режим: оверлей закрывает весь экран, диалог перехвата виден поверх и нажимается.
  await p2.getByRole('button', { name: 'Развернуть' }).click();
  const vp = p2.viewportSize()!;
  const full = (await p2.locator('.cr-doc-full').boundingBox())!;
  expect(full.x).toBeLessThanOrEqual(1);
  expect(full.y).toBeLessThanOrEqual(1);
  expect(full.width).toBeGreaterThanOrEqual(vp.width - 2);
  expect(full.height).toBeGreaterThanOrEqual(vp.height - 2);
  // Меню приложения закрыто оверлеем: в точке меню верхний элемент принадлежит `.cr-doc-full`.
  expect(
    await p2.evaluate(() => document.elementFromPoint(60, 400)?.closest('.cr-doc-full') !== null),
  ).toBe(true);
  await p2.getByRole('button', { name: 'Забрать редактирование' }).click();
  const confirm = p2.getByRole('button', { name: 'Забрать', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(p2.getByText('Вы редактируете')).toBeVisible({ timeout: 60_000 });

  await expect(page.getByText(new RegExp(`Редактирование забрал ${second.login}`))).toBeVisible({
    timeout: 40_000,
  });
  await expect(page.getByRole('button', { name: 'Сохранить' })).toHaveCount(0);
  await leave(p2);
  await ctx2.close();
});

test('перетаскивание тега из панели в документ, сборка подставляет значение', async ({ page }) => {
  await loginAdminUi(page);
  const frame = await openDocument(page);
  // Блокировка прошлого теста (закрытая вкладка) истекает за минуту: тогда документ «свободен».
  const editing = page.getByText('Вы редактируете');
  const start = page.getByRole('button', { name: 'Начать редактирование' });
  await expect(editing.or(start)).toBeVisible({ timeout: 90_000 });
  if (await start.isVisible()) await start.click();
  await expect(editing).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Обновить данные' }).click();
  const tile = page.locator('[draggable="true"]', { hasText: '{d.company.inn}' });
  await expect(tile).toBeVisible({ timeout: 60_000 });
  await frame.locator('#id_viewer_overlay').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  const box = (await frame.locator('#id_viewer_overlay').boundingBox())!;
  const from = (await tile.boundingBox())!;
  await page.mouse.move(from.x + 5, from.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
  await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2 + 3, { steps: 3 });
  await page.mouse.up();
  await expect(frame.getByText('Все изменения сохранены')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText(/Сохранено, версия \d+/)).toBeVisible({ timeout: 90_000 });
  const { runId } = await api.post<{ runId: string }>(`/api/reports/${templateId}/render`, {
    params: { invoiceId: 1 },
  });
  const file = await api.ctx.get(`/api/runs/${runId}/file?format=docx`);
  expect(await docxText(Buffer.from(await file.body()))).toContain('7701234567');
  await leave(page);
});
