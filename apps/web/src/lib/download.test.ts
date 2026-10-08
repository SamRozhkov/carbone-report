import { describe, expect, it } from 'vitest';
import { filenameFromDisposition } from './download';

describe('filenameFromDisposition', () => {
  it('имя в UTF-8 из filename* (как отдаёт API)', () => {
    expect(
      filenameFromDisposition(
        `attachment; filename="____ 2026-01-10.docx"; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82%202026-01-10.docx`,
      ),
    ).toBe('Счёт 2026-01-10.docx');
  });
  it('без filename* — filename', () => {
    expect(filenameFromDisposition('inline; filename="a.pdf"')).toBe('a.pdf');
  });
  it('нет заголовка или битая кодировка без запасного имени — undefined', () => {
    expect(filenameFromDisposition(null)).toBeUndefined();
    expect(filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A`)).toBeUndefined();
  });
});
