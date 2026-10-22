import { describe, expect, it } from 'vitest';
import { changeLocale } from '../i18n';
import { formatDate, formatDateTime, formatDuration } from './format';

describe('format', () => {
  it('formatDateTime в локали ru-RU', () => {
    expect(formatDateTime('2026-01-31T09:05:00')).toBe('31.01.2026 09:05');
  });
  it('formatDateTime и formatDate на en и de — формат локали Intl как есть', async () => {
    const iso = '2026-01-31T09:05:00';
    await changeLocale('en', { persist: 'none' });
    const en = new Intl.DateTimeFormat('en', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
    expect(formatDateTime(iso)).toBe(en);
    expect(formatDateTime(iso)).toContain(',');
    expect(formatDate(iso)).toBe('01/31/2026');
    await changeLocale('de', { persist: 'none' });
    expect(formatDateTime(iso)).toBe('31.01.2026, 09:05');
    expect(formatDate(iso)).toBe('31.01.2026');
  });
  it('formatDuration', () => {
    expect(formatDuration(850)).toBe('850 мс');
    expect(formatDuration(12_340)).toBe('12,3 с');
    expect(formatDuration(125_000)).toBe('2 мин 05 с');
    expect(formatDuration(59_950)).toBe('1 мин 00 с');
    expect(formatDuration(119_600)).toBe('2 мин 00 с');
  });
  it('formatDuration на en, de и zh-CN — единицы и десятичный разделитель языка', async () => {
    await changeLocale('en', { persist: 'none' });
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_340)).toBe('12.3 s');
    expect(formatDuration(125_000)).toBe('2 min 05 s');
    await changeLocale('de', { persist: 'none' });
    expect(formatDuration(12_340)).toBe('12,3 s');
    await changeLocale('zh-CN', { persist: 'none' });
    expect(formatDuration(125_000)).toBe('2 分 05 秒');
  });
});
