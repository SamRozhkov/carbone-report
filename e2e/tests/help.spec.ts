import { adminApi, demoTemplateId, expect, loginAdminUi, test, waitForStack } from '../fixtures';

const SECTIONS = [
  'Основы',
  'Таблицы',
  'Форматирование',
  'Условия',
  'Итоги и группировка',
  'Недоступно в бесплатной версии',
];

test.beforeAll(waitForStack);

test('админ открывает справку по ссылке из редактора в новой вкладке', async ({ page }) => {
  const id = await demoTemplateId(await adminApi());
  await loginAdminUi(page);
  await page.goto(`/admin/templates/${id}?tab=document`);

  const link = page.getByRole('link', { name: 'Справка по синтаксису' });
  await expect(link).toHaveAttribute('href', '/admin/help');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');

  // rel="noopener": у новой вкладки нет opener, поэтому ждём новую страницу контекста.
  const [help] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
  await help.waitForLoadState();
  await expect(help).toHaveURL(/\/admin\/help$/);
  await expect(help.getByRole('heading', { level: 1, name: 'Справка по шаблонам' })).toBeVisible();

  const toc = help.getByRole('navigation', { name: 'Оглавление' });
  for (const name of SECTIONS) {
    await expect(toc.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(help.getByRole('region', { name, exact: true })).toBeAttached();
  }
  await toc.getByRole('link', { name: 'Итоги и группировка', exact: true }).click();
  await expect(help).toHaveURL(/\/admin\/help#totals$/);
  await expect(
    help.getByRole('region', { name: 'Итоги и группировка', exact: true }).getByRole('heading', {
      level: 2,
    }),
  ).toBeInViewport();

  // Вкладка редактора осталась на месте — документ OnlyOffice не закрыт.
  await expect(page).toHaveURL(new RegExp(`/admin/templates/${id}\\?tab=document$`));
  await help.close();
});
