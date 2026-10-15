import { pdfStaticText, pdfTextIssues, type PdfOptions } from '@carbone-reports/shared';
import { unsupportedChars } from '../pdf/font';
import type { ChartIssue } from './charts';

export const pdfaMessage = (name: string) => `PDF/A включён: файл «${name}» не в формате PDF/A`;

function textIssue(path: string, text: string, tags: 'allowed' | 'none'): ChartIssue | null {
  if (tags === 'none') {
    if (text.includes('{d.')) return { path, message: 'в нумерации теги {d.…} не поддерживаются' };
  } else {
    const tagIssue = pdfTextIssues(text);
    if (tagIssue) return { path, message: tagIssue };
  }
  const bad = unsupportedChars(tags === 'none' ? text : pdfStaticText(text));
  if (bad.length) return { path, message: `символ «${bad[0]}» не поддерживается шрифтом PDF` };
  return null;
}

/** Проверки `PUT …/pdf-options` сверх схемы (§36.1, §36.2): теги и символы шрифта — у полей. */
export function pdfOptionIssues(o: PdfOptions): ChartIssue[] {
  const issues = [
    o.watermark && textIssue('/watermark/text', o.watermark.text, 'allowed'),
    o.pageNumbers && textIssue('/pageNumbers/format', o.pageNumbers.format, 'none'),
    ...(['title', 'author', 'subject', 'keywords'] as const).map(
      (k) => o.metadata && textIssue(`/metadata/${k}`, o.metadata[k], 'allowed'),
    ),
  ];
  return issues.filter((i): i is ChartIssue => Boolean(i));
}
