import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { docxText, expect, loginAdminUi, test, waitForStack } from '../fixtures';

test.beforeAll(waitForStack);

async function pick(page: Page, field: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: field }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(page.getByRole('combobox', { name: field })).toContainText(option);
}

test('зависимые SQL-списки: «Компания» → «Счёт», DOCX по выбранному счёту', async ({ page }) => {
  await loginAdminUi(page);
  await page.goto('/reports');
  await page.getByText('Счёт (демо)', { exact: true }).click();

  const company = page.getByRole('combobox', { name: 'Компания *' });
  const invoice = page.getByRole('combobox', { name: 'Счёт *' });
  await expect(company).toContainText('ООО «Ромашка»');
  await expect(invoice).toContainText('СЧ-001');

  await pick(page, 'Компания *', 'АО «Лютик»');
  // Счёт 1 не принадлежит «Лютику» — значение сброшено, в списке только СЧ-002.
  await expect(invoice).not.toContainText('СЧ-001');
  await invoice.click();
  await expect(page.getByRole('option')).toHaveText(['СЧ-002']);
  await page.getByRole('option', { name: 'СЧ-002', exact: true }).click();
  await expect(invoice).toContainText('СЧ-002');

  await page.getByRole('button', { name: 'Сформировать' }).click();
  await expect(page.getByTitle('Предпросмотр отчёта')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('group', { name: 'Сохранить как' })
    .getByRole('button', { name: 'DOCX' })
    .click();
  const download = await downloadPromise;
  const text = await docxText(await readFile((await download.path())!));
  for (const s of ['СЧ-002', 'АО «Лютик»', 'Стол офисный']) expect(text).toContain(s);
  expect(text).not.toContain('СЧ-001');
  expect(text).not.toContain('{d.');

  // Обратно на «Ромашку»: СЧ-002 недоступен — сброшен (или заменён на СЧ-001), в списке только СЧ-001.
  await pick(page, 'Компания *', 'ООО «Ромашка»');
  await expect(invoice).not.toContainText('СЧ-002');
  await invoice.click();
  await expect(page.getByRole('option')).toHaveText(['СЧ-001']);
});
