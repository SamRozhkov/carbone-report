import { defineConfig, devices } from '@playwright/test';

// Съёмка скриншотов для сайта (§49.3): pnpm site:shots против поднятого демо-стека.
try {
  process.loadEnvFile('../.env');
} catch {
  // переменные могут прийти из окружения
}

export default defineConfig({
  testDir: './shots',
  testMatch: '*.shots.ts',
  // Тот же global-setup, что у E2E: демо-шаблон приводится к эталону перед съёмкой.
  globalSetup: './global-setup.ts',
  timeout: 600_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.BASE_URL ?? `https://localhost:${process.env.WEB_HTTPS_PORT ?? 443}`,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'off',
    trace: 'off',
  },
});
