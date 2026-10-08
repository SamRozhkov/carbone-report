import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 180_000,
    // Сборка образа агента при первом запуске — несколько минут.
    hookTimeout: 900_000,
    // Redis и флаг cr:maintenance общие для всех тестов.
    fileParallelism: false,
  },
});
