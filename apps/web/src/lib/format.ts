import type { OutputFormat, TemplateExt } from '@carbone-reports/shared';

const dtf = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const df = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const formatDateTime = (iso: string) => dtf.format(new Date(iso)).replace(',', '');
export const formatDate = (iso: string) => df.format(new Date(iso));

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} с`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min} мин ${String(sec).padStart(2, '0')} с`;
}

export const FORMAT_LABEL: Record<OutputFormat | TemplateExt, string> = {
  pdf: 'PDF',
  docx: 'Word (DOCX)',
  xlsx: 'Excel (XLSX)',
  odt: 'ODT',
  ods: 'ODS',
  pptx: 'PowerPoint (PPTX)',
};
