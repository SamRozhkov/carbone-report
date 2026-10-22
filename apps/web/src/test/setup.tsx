import '@testing-library/jest-dom/vitest';
import { settings } from '@gravity-ui/date-utils';
import { configure } from '@gravity-ui/uikit';
import { cleanup, configure as configureTesting } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { afterEach, vi } from 'vitest';
import type { CodeEditorProps } from '../components/CodeEditor';
import { changeLocale, currentLocale, setDefaultLocale } from '../i18n';

// Язык тестов — ru (§44.6): i18n инициализируется с ru синхронно при импорте.
document.documentElement.lang = 'ru';
configure({ lang: 'ru' });
// Медленные раннеры CI: холодный старт страницы дольше стандартной секунды findBy*/waitFor.
configureTesting({ asyncUtilTimeout: 3000 });
await settings.loadLocale('ru');
settings.setLocale('ru');

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  // Тест сменил язык — следующий снова начинает на ru.
  setDefaultLocale('ru');
  if (currentLocale() !== 'ru' || document.documentElement.lang !== 'ru') {
    await changeLocale('ru', { persist: 'none' });
  }
});

// jsdom: uikit вызывает matchMedia и ResizeObserver без проверок (Справка §10).
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}
if (!('ResizeObserver' in window)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:mock';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

// Monaco в jsdom не загружается: любой тест, который тянет редактор, получает textarea.
vi.mock('../components/CodeEditor', async () => {
  const { jsx } = await import('react/jsx-runtime');
  return {
    CodeEditor: ({ value, onChange, ariaLabel, readOnly }: CodeEditorProps) =>
      jsx('textarea', {
        'aria-label': ariaLabel,
        value,
        readOnly,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value),
      }),
  };
});
