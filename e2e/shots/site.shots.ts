import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adminApi, demoTemplateId, loginAdminUi, waitForStack } from '../fixtures';
import { DEMO } from '../../demo/template';

// Снимки экранов для site/ (§49.2, §49.3). Сначала ru, затем en; в конце язык администратора и
// настройки PDF демо-шаблона возвращаются к исходным, даже если съёмка упала.
const OUT = fileURLToPath(new URL('../../site/shots/', import.meta.url));
const GENERATE = { ru: 'Сформировать', en: 'Generate' } as const;
const SEARCH = { ru: 'Поиск', en: 'Search' } as const;
const SEARCH_BY_NAME = { ru: 'Поиск по названию', en: 'Search by name' } as const;
// Необязательные карточки вкладки PDF, которые на снимке «подпись» свёрнуты.
const COLLAPSED_CARDS = {
  ru: ['Водяной знак', 'Нумерация страниц', 'Метаданные'],
  en: ['Watermark', 'Page numbers', 'Metadata'],
} as const;
const SIGNATURE_HEADING = { ru: 'Электронная подпись', en: 'Electronic signature' } as const;

type Lang = keyof typeof GENERATE;

let templateId = '';
let savedLocale: string | null = null;
let savedPdfOptions: Record<string, unknown> | undefined;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await waitForStack();
  const api = await adminApi();
  templateId = await demoTemplateId(api);
  savedLocale = (await api.get<{ locale: string | null }>('/api/auth/me')).locale;
  savedPdfOptions = (
    await api.get<{ pdfOptions: Record<string, unknown> }>(`/api/templates/${templateId}`)
  ).pdfOptions;
  // Для экрана «подпись»: включена подпись PDF методом ГОСТ (пароль не передаётся и не меняется).
  await api.put(`/api/templates/${templateId}/pdf-options`, {
    ...savedPdfOptions,
    signature: { position: 'bottom-right', method: 'gost' },
  });
});

test.afterAll(async () => {
  const api = await adminApi();
  try {
    if (savedPdfOptions) await api.put(`/api/templates/${templateId}/pdf-options`, savedPdfOptions);
  } finally {
    await api.put('/api/me/locale', { locale: savedLocale });
  }
});

async function shot(page: Page, lang: Lang, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${OUT}${lang}/${name}.png`,
    animations: 'disabled',
    caret: 'hide',
  });
}

for (const lang of ['ru', 'en'] as const) {
  test.describe(lang, () => {
    // Язык браузера определяет язык страницы входа (до входа выбор пользователя неизвестен).
    test.use({ locale: lang === 'ru' ? 'ru-RU' : 'en-US' });

    test(`снимки ${lang}`, async ({ page }) => {
      mkdirSync(`${OUT}${lang}`, { recursive: true });
      const api = await adminApi();
      await api.put('/api/me/locale', { locale: lang });

      // 1. Вход.
      await page.goto('/login');
      await expect(
        page.getByRole('button', { name: lang === 'ru' ? 'Войти' : 'Sign in' }),
      ).toBeVisible();
      await shot(page, lang, 'login');

      // 2. Каталог отчётов.
      await loginAdminUi(page);
      await expect(page.getByText(DEMO.templateName, { exact: true }).first()).toBeVisible();
      // В кадре только демо-данные: на стенде владельца бывают чужие шаблоны.
      await page.getByPlaceholder(SEARCH[lang], { exact: true }).fill('Счёт');
      await expect(page.getByText(DEMO.templateName, { exact: true })).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      await shot(page, lang, 'reports');

      // 3. Запуск: форма параметров с значениями по умолчанию (зависимые SQL-списки загружены).
      await page.getByText(DEMO.templateName, { exact: true }).first().click();
      await expect(page.getByRole('combobox').first()).toContainText('ООО «Ромашка»');
      await page.waitForLoadState('networkidle');
      await shot(page, lang, 'run');

      // 4. История: сначала запуск отчёта, чтобы в истории была свежая запись.
      const rendered = page.waitForResponse(
        (r) => /\/api\/reports\/[^/]+\/render$/.test(r.url()) && r.ok(),
        { timeout: 180_000 },
      );
      await page.getByRole('button', { name: GENERATE[lang] }).click();
      await rendered;
      await page.goto('/history');
      await expect(page.getByText(DEMO.templateName, { exact: true }).first()).toBeVisible();
      // Фильтр «отчёт» — только демо-шаблон (на стенде владельца бывают чужие запуски).
      await page.getByRole('combobox').first().click();
      await page.getByRole('option', { name: DEMO.templateName, exact: true }).click();
      await page.waitForLoadState('networkidle');
      await shot(page, lang, 'history');

      // 5. Редактор: запросы и параметры (Monaco).
      await page.goto(`/admin/templates/${templateId}?tab=data`);
      await expect(page.locator('.monaco-editor').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await shot(page, lang, 'editor-sql');

      // 6. Редактор: документ в OnlyOffice (ожидание — как в e2e/tests/onlyoffice.spec.ts).
      await page.goto(`/admin/templates/${templateId}?tab=document`);
      const frame = page.frameLocator('iframe[name="frameEditor"]');
      await expect(frame.locator('#id_viewer')).toBeVisible({ timeout: 180_000 });
      await expect(frame.locator('.asc-loadmask')).toHaveCount(0, { timeout: 120_000 });
      // Всплывающая подсказка редактора («Новое») закрывается, если показана.
      await frame
        .getByText(/^(ok|ок|got it)$/i)
        .click({ timeout: 5_000 })
        .catch(() => undefined);
      await shot(page, lang, 'editor-document');

      // 7. Настройки PDF и подписи (подпись ГОСТ включена в beforeAll).
      await page.goto(`/admin/templates/${templateId}?tab=pdf`);
      const heading = page.getByText(SIGNATURE_HEADING[lang], { exact: true });
      await expect(heading).toBeVisible();
      // Необязательные карточки (водяной знак, нумерация, метаданные) на снимке свёрнуты, чтобы в
      // кадре поместились и вкладки редактора (видно, что это вкладка PDF), и настройки подписи.
      for (const label of COLLAPSED_CARDS[lang]) {
        await page
          .getByText(label, { exact: true })
          .first()
          .evaluate((el, sigText) => {
            const sig = [...document.querySelectorAll('*')].find(
              (e) => e.children.length === 0 && e.textContent === sigText,
            );
            let card: Element = el;
            while (card.parentElement && !card.parentElement.contains(sig as Node))
              card = card.parentElement;
            (card as HTMLElement).style.display = 'none';
          }, SIGNATURE_HEADING[lang]);
      }
      await page
        .getByRole('tablist')
        .first()
        .evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForLoadState('networkidle');
      await shot(page, lang, 'signature');

      // 8–10. Доступ, пользователи, источники данных.
      await page.goto('/admin/access');
      await page.getByPlaceholder(SEARCH_BY_NAME[lang], { exact: true }).fill('Счёт');
      await expect(page.getByText(DEMO.templateName, { exact: true })).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      await shot(page, lang, 'access');

      await page.goto('/admin/users');
      await expect(page.getByRole('table').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await shot(page, lang, 'users');

      await page.goto('/admin/datasources');
      await expect(page.getByText(DEMO.datasourceName, { exact: true }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await shot(page, lang, 'datasources');
    });
  });
}
