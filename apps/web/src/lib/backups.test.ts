import { describe, expect, it } from 'vitest';
import { formatSize, PHASE_LABEL, requestedByLabel } from './backups';

describe('backups', () => {
  it.each([
    [null, '—'],
    [0, '0 Б'],
    [1023, '1023 Б'],
    [1024, '1,0 КБ'],
    [1536, '1,5 КБ'],
    [5 * 1024 * 1024, '5,0 МБ'],
    [3 * 1024 ** 3, '3,0 ГБ'],
  ])('formatSize(%j) = %j', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
  it('подписи фаз и инициатора', () => {
    expect(PHASE_LABEL.db).toBe('Замена базы данных');
    expect(requestedByLabel('cron')).toBe('по расписанию');
    expect(requestedByLabel('recovery-code')).toBe('по коду восстановления');
    expect(requestedByLabel('admin')).toBe('admin');
  });
});
