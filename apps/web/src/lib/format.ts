import type { OutputFormat, TemplateExt } from '@carbone-reports/shared';
import type { Locale } from '@carbone-reports/shared/i18n';
import { currentLocale } from '../i18n';

const formatters = new Map<Locale, { dateTime: Intl.DateTimeFormat; date: Intl.DateTimeFormat }>();
/** Форматы дат текущего языка (§44.3); создаются один раз на язык. */
function formattersOf(locale: Locale) {
  let f = formatters.get(locale);
  if (!f) {
    f = {
      dateTime: new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      date: new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }),
    };
    formatters.set(locale, f);
  }
  return f;
}

/** ru — «31.01.2026 09:05» без запятой, как раньше; остальные языки — формат Intl как есть. */
export function formatDateTime(iso: string): string {
  const locale = currentLocale();
  const s = formattersOf(locale).dateTime.format(new Date(iso));
  return locale === 'ru' ? s.replace(',', '') : s;
}
export const formatDate = (iso: string) => formattersOf(currentLocale()).date.format(new Date(iso));

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1).replace('.', ',')} с`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} мин ${String(total % 60).padStart(2, '0')} с`;
}

export const FORMAT_LABEL: Record<OutputFormat | TemplateExt, string> = {
  pdf: 'PDF',
  docx: 'Word (DOCX)',
  xlsx: 'Excel (XLSX)',
  odt: 'ODT',
  ods: 'ODS',
  pptx: 'PowerPoint (PPTX)',
};
