import { describe, expect, it, vi } from 'vitest';
import { initLocale } from './bootstrap';

describe('initLocale', () => {
  it('сбой загрузки локали дат не бросает исключение', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(initLocale(() => Promise.reject(new Error('chunk 404')))).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});
