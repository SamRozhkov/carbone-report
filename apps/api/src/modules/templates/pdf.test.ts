import { PdfOptions } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { ruDetails } from '../../lib/errors';
import { pdfaMessage, pdfOptionIssues } from './pdf';

describe('pdfOptionIssues', () => {
  it('без замечаний', () => {
    const o = PdfOptions.parse({
      watermark: { text: 'Копия {d.number}' },
      pageNumbers: {},
      metadata: { title: 'Счёт № {d.number}' },
    });
    expect(ruDetails(pdfOptionIssues(o))).toEqual([]);
  });

  it('символы вне шрифта, форматтеры, теги в нумерации — у полей', () => {
    const o = PdfOptions.parse({
      watermark: { text: 'Копия 😀 {d.x}' },
      pageNumbers: { format: '{page} {d.x}' },
      metadata: { title: '{d.sum:formatC}', author: '中 🙂', subject: '', keywords: '' },
    });
    expect(ruDetails(pdfOptionIssues(o))).toEqual([
      { path: '/watermark/text', message: 'символ «😀» не поддерживается шрифтом PDF' },
      { path: '/pageNumbers/format', message: 'в нумерации теги {d.…} не поддерживаются' },
      { path: '/metadata/title', message: 'в полях PDF теги без форматтеров: {d.sum:formatC}' },
      { path: '/metadata/author', message: 'символ «🙂» не поддерживается шрифтом PDF' },
    ]);
  });

  it('иероглифы — есть в Noto Sans SC (§45.5): водяной знак и формат нумерации на китайском', () => {
    const o = PdfOptions.parse({
      watermark: { text: '机密 {d.number}' },
      pageNumbers: { format: '第{page}页，共{pages}页' },
      metadata: { title: '报告 № {d.number}', author: '李伟' },
    });
    expect(ruDetails(pdfOptionIssues(o))).toEqual([]);
  });

  it('символ вне обоих шрифтов — прежняя ошибка, в том числе рядом с иероглифами', () => {
    const o = PdfOptions.parse({
      watermark: { text: '机密 😀' },
      pageNumbers: { format: '第{page}页 😀' },
    });
    expect(ruDetails(pdfOptionIssues(o))).toEqual([
      { path: '/watermark/text', message: 'символ «😀» не поддерживается шрифтом PDF' },
      { path: '/pageNumbers/format', message: 'символ «😀» не поддерживается шрифтом PDF' },
    ]);
  });

  it('pdfaMessage', () => {
    expect(ruDetails(pdfaMessage('скан.pdf'))).toBe(
      'PDF/A включён: файл «скан.pdf» не в формате PDF/A',
    );
  });
});
