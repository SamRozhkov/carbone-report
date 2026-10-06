/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Vitest: без явного выбора ESM-сборки react-router и react-router/dom получают разные копии контекста.
const rr = (file: string) =>
  fileURLToPath(new URL(`./node_modules/react-router/dist/development/${file}`, import.meta.url));

// Dev-стек (pnpm stack:dev) отдаёт API и OnlyOffice через nginx на :8080.
const STACK_URL = process.env.STACK_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  // @gravity-ui/navigation без поля exports: main указывает на CJS-сборку, которая требует .css (Справка §10).
  resolve: { mainFields: ['module', 'jsnext:main', 'jsnext'] },
  server: {
    port: 5173,
    // Host не подменяем (changeOrigin: false): OnlyOffice строит ссылки на :5173 через X-Forwarded-Host.
    proxy: {
      '/api': { target: STACK_URL },
      '/onlyoffice': { target: STACK_URL, ws: true },
    },
  },
  // Самый большой чанк после Плана 11 (3390.6 kB), округлено вверх до сотни.
  build: { chunkSizeWarningLimit: 3400 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.tsx'],
    // Пакеты Gravity UI импортируют .css — пропускаем их через Vite (Справка §10).
    server: { deps: { inline: [/@gravity-ui\//] } },
    alias: [
      { find: /^react-router\/dom$/, replacement: rr('dom-export.mjs') },
      { find: /^react-router$/, replacement: rr('index.mjs') },
    ],
  },
});
