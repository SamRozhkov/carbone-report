import { describe, expect, it, vi } from 'vitest';
import { drainAndClose } from './drain';

const mk = (idle: () => Promise<void>, timeoutMs = 100, active = () => 1) => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const close = vi.fn(async () => {});
  const run = () => drainAndClose({ idle, active, timeoutMs, close, log });
  return { log, close, run };
};

describe('drainAndClose', () => {
  it('активных нет — close сразу, результат idle', async () => {
    const { close, run, log } = mk(
      async () => {},
      100,
      () => 0,
    );
    expect(await run()).toBe('idle');
    expect(close).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('отчёт завершается через 50 мс — close после него', async () => {
    let done = false;
    const { close, run } = mk(() => new Promise((r) => setTimeout(() => ((done = true), r()), 50)));
    close.mockImplementation(async () => {
      expect(done).toBe(true);
    });
    expect(await run()).toBe('idle');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('отчёт не завершается — close по сроку, timeout и warn', async () => {
    const { close, run, log } = mk(() => new Promise(() => {}), 100);
    const t0 = Date.now();
    expect(await run()).toBe('timeout');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect(close).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });
});
