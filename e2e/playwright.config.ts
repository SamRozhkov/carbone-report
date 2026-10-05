import { defineConfig, devices } from '@playwright/test';

try {
  process.loadEnvFile('../.env');
} catch {
  // переменные могут прийти из окружения
}

export default defineConfig({
  testDir: './tests',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.BASE_URL ?? `https://localhost:${process.env.WEB_HTTPS_PORT ?? 443}`,
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
