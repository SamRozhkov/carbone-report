import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCron, CRON_FIELDS_ERROR, scheduleCron } from './cron';

describe('checkCron', () => {
  it.each(['0 3 * * *', '*/15 2-4 * * 1-5', '0 0 1 1 *'])('принимает %j', (expr) => {
    expect(checkCron(expr, 'Europe/Moscow')).toBe(expr);
  });
  it('лишние пробелы и табуляции между полями допустимы', () => {
    expect(checkCron(' 0\t3  * * * ', 'UTC')).toBe('0 3 * * *');
  });
  it.each(['', '0 3 * *', '0 3 * * * *', '@daily', '0 3 * * *\n', '0 3\n* * *'])(
    'не 5 полей или перевод строки: %j',
    (expr) => {
      expect(() => checkCron(expr, 'UTC')).toThrow(CRON_FIELDS_ERROR);
    },
  );
  it('неверное значение поля', () => {
    expect(() => checkCron('61 * * * *', 'UTC')).toThrow(
      'BACKUP_CRON: неверное выражение «61 * * * *» или часовой пояс TZ=UTC',
    );
  });
  it('неизвестный часовой пояс', () => {
    expect(() => checkCron('0 3 * * *', 'Mars/Base')).toThrow(/TZ=Mars\/Base/);
  });
});

describe('scheduleCron', () => {
  afterEach(() => vi.useRealTimers());
  it('вызывает функцию в момент по расписанию и после stop больше не вызывает', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T02:59:58Z') });
    const fn = vi.fn();
    const stop = scheduleCron('0 3 * * *', 'UTC', fn);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
