import type { Page } from '@playwright/test';
import { ADMIN, adminApi, expect, loginAdminUi, loginUi, test } from '../fixtures';

interface Backup {
  name: string;
  kind: string;
  status: string;
}
interface Operation {
  id: string;
  type: string;
  status: string;
  backup: string | null;
  requestedBy: string;
}

/**
 * Ждёт, пока операция с этим id не закончится, и возвращает её. Панели операции на странице
 * не верим: до первого опроса она может показывать статус прошлой операции. Во время
 * восстановления API отвечает 503 — такие ответы пропускаются.
 */
async function waitOperation(page: Page, id: string, timeout: number): Promise<Operation> {
  let last: Operation | undefined;
  await expect
    .poll(
      async () => {
        const r = await page.request.get('/api/admin/backups/operation').catch(() => null);
        if (r?.status() !== 200) return 'нет ответа';
        last = (await r.json()) as Operation;
        return last.id === id ? last.status : `другая операция ${last.id}`;
      },
      { timeout, intervals: [1000] },
    )
    .toMatch(/^(succeeded|failed)$/);
  return last!;
}

test('бэкап из админки → изменение данных → восстановление → повторный вход: данные из бэкапа', async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  const api = await adminApi();
  const me = await api.get<{ features?: { backups: boolean } }>('/api/auth/me');
  expect(me.features?.backups, 'управление бэкапами выключено: у api нет BACKUP_AGENT_URL').toBe(
    true,
  );

  const suffix = Date.now().toString(36);
  const kept = `e2e-бэкап-${suffix}`;
  const later = `e2e-после-${suffix}`;
  const keptId = (await api.post<{ id: string }>('/api/categories', { name: kept })).id;
  const before = new Set((await api.get<Backup[]>('/api/admin/backups')).map((b) => b.name));

  // Бэкап из админки: id операции — из ответа на POST.
  await loginAdminUi(page);
  await page.goto('/admin/backups');
  const backupStarted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/admin/backups',
  );
  await page.getByRole('button', { name: 'Сделать бэкап' }).click();
  const backupRes = await backupStarted;
  expect(backupRes.status()).toBe(202);
  const backupOpId = ((await backupRes.json()) as { operationId: string }).operationId;
  expect((await waitOperation(page, backupOpId, 300_000)).status).toBe('succeeded');
  await expect(page.getByTestId('operation-status')).toHaveText('успешно');
  const created = (await api.get<Backup[]>('/api/admin/backups')).find(
    (b) => !before.has(b.name) && b.kind === 'regular',
  );
  expect(created?.status).toBe('ok');
  const name = created!.name;

  // Изменение данных после бэкапа.
  await api.del(`/api/categories/${keptId}`);
  await api.post('/api/categories', { name: later });

  // Восстановление: подтверждение именем, экран обслуживания, перезагрузка по окончании.
  await page.reload();
  await page
    .getByRole('row', { name: new RegExp(name) })
    .getByRole('button', { name: 'Восстановить' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Введите имя бэкапа для подтверждения').fill(name);
  const restoreStarted = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/api/admin/backups/${name}/restore`,
  );
  await dialog.getByRole('button', { name: 'Восстановить' }).click();
  const restoreRes = await restoreStarted;
  expect(restoreRes.status()).toBe(202);
  const restoreOpId = ((await restoreRes.json()) as { operationId: string }).operationId;
  const maintenance = page.getByRole('heading', { name: 'Идёт восстановление из бэкапа…' });
  await expect(maintenance).toBeVisible({ timeout: 120_000 });
  await expect(maintenance).toBeHidden({ timeout: 300_000 });
  expect(await waitOperation(page, restoreOpId, 120_000)).toMatchObject({
    type: 'restore',
    status: 'succeeded',
    backup: name,
    requestedBy: ADMIN.login,
  });

  // Повторный вход в чистом контексте браузера: данные — из бэкапа.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const fresh = await ctx.newPage();
  await loginUi(fresh, ADMIN.login, ADMIN.password);
  await fresh.goto('/admin/categories');
  await expect(fresh.getByText(kept)).toBeVisible();
  await expect(fresh.getByText(later)).toHaveCount(0);
  await ctx.close();

  // Уборка: категория вернулась вместе с бэкапом.
  const categories = await api.get<{ id: string; name: string }[]>('/api/categories');
  for (const c of categories.filter((c) => c.name === kept))
    await api.del(`/api/categories/${c.id}`);
});
