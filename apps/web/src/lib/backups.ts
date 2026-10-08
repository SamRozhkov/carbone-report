import type { BackupDto, BackupOperationDto, BackupPhase } from '@carbone-reports/shared';

export const PHASE_LABEL: Record<BackupPhase, string> = {
  backup: 'Создание бэкапа',
  verify: 'Проверка бэкапа',
  'pre-backup': 'Бэкап перед восстановлением',
  maintenance: 'Включение режима обслуживания',
  db: 'Замена базы данных',
  migrate: 'Применение миграций',
  storage: 'Восстановление файлов',
  redis: 'Очистка кэша',
  done: 'Готово',
};

export const STATUS_LABEL: Record<BackupOperationDto['status'], string> = {
  running: 'выполняется',
  succeeded: 'успешно',
  failed: 'ошибка',
};

export const KIND_LABEL: Record<BackupDto['kind'], string> = {
  regular: 'обычный',
  'pre-restore': 'перед восстановлением',
};

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1).replace('.', ',')} ${units[i]}`;
}

export function requestedByLabel(by: string): string {
  if (by === 'cron') return 'по расписанию';
  if (by === 'recovery-code') return 'по коду восстановления';
  return by;
}
