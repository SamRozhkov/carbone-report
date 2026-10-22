import { i18n } from '../i18n';
import { formatTenths } from './format';

const SIZE_UNITS = ['kb', 'mb', 'gb', 'tb'] as const;

/** Размер в двоичных единицах с одним знаком после запятой; подписи единиц — из каталога. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return i18n.t('common:size.b', { value: bytes });
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < SIZE_UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  return i18n.t(`common:size.${SIZE_UNITS[i]!}`, { value: formatTenths(value) });
}

export function requestedByLabel(by: string): string {
  if (by === 'cron') return i18n.t('admin:backups.byCron');
  if (by === 'recovery-code') return i18n.t('admin:backups.byRecoveryCode');
  return by;
}
