import { Cron } from 'croner';

/** То же сообщение, что у прежнего режима cron в entrypoint.sh (README, §20.4). */
export const CRON_FIELDS_ERROR = 'BACKUP_CRON: ожидается 5 полей cron';

/**
 * Ровно 5 полей через пробелы или табуляции, без перевода строки (как `set -- $BACKUP_CRON`
 * в прежнем entrypoint.sh). Значения полей и часовой пояс проверяет croner. Возвращает
 * выражение с одиночными пробелами.
 */
export function checkCron(expr: string, tz: string): string {
  if (/[\r\n]/.test(expr)) throw new Error(CRON_FIELDS_ERROR);
  const fields = expr.split(/[ \t]+/).filter(Boolean);
  if (fields.length !== 5) throw new Error(CRON_FIELDS_ERROR);
  const normalized = fields.join(' ');
  try {
    const job = new Cron(normalized, { timezone: tz, paused: true, mode: '5-part' });
    job.nextRun();
    job.stop();
  } catch {
    throw new Error(`BACKUP_CRON: неверное выражение «${normalized}» или часовой пояс TZ=${tz}`);
  }
  return normalized;
}

/** Запуск fn по расписанию в часовом поясе tz; protect — не накладывать запуски друг на друга. */
export function scheduleCron(expr: string, tz: string, fn: () => void): () => void {
  const job = new Cron(expr, { timezone: tz, mode: '5-part', protect: true }, () => fn());
  return () => job.stop();
}
