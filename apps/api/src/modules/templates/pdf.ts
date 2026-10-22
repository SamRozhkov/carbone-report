import { pdfStaticText, pdfTextBadTag, type PdfOptions } from '@carbone-reports/shared';
import { text } from '../../lib/errors';
import { unsupportedChars } from '../pdf/font';
import type { ChartIssue } from './charts';

/** Приложение не в формате PDF/A при включённом PDF/A. */
export const pdfaMessage = (name: string) => text('pdf.attachmentNotPdfa', { name });

function textIssue(path: string, value: string, tags: 'allowed' | 'none'): ChartIssue | null {
  if (tags === 'none') {
    if (value.includes('{d.')) return { path, message: text('pdf.numberingTags') };
  } else {
    const tag = pdfTextBadTag(value);
    if (tag) return { path, message: text('pdf.tagFormatter', { tag }) };
  }
  const bad = unsupportedChars(tags === 'none' ? value : pdfStaticText(value));
  if (bad.length) return { path, message: text('pdf.unsupportedChar', { char: bad[0]! }) };
  return null;
}

/** Проверки `PUT …/pdf-options` сверх схемы (§36.1, §36.2): теги и символы шрифта — у полей. */
export function pdfOptionIssues(o: PdfOptions): ChartIssue[] {
  const issues = [
    o.watermark && textIssue('/watermark/text', o.watermark.text, 'allowed'),
    o.pageNumbers?.format && textIssue('/pageNumbers/format', o.pageNumbers.format, 'none'),
    ...(['title', 'author', 'subject', 'keywords'] as const).map(
      (k) => o.metadata && textIssue(`/metadata/${k}`, o.metadata[k], 'allowed'),
    ),
  ];
  return issues.filter((i): i is ChartIssue => Boolean(i));
}
