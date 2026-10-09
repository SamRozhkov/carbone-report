import { describe, expect, it } from 'vitest';
import { createBuildFlights } from './build-flights';
import { Deadline } from './deadline';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createBuildFlights', () => {
  it('одновременные запросы того же ключа ждут одну сборку', async () => {
    const flights = createBuildFlights<string>();
    const d = deferred<string>();
    let starts = 0;
    const start = () => {
      starts++;
      return d.promise;
    };
    const a = flights('k', new Deadline(10_000), start);
    const b = flights('k', new Deadline(10_000), start);
    d.resolve('файл');
    await expect(a).resolves.toBe('файл');
    await expect(b).resolves.toBe('файл');
    expect(starts).toBe(1);
  });

  it('к сборке с истёкшим сроком не присоединяются: новый запрос начинает свою', async () => {
    let now = 0;
    const flights = createBuildFlights<string>();
    const old = deferred<string>();
    const fresh = deferred<string>();
    const first = flights('k', new Deadline(100, () => now), () => old.promise);
    first.catch(() => {});
    now = 150; // срок первого запроса истёк, а его сборка ещё не завершилась
    let started = false;
    const second = flights('k', new Deadline(100, () => now), () => {
      started = true;
      return fresh.promise;
    });
    expect(started).toBe(true);
    // Старая сборка завершается отказом позже — запись новой сборки остаётся.
    old.reject(new Error('lock_timeout'));
    await old.promise.catch(() => {});
    const third = flights('k', new Deadline(100, () => now), () => Promise.resolve('лишняя'));
    fresh.resolve('собран');
    await expect(second).resolves.toBe('собран');
    await expect(third).resolves.toBe('собран');
  });

  it('после завершения сборки следующий запрос начинает новую', async () => {
    const flights = createBuildFlights<string>();
    let starts = 0;
    const start = async () => `сборка ${++starts}`;
    await expect(flights('k', new Deadline(10_000), start)).resolves.toBe('сборка 1');
    await expect(flights('k', new Deadline(10_000), start)).resolves.toBe('сборка 2');
  });

  it('отказ сборки, которую никто не ждёт, не становится необработанным', async () => {
    let now = 0;
    const flights = createBuildFlights<string>();
    const d = deferred<string>();
    const p = flights('k', new Deadline(10, () => now), () => d.promise);
    now = 20;
    p.catch(() => {});
    d.reject(new Error('сбой'));
    await d.promise.catch(() => {});
  });
});
