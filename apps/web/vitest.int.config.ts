import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    // Сборка стадии nginx образа web — до пары минут при первом запуске.
    hookTimeout: 600_000,
  },
});
