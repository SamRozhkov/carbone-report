import { AppError } from './errors';

export const reportTimeout = () =>
  new AppError('TIMEOUT', 504, 'превышено время формирования отчёта');

/** Общий срок операции (формирование отчёта): отсчёт от создания, таймауты шагов — не дольше остатка. */
export class Deadline {
  private readonly end: number;

  constructor(
    ms: number,
    private readonly now: () => number = Date.now,
  ) {
    this.end = now() + ms;
  }

  /** Сколько мс осталось, не меньше 0. */
  remaining(): number {
    return Math.max(0, this.end - this.now());
  }

  /** Таймаут шага, ограниченный остатком срока; не меньше 1 (0 у pg значит «без ограничения»). */
  cap(ms: number): number {
    return Math.max(1, Math.min(ms, this.remaining()));
  }

  /** TIMEOUT 504, если срок истёк. */
  check(): void {
    if (this.remaining() <= 0) throw reportTimeout();
  }

  /** Результат `p` или TIMEOUT 504, если срок истёк раньше. Таймер снимается, когда `p` завершился. */
  race<T>(p: Promise<T>): Promise<T> {
    const left = this.remaining();
    if (left <= 0) {
      p.catch(() => {});
      return Promise.reject(reportTimeout());
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(reportTimeout()), left);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
