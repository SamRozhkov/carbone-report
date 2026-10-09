import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STARTUP_LOCK_KEY } from './steps';

// Агент — отдельный пакет и образ: код API он не импортирует, а держит копии. Тесты ловят расхождение.
const apiFile = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../api/src/lib/${name}`, import.meta.url)), 'utf8');

describe('копии кода API в агенте', () => {
  it('STARTUP_LOCK_KEY совпадает с apps/api/src/lib/startup-lock.ts', () => {
    const m = /export const STARTUP_LOCK_KEY = (\d+);/.exec(apiFile('startup-lock.ts'));
    expect(m).not.toBeNull();
    expect(STARTUP_LOCK_KEY).toBe(Number(m![1]));
  });

  it('url-password.ts — копия apps/api/src/lib/url-password.ts, кроме строки «Копия…»', () => {
    const own = readFileSync(fileURLToPath(new URL('./url-password.ts', import.meta.url)), 'utf8');
    const strip = (t: string) =>
      t
        .split('\n')
        .filter((l) => !l.includes('Копия apps/api'))
        .join('\n');
    expect(strip(own)).toBe(strip(apiFile('url-password.ts')));
  });
});
