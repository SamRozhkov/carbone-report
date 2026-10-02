import { describe, expect, it } from 'vitest';
import { contentDisposition } from './http';

describe('contentDisposition', () => {
  it('экранирует кавычки, обратные слеши и спецсимволы RFC 5987', () => {
    const h = contentDisposition('Отчёт "Q1" \\ (итог)*.pdf');
    const ascii = /filename="([^"]*)"/.exec(h)![1]!;
    expect(h).toMatch(/filename="[^"]*";/);
    expect(ascii).not.toContain('\\');
    expect(h).toContain('%28');
    expect(h).toContain('%29');
    expect(h).toContain('%2A');
  });
  it('не пропускает CRLF', () => {
    const h = contentDisposition('a\r\nX-Evil: 1.pdf');
    expect(h).not.toMatch(/[\r\n]/);
  });
});
