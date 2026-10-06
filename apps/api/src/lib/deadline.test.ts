import { afterEach, describe, expect, it, vi } from 'vitest';
import { Deadline } from './deadline';
import { AppError } from './errors';

const MSG = 'превышено время формирования отчёта';

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Deadline', () => {
  it('remaining уменьшается со временем и не уходит ниже нуля', () => {
    const c = clock();
    const d = new Deadline(1000, c.now);
    expect(d.remaining()).toBe(1000);
    c.advance(300);
    expect(d.remaining()).toBe(700);
    c.advance(5000);
    expect(d.remaining()).toBe(0);
  });

  it('cap: минимум из таймаута и остатка, но не меньше 1', () => {
    const c = clock();
    const d = new Deadline(1000, c.now);
    expect(d.cap(30000)).toBe(1000);
    expect(d.cap(200)).toBe(200);
    c.advance(900);
    expect(d.cap(30000)).toBe(100);
    c.advance(500);
    expect(d.cap(30000)).toBe(1);
  });

  it('check: до срока молчит, после — TIMEOUT 504', () => {
    const c = clock();
    const d = new Deadline(1000, c.now);
    expect(() => d.check()).not.toThrow();
    c.advance(1000);
    let err: unknown;
    try {
      d.check();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'TIMEOUT', status: 504, message: MSG });
  });

  it('race: долгий промис → TIMEOUT по истечении срока', async () => {
    vi.useFakeTimers();
    const d = new Deadline(1000);
    const slow = new Promise<string>((r) => setTimeout(() => r('поздно'), 5000));
    const p = d.race(slow);
    const check = expect(p).rejects.toMatchObject({ code: 'TIMEOUT', status: 504, message: MSG });
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    await vi.advanceTimersByTimeAsync(5000);
  });

  it('race: быстрый промис проходит, таймер снимается', async () => {
    vi.useFakeTimers();
    const d = new Deadline(1000);
    await expect(d.race(Promise.resolve(42))).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
    await expect(d.race(Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('race: срок уже истёк → TIMEOUT сразу', async () => {
    const c = clock();
    const d = new Deadline(1000, c.now);
    c.advance(2000);
    await expect(d.race(new Promise(() => {}))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
