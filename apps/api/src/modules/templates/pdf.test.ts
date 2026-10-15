import { PdfOptions } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { pdfaMessage, pdfOptionIssues } from './pdf';

describe('pdfOptionIssues', () => {
  it('без замечаний', () => {
    const o = PdfOptions.parse({
      watermark: { text: 'Копия {d.number}' },
      pageNumbers: {},
      metadata: { title: 'Счёт № {d.number}' },
    });
    expect(pdfOptionIssues(o)).toEqual([]);
  });

  it('символы вне шрифта, форматтеры, теги в нумерации — у полей', () => {
    const o = PdfOptions.parse({
      watermark: { text: 'Копия 😀 {d.x}' },
      pageNumbers: { format: '{page} {d.x}' },
      metadata: { title: '{d.sum:formatC}', author: '中', subject: '', keywords: '' },
    });
    expect(pdfOptionIssues(o)).toEqual([
      { path: '/watermark/text', message: 'символ «😀» не поддерживается шрифтом PDF' },
      { path: '/pageNumbers/format', message: 'в нумерации теги {d.…} не поддерживаются' },
      { path: '/metadata/title', message: 'в полях PDF теги без форматтеров: {d.sum:formatC}' },
      { path: '/metadata/author', message: 'символ «中» не поддерживается шрифтом PDF' },
    ]);
  });

  it('pdfaMessage', () => {
    expect(pdfaMessage('скан.pdf')).toBe('PDF/A включён: файл «скан.pdf» не в формате PDF/A');
  });
});
