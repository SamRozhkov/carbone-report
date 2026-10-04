import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { afterEach, vi } from 'vitest';
import type { CodeEditorProps } from '../components/CodeEditor';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    // ignore
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
