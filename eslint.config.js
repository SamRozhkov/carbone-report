import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/drizzle/**',
      'e2e/report/**',
      'e2e/test-results/**',
      'docs/**',
      'packages/carbone/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Скрипты на чистом Node (без TypeScript): глобальные объекты Node.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
