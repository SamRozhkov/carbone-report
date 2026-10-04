import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDuration } from './format';

describe('format', () => {
  it('formatDateTime в локали ru-RU', () => {
    expect(formatDateTime('2026-01-31T09:05:00')).toBe('31.01.2026 09:05');
  });
  it('formatDuration', () => {
    expect(formatDuration(850)).toBe('850 мс');
    expect(formatDuration(12_340)).toBe('12,3 с');
    expect(formatDuration(125_000)).toBe('2 мин 05 с');
  });
});
