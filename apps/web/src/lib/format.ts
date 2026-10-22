import type { OutputFormat, TemplateExt } from '@carbone-reports/shared';
import type { Locale } from '@carbone-reports/shared/i18n';
import { currentLocale, i18n } from '../i18n';

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

const tenthsFormats = new Map<Locale, Intl.NumberFormat>();
/** Секунды с одним знаком после запятой — разделитель по языку (ru — «12,3»). */
function formatTenths(value: number): string {
  const locale = currentLocale();
  let f = tenthsFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    tenthsFormats.set(locale, f);
  }
  return f.format(value);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return i18n.t('common:duration.ms', { value: ms });
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return i18n.t('common:duration.s', { value: formatTenths(tenths / 10) });
  const total = Math.round(ms / 1000);
  return i18n.t('common:duration.min', {
    min: Math.floor(total / 60),
    sec: String(total % 60).padStart(2, '0'),
  });
}

export const FORMAT_LABEL: Record<OutputFormat | TemplateExt, string> = {
  pdf: 'PDF',
  docx: 'Word (DOCX)',
  xlsx: 'Excel (XLSX)',
  odt: 'ODT',
  ods: 'ODS',
  pptx: 'PowerPoint (PPTX)',
};
